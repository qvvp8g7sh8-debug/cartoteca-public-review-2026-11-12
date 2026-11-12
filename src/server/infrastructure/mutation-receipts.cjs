const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { fail } = require('../../shared/errors.cjs');
const { outcomeKey, readOutcome, writeOutcome } = require('./mutation-outcomes.cjs');

const INDEX = 'mutation-operation-index';
const MAX_BYTES = 8 * 1024 * 1024,
  MAX_RECEIPT = 1024 * 1024,
  MAX_COUNT = 128;
function operationId(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(value))
    throw fail(400, 'Неверный номер операции.');
  return value;
}
function receiptKey(current, id) {
  return (
    'mutation-operation:' +
    createHash('sha256')
      .update(JSON.stringify([current.organizationId, current.accountId, current.role, id]))
      .digest('hex')
  );
}
function mutationIdentity(context, body, partial) {
  const id = operationId(context.req?.headers?.['x-cartoteca-operation']);
  if (!id) return null;
  return {
    id,
    hash: createHash('sha256')
      .update(
        JSON.stringify([partial, context.req?.headers?.['x-cartoteca-schedule-ack'] || '', body]),
      )
      .digest('hex'),
  };
}
// The receipt and clinical write share the existing cabinet transaction. No new
// schema is needed: meta values are already encrypted and backed up atomically.
function readReceipt(storage, current, id, expectedHash, { appointmentOnly = false } = {}) {
  const key = receiptKey(current, operationId(id)),
    outcome = readOutcome(storage, key, expectedHash),
    receipt = storage.get(key);
  if (!receipt || receipt.expires <= Date.now()) {
    // A compact proof still fences retries after a later write, replay eviction
    // or an oversized response. It cannot replay stale clinical information.
    if (outcome && expectedHash)
      throw fail(409, 'Изменение уже сохранено. Загрузите актуальные сведения.');
    return null;
  }
  if (expectedHash && receipt.hash !== expectedHash)
    throw fail(409, 'Номер операции уже использован для другого изменения.');
  if (receipt.saved.appointmentOnly === true) {
    // This compact receipt omits visit history. A later cabinet revision must
    // reconcile against fresh data, never replay an incomplete clinical snapshot.
    if (storage.get('revision', 0) !== receipt.saved.revision)
      throw fail(
        409,
        'Изменение сохранено, но данные уже обновлены. Загрузите актуальные сведения.',
      );
    if (appointmentOnly) return receipt;
    const full = storage.readSelected(
      receipt.recipe.patients.map((p) => p.id),
      [],
    );
    const { appointmentOnly: omitted, ...saved } = receipt.saved;
    return { ...receipt, saved: { ...saved, patients: full.patients } };
  }
  const now = receipt.partial
    ? storage.readSelected(
        receipt.recipe.patients.map((p) => p.id),
        receipt.recipe.services.map((s) => s.id),
      )
    : storage.read();
  // Never replay stale clinical data after another writer, deletion or loss of
  // visibility. The existing reconciliation UI handles this real conflict.
  if (
    !isDeepStrictEqual(now.patients, receipt.saved.patients) ||
    !isDeepStrictEqual(now.services, receipt.saved.services)
  )
    throw fail(409, 'Изменение сохранено, но данные уже обновлены. Загрузите актуальные сведения.');
  return receipt;
}
function readOperationStatus(storage, current, id) {
  const key = receiptKey(current, operationId(id)),
    outcome = readOutcome(storage, key);
  if (outcome)
    return {
      status: 'committed',
      revision: outcome.revision,
      committedAt: outcome.committedAt,
    };
  return legacyOperationStatus(storage, key);
}
function legacyOperationStatus(storage, key) {
  // Compatibility with receipts committed before compact proofs were added.
  // This reads encrypted metadata only, never patient records or an entire cabinet.
  const receipt = storage.get(key);
  return receipt && receipt.expires > Date.now()
    ? { status: 'committed', revision: receipt.saved.revision }
    : { status: 'unknown' };
}
async function readOperationStatusAsync(storage, current, id) {
  const key = receiptKey(current, operationId(id));
  await storage.prefetchMeta([outcomeKey(key)]);
  const outcome = readOutcome(storage, key);
  if (outcome)
    return {
      status: 'committed',
      revision: outcome.revision,
      committedAt: outcome.committedAt,
    };
  // A live compact proof never fetches or decodes its clinical replay copy.
  // Missing/expired metadata remains unknown; no write is retried here.
  await storage.prefetchMeta([key]);
  return legacyOperationStatus(storage, key);
}
function writeReceipt(storage, current, identity, saved, body, partial) {
  const now = Date.now(),
    key = identity ? receiptKey(current, identity.id) : null;
  const changed = partial
    ? {
        patients: new Set(body.patients.map((c) => c.id)),
        services: new Set(body.services.map((c) => c.id)),
      }
    : null;
  const index = storage.get(INDEX, []),
    live = [];
  // Retire superseded receipts, including on legacy writes without an ID. A
  // deleted client must not survive as a clinical copy in the receipt cache.
  for (const item of index) {
    const superseded =
      !partial ||
      ['patients', 'services'].some((collection) =>
        (item[collection] || []).some((id) => changed[collection].has(id)),
      );
    if (item.expires <= now || superseded)
      storage.db.prepare('DELETE FROM meta WHERE key=?').run(item.key);
    else live.push(item);
  }
  if (!identity) {
    if (index.length !== live.length) storage.set(INDEX, live);
    return;
  }
  writeOutcome(storage, key, identity, saved);
  const recipe = partial
    ? Object.fromEntries(
        ['patients', 'services'].map((collection) => [
          collection,
          body[collection].map((change) => ({
            id: change.id,
            after: change.after === null ? null : {},
          })),
        ]),
      )
    : null;
  const receipt = { hash: identity.hash, expires: now + 86400000, partial, recipe, saved };
  const bytes = Buffer.byteLength(JSON.stringify(receipt));
  // Very large imports use the established conditional-write recovery instead
  // of keeping a second large history in a receipt. Eviction never bypasses 409.
  if (bytes > MAX_RECEIPT) {
    storage.set(INDEX, live);
    return;
  }
  const retained = [];
  let total = bytes;
  for (let i = live.length - 1; i >= 0; i--) {
    const item = live[i];
    if (
      item.key !== key &&
      item.expires > now &&
      retained.length < MAX_COUNT - 1 &&
      total + item.bytes <= MAX_BYTES
    ) {
      retained.unshift(item);
      total += item.bytes;
    } else storage.db.prepare('DELETE FROM meta WHERE key=?').run(item.key);
  }
  storage.set(key, receipt);
  retained.push({
    key,
    expires: receipt.expires,
    bytes,
    patients: partial ? body.patients.map((c) => c.id) : saved.patients.map((p) => p.id),
    services: partial ? body.services.map((c) => c.id) : saved.services.map((s) => s.id),
  });
  storage.set(INDEX, retained);
}
module.exports = {
  operationId,
  mutationIdentity,
  readReceipt,
  readOperationStatus,
  readOperationStatusAsync,
  writeReceipt,
};
