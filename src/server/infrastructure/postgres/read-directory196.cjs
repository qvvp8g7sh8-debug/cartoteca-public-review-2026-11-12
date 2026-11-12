const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { compact, projectionKey, READY_KEY } = require('../cabinet-directory-projection164.cjs');
const { directorySelectedSources196 } = require('./directory-read-state196.cjs');
const {
  directorySnapshotKey180,
  directorySnapshotClaim180,
  snapshotRequest180,
} = require('./directory-snapshot-key180.cjs');
const { renderDirectorySnapshotProven196 } = require('./directory-snapshot-index180.cjs');
const { parameters } = require('../../modules/cabinet/directory.cjs');
const bad = () =>
  Object.assign(Error('Prepared directory delta is invalid.'), {
    status: 503,
    code: 'CABINET_DIRECTORY_INDEX',
  });
function decode196(prepared, value) {
  try {
    return prepared.decode(value);
  } catch {
    throw bad();
  }
}
function rows196(rows, prepared, audience, ids) {
  const full = new Map(),
    meta = new Map(),
    wanted = new Set(ids);
  for (const row of rows) {
    const target = row.kind === 'summary' ? full : row.kind === 'meta' ? meta : null;
    if (
      !target ||
      target.has(row.id) ||
      !Buffer.isBuffer(row.value) ||
      (target === full && !wanted.has(row.id))
    )
      throw bad();
    target.set(row.id, row.value);
  }
  if (!meta.has(READY_KEY) || !meta.has('revision')) return null;
  const ready = decode196(prepared, meta.get(READY_KEY)),
    revision = decode196(prepared, meta.get('revision'));
  if (
    !ready ||
    ready.version !== 1 ||
    Object.keys(ready).length !== 1 ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  )
    throw bad();
  const changes = [];
  for (const id of ids) {
    if (!full.has(id)) {
      changes.push({ id, summary: null });
      continue;
    }
    const value = full.get(id),
      projected = meta.get(projectionKey(id, audience));
    if (!projected) return null; // Legacy raw-source path owns missing sidecars.
    const projection = decode196(prepared, projected),
      fullHash = prepared.hash(value);
    if (
      !projection ||
      projection.version !== 1 ||
      projection.id !== id ||
      projection.audience !== audience ||
      projection.sourceHash !== fullHash
    )
      throw bad();
    const summary = decode196(prepared, value);
    if (
      !summary ||
      typeof summary !== 'object' ||
      Array.isArray(summary) ||
      summary.id !== id ||
      !isDeepStrictEqual(projection.row, compact(summary))
    )
      throw bad();
    changes.push({ id, summary, fullHash });
  }
  return { revision, changes };
}
async function readDirectory196({ operation, prepared, current, url, context, cache, audience }) {
  if (
    !operation.directory196 ||
    !cache?.state196 ||
    !prepared.keyGeneration196 ||
    !snapshotRequest180(url)
  )
    return null;
  const key = directorySnapshotKey180({
    epoch: operation.epoch,
    storeId: operation.scope.storeId,
    current,
  });
  if (!cache.has(key)) return null;
  const claim = directorySnapshotClaim180({
    epoch: operation.epoch,
    platformStoreId: operation.platform.storeId,
    token: context.token,
    headers: context.req.headers,
    url,
  });
  if (!claim) return null;
  // Only metadata precedes admission. First opening stays on the complete cold
  // producer; there is no background prewarming or uncharged index creation.
  const head = await operation.directoryHead196();
  if (!head) return null;
  await operation.probe([
    {
      scope: operation.platform,
      catalog: operation.platformCatalog,
      table: 'organizations',
      where: 's.id=$2',
      values: [current.organizationId],
    },
  ]);
  await prepared.platform.prefetchProjectionAsync(current.organizationId, url.pathname);
  const timeZone = prepared.platform.organizationTimeZone(current.organizationId);
  parameters(url, timeZone);
  const keyGeneration = prepared.keyGeneration196,
    state = cache.state196(key, { keyGeneration, timeZone });
  if (!state) return null;
  const feed = await operation.directoryChanges196(state, audience);
  if (!feed) return null;
  const resolved = cache.resolve196(key, state, feed.identities, {
    keyGeneration,
  });
  if (!resolved || resolved.length !== feed.identities.length) return null;
  const ids = [];
  for (let i = 0; i < resolved.length; i++) {
    const item = feed.identities[i],
      known = resolved[i];
    if (item.identityDigest !== known.identityDigest) throw bad();
    const id = item.patientId || known.id;
    if (!id) return null;
    if (
      createHash('sha256').update(id).digest('hex') !== item.identityDigest ||
      (known.id && known.id !== id) ||
      ids.includes(id)
    )
      throw bad();
    ids.push(id);
  }
  await operation.probe(directorySelectedSources196(operation, audience, ids), {
    witness: true,
    captureScopes163: true,
  });
  await operation.requireDirectorySnapshotMemory180();
  const changed = rows196(
    await operation.selectDirectoryRows196(audience, ids),
    prepared,
    audience,
    ids,
  );
  if (!changed) return null;
  const options = {
    head: feed.head,
    keyGeneration,
    timeZone,
    revision: changed.revision,
  };
  const input = {
    current,
    audience,
    url,
    cursorCrypto: prepared,
    revision: changed.revision,
  };
  const selected = cache.previewChanges196(key, state, changed.changes, options, input);
  if (!selected) return null;
  // No index or retained decoded graph crosses this await, only detached IDs,
  // proofs and this operation's freshly decoded changed rows (<=32).
  const selectedIds = selected.map((row) => row.id);
  await operation.probe(directorySelectedSources196(operation, audience, selectedIds), {
    witness: true,
  });
  const selectedRows = await operation.selectDirectoryRows196(audience, selectedIds);
  const proofs = new Map(selected.map((row) => [row.id, row.fullHash]));
  for (const row of selectedRows) {
    if (row.kind !== 'summary') continue;
    if (proofs.get(row.id) !== prepared.hash(row.value)) throw bad();
    proofs.delete(row.id);
  }
  if (proofs.size) throw bad();
  operation.assertActive();
  const index = cache.build196(key, state, changed.changes, options);
  if (!index) return null;
  const serialized = renderDirectorySnapshotProven196(index, input, selected);
  if (serialized === null) return null;
  const stamp = operation.capturedVersions165();
  if (!stamp) return null;
  operation.afterCommit165(() =>
    cache.publish({
      key,
      stamp,
      claim,
      audience,
      index,
      logical196: { head: feed.head, keyGeneration, timeZone, current },
    }),
  );
  return context.json(context.res, 200, JSON.parse(serialized));
}
module.exports = { readDirectory196, rows196 };
