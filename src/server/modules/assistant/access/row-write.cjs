const { randomUUID } = require('node:crypto');
const { initialState, validateState } = require('./defaults.cjs');
const { settingsValue, historyValue, validDate } = require('./row-state.cjs');
const { encode } = require('./row-codec.cjs');
const { rubToMicrorub, addMoney, safeInteger } = require('../../billing/money.cjs');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function requireTransaction(db) {
  if (!db.isTransaction) throw Error('Assistant row write requires caller-owned transaction');
}
function writeSettings(context, registration, state) {
  const value = encode(context, registration, 'assistant_settings', [1], settingsValue(state));
  context.db
    .prepare(
      `INSERT INTO assistant_settings VALUES(1,?,?,?,?) ON CONFLICT(id)
    DO UPDATE SET revision=excluded.revision,mode=excluded.mode,changed_at=excluded.changed_at,value=excluded.value`,
    )
    .run(state.revision, state.policy.mode, Date.now(), value);
}
function writeHistory(context, registration, state) {
  context.db
    .prepare(
      `INSERT INTO assistant_admin_history VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value`,
    )
    .run(encode(context, registration, 'assistant_admin_history', [1], historyValue(state)));
}
function writeGrant(context, registration, grant, position, enabled = true) {
  const previous = context.db
    .prepare('SELECT grant_version FROM assistant_grants WHERE organization_id=? AND account_id=?')
    .get(grant.organizationId, grant.accountId);
  const version = safeInteger(BigInt(previous?.grant_version || 0) + 1n);
  context.db
    .prepare(
      `INSERT INTO assistant_grants VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(organization_id,account_id) DO UPDATE SET membership_id=excluded.membership_id,
    enabled=excluded.enabled,grant_version=excluded.grant_version,
    position=excluded.position,value=excluded.value`,
    )
    .run(
      grant.organizationId,
      grant.accountId,
      grant.membershipId,
      enabled ? 1 : 0,
      version,
      position,
      encode(context, registration, 'assistant_grants', [grant.organizationId, grant.accountId], {
        grant,
        enabled,
        version,
      }),
    );
}
function writeOperation(context, registration, operation, position) {
  if (
    !operation ||
    typeof operation.actorId !== 'string' ||
    typeof operation.requestId !== 'string' ||
    typeof operation.kind !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(operation.fingerprint) ||
    !Number.isSafeInteger(operation.revision) ||
    operation.revision < 0
  )
    throw Error('Invalid assistant administrative operation');
  context.db
    .prepare(
      `INSERT INTO assistant_admin_operations VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(actor_id,request_id) DO UPDATE SET kind=excluded.kind,fingerprint=excluded.fingerprint,
    revision=excluded.revision,position=excluded.position,value=excluded.value`,
    )
    .run(
      operation.actorId,
      operation.requestId,
      operation.kind,
      operation.fingerprint,
      operation.revision,
      position,
      encode(
        context,
        registration,
        'assistant_admin_operations',
        [operation.actorId, operation.requestId],
        operation,
      ),
    );
}
function importRows(
  context,
  source,
  { storeId = randomUUID(), sourceHash, now = Date.now() } = {},
) {
  const { db } = context;
  requireTransaction(db);
  if (db.prepare('SELECT 1 FROM assistant_state_schema LIMIT 1').get())
    throw Error('Assistant rows already imported');
  const state = validateState(structuredClone(source));
  if (Object.keys(state).some((name) => !Object.hasOwn(initialState(), name)))
    throw Error('Unsupported assistant legacy state field');
  for (const [name, items, key] of [
    ['grant', state.grants, (entry) => [entry.organizationId, entry.accountId]],
    ['operation', state.operations, (entry) => [entry.actorId, entry.requestId]],
  ]) {
    const seen = new Set();
    for (const entry of items) {
      const identity = JSON.stringify(key(entry));
      if (seen.has(identity)) throw Error('Ambiguous duplicate assistant legacy ' + name);
      seen.add(identity);
    }
  }
  if (!/^[a-f0-9]{64}$/.test(sourceHash || '')) throw Error('Invalid assistant import hash');
  const registration = { store_id: storeId, import_sha256: sourceHash };
  const rounding = { unit: 'microrub', mode: 'upward', roundedUpValues: 0, adjustmentRub: 0 };
  const convert = (value) => {
    const amount = rubToMicrorub(value),
      adjustment = amount / 1000000 - value;
    if (adjustment > 0) {
      rounding.roundedUpValues++;
      rounding.adjustmentRub += adjustment;
    }
    return amount;
  };
  writeSettings(context, registration, state);
  writeHistory(context, registration, state);
  state.grants.forEach((grant, position) => writeGrant(context, registration, grant, position));
  const months = new Map(
    Object.entries(state.usage).map(([month, usage]) => [
      validDate(month, true),
      {
        spent: convert(usage.spentRub),
        reserved: 0,
        calls: usage.calls,
        uncertain: usage.uncertainCalls,
        original: usage,
      },
    ]),
  );
  for (const [id, pending] of Object.entries(state.reservations)) {
    validDate(pending.month, true);
    if (!id || id.length > 120) throw Error('Invalid assistant reservation identifier');
    const amount = convert(pending.amount);
    const month = months.get(pending.month) || { spent: 0, reserved: 0, calls: 0, uncertain: 0 };
    month.reserved = addMoney(month.reserved, amount);
    months.set(pending.month, month);
    db.prepare(
      `INSERT INTO assistant_reservations VALUES(?,'legacy',NULL,NULL,NULL,NULL,NULL,
      ?,'legacy',?,?,'legacy-unknown',?,?,?)`,
    ).run(
      id,
      pending.kind,
      pending.month,
      amount,
      pending.createdAt,
      safeInteger(BigInt(pending.createdAt) + 120000n),
      encode(context, registration, 'assistant_reservations', [id], {
        reservation: pending,
        imported: true,
      }),
    );
  }
  for (const [month, value] of months)
    db.prepare('INSERT INTO assistant_usage_months VALUES(?,?,?,?,?,?)').run(
      month,
      value.spent,
      value.reserved,
      value.calls,
      value.uncertain,
      encode(context, registration, 'assistant_usage_months', [month], {
        original: value.original || null,
      }),
    );
  for (const [key, requests] of Object.entries(state.daily)) {
    const day = validDate(key.slice(0, 10)),
      member = key.slice(11);
    if (key[10] !== ':' || !/^[A-Za-z0-9_-]{43}$/.test(member))
      throw Error('Invalid assistant day identity');
    db.prepare('INSERT INTO assistant_usage_days VALUES(?,?,?)').run(day, member, requests);
  }
  state.operations.forEach((operation, position) =>
    writeOperation(context, registration, operation, position),
  );
  db.prepare(`INSERT INTO assistant_state_schema VALUES(1,1,'rows-v1','memory',?,?,?,?)`).run(
    storeId,
    sourceHash,
    state.revision,
    now,
  );
  return {
    componentVersion: 1,
    storeId,
    importedRevision: state.revision,
    grants: state.grants.length,
    reservations: Object.keys(state.reservations).length,
    orphanReservations: Object.keys(state.reservations).length,
    months: months.size,
    rounding,
  };
}
function updateAdmin(context, registration, reader, callback) {
  requireTransaction(context.db);
  const state = reader.adminSnapshot(),
    before = structuredClone(state);
  const result = callback(state);
  if (result && typeof result.then === 'function')
    throw Error('Async assistant admin callback denied');
  validateState(state);
  if (
    !equal(
      [before.usage, before.daily, before.reservations],
      [state.usage, state.daily, state.reservations],
    )
  )
    throw Error('Administration cannot rewrite assistant accounting');
  if (!equal(settingsValue(before), settingsValue(state)))
    writeSettings(context, registration, state);
  if (!equal(historyValue(before), historyValue(state))) writeHistory(context, registration, state);
  const grantKey = (grant) => JSON.stringify([grant.organizationId, grant.accountId]);
  const oldGrants = new Map(
    before.grants.map((grant, position) => [grantKey(grant), { grant, position }]),
  );
  for (const [position, grant] of state.grants.entries()) {
    const old = oldGrants.get(grantKey(grant));
    if (!old || old.position !== position || !equal(old.grant, grant))
      writeGrant(context, registration, grant, position);
    oldGrants.delete(grantKey(grant));
  }
  for (const { grant, position } of oldGrants.values())
    writeGrant(context, registration, grant, position, false);
  const opKey = (op) => JSON.stringify([op.actorId, op.requestId]);
  const oldOps = new Map(before.operations.map((op, position) => [opKey(op), { op, position }]));
  for (const [position, operation] of state.operations.entries()) {
    const old = oldOps.get(opKey(operation));
    if (!old || old.position !== position || !equal(old.op, operation))
      writeOperation(context, registration, operation, position);
    oldOps.delete(opKey(operation));
  }
  for (const { op } of oldOps.values())
    context.db
      .prepare('DELETE FROM assistant_admin_operations WHERE actor_id=? AND request_id=?')
      .run(op.actorId, op.requestId);
  return result;
}
module.exports = {
  importRows,
  updateAdmin,
  writeSettings,
  writeHistory,
  writeGrant,
  requireTransaction,
};
