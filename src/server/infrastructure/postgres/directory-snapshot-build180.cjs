const {
  createDirectorySnapshotIndex180,
  directorySnapshotIndexInfo180,
} = require('./directory-snapshot-index180.cjs');
const {
  directorySnapshotKey180,
  directorySnapshotClaim180,
  snapshotRequest180,
} = require('./directory-snapshot-key180.cjs');
const bad = () =>
  Object.assign(Error('Prepared directory snapshot is invalid.'), {
    status: 503,
    code: 'CABINET_DIRECTORY_INDEX',
  });
async function produceDirectorySnapshot180(
  { operation, prepared, current, url, context, value, audience, timeZone, cache },
  page183 = false,
) {
  if (
    !cache ||
    !snapshotRequest180(url) ||
    !operation.directory164 ||
    typeof operation.requireDirectorySnapshotMemory180 !== 'function'
  )
    return false;
  const stamp = operation.capturedVersions165();
  if (
    !stamp ||
    !Array.isArray(value.directory) ||
    value.directory.length > 2048 ||
    !Array.isArray(value.proofs) ||
    value.proofs.length !== value.directory.length
  )
    return false;
  const key = directorySnapshotKey180({
    epoch: operation.epoch,
    storeId: operation.scope.storeId,
    current,
  });
  const claim = directorySnapshotClaim180({
    epoch: operation.epoch,
    platformStoreId: operation.platform.storeId,
    token: context.token,
    headers: context.req.headers,
    url,
  });
  if (!claim || (cache.has(key) && cache.hasStamp180(key, stamp))) return false;
  // Upgrade is idempotent and precedes full-summary SQL, SQL-result-cache
  // decoding, application decoding, index creation, and persistent admission.
  await operation.requireDirectorySnapshotMemory180();
  const bound = await operation.probe([
    {
      scope: operation.scope,
      catalog: operation.cabinetCatalog,
      table: 'cabinet_summaries',
      where: 's.audience=$2',
      values: [audience],
    },
  ]);
  const source = bound.sourceBounds.get('cabinet:cabinet_summaries');
  if (
    !source ||
    source.rows > 2048 ||
    source.bytes > 2 * 1024 * 1024 ||
    source.rows !== value.directory.length
  )
    return false;
  const proofs = new Map(value.proofs),
    expected = new Set(value.directory.map((row) => row.id));
  if (
    proofs.size !== expected.size ||
    expected.size !== value.directory.length ||
    [...expected].some((id) => !/^[a-f0-9]{64}$/.test(proofs.get(id) || ''))
  )
    throw bad();
  const rows = await operation.selectView('directory', { audience });
  const summaries = [],
    seen = new Set();
  for (const row of rows) {
    if (row.bucket === 'meta') continue;
    if (
      row.bucket !== 'summary' ||
      !expected.has(row.id) ||
      seen.has(row.id) ||
      prepared.hash(row.value) !== proofs.get(row.id)
    )
      throw bad();
    const summary = prepared.decode(row.value);
    if (!summary || typeof summary !== 'object' || Array.isArray(summary) || summary.id !== row.id)
      throw bad();
    seen.add(row.id);
    summaries.push(summary);
  }
  if (seen.size !== expected.size) throw bad();
  const index = createDirectorySnapshotIndex180(summaries, { revision: value.revision, timeZone });
  if (!index) return false;
  // A complete proof-bound snapshot can supply this cold page directly. The
  // opaque index never escapes, and only an already bounded page is parsed by
  // the caller. No legacy base/binary/full-summary cache is needed on success.
  const serialized = page183
    ? directorySnapshotIndexInfo180(index).render({ current, url, cursorCrypto: prepared })
    : null;
  if (page183 && serialized === null) return false;
  operation.assertActive();
  // Caller supplies this cache ONLY for the trusted finish167/hotMetadata169
  // producer. The hook runs after COMMIT ACK + fresh post-COMMIT authority.
  operation.afterCommit165(() => cache.publish({ key, stamp, claim, audience, index }));
  return page183 ? serialized : true;
}
async function stageDirectorySnapshot180(input) {
  return (await produceDirectorySnapshot180(input)) === true;
}
async function prepareDirectorySnapshot183(input) {
  const serialized = await produceDirectorySnapshot180(input, true);
  return typeof serialized === 'string' ? serialized : null;
}
async function prepareDirectorySnapshot185({
  operation,
  prepared,
  current,
  url,
  context,
  rows,
  revision,
  audience,
  timeZone,
  cache,
  cohort189 = null,
}) {
  if (
    !cache ||
    !snapshotRequest180(url) ||
    !operation.directory164 ||
    typeof operation.requireDirectorySnapshotMemory180 !== 'function' ||
    typeof cache.proofs185 !== 'function' ||
    typeof cache.build185 !== 'function'
  )
    return null;
  const projected = rows.filter((row) => row.kind !== 'meta');
  // Missing/raw projections retain the fully validated legacy path. A source
  // hash from an old snapshot is never inferred solely from a patient ID.
  if (projected.length > 2048 || projected.some((row) => row.kind !== 'projection')) return null;
  const stamp = operation.capturedVersions165();
  if (!stamp) return null;
  const key = directorySnapshotKey180({
    epoch: operation.epoch,
    storeId: operation.scope.storeId,
    current,
  });
  const claim = directorySnapshotClaim180({
    epoch: operation.epoch,
    platformStoreId: operation.platform.storeId,
    token: context.token,
    headers: context.req.headers,
    url,
  });
  if (!claim || (cache.has(key) && cache.hasStamp180(key, stamp))) return null;
  // The head and complete body belong to the same fixed owning-RR snapshot.
  // Capture it before the private borrow; legacy callers have no head.
  const head196 =
    typeof operation.directoryHead196 === 'function' ? await operation.directoryHead196() : null;
  await operation.requireDirectorySnapshotMemory180();
  // The only data held across the following SQL await are detached IDs/hashes,
  // fresh SQL buffers and operation-owned proof metadata, not a clinical index.
  const candidate = cache.proofs185(key, timeZone);
  const previous = new Map();
  if (candidate) {
    if (
      !Array.isArray(candidate.ids) ||
      candidate.ids.length > 2048 ||
      !Buffer.isBuffer(candidate.hashes) ||
      candidate.hashes.length !== candidate.ids.length * 64
    )
      throw bad();
    candidate.ids.forEach((id, i) => {
      if (typeof id !== 'string' || !id || id.length > 120 || previous.has(id)) throw bad();
      previous.set(id, i);
    });
  }
  const pairs = new Map();
  for (const row of projected) {
    if (typeof row.id !== 'string' || !row.id || row.id.length > 120 || pairs.has(row.id))
      throw bad();
    const projection = prepared.hash(row.value),
      old = previous.get(row.id);
    let full;
    if (
      old !== undefined &&
      candidate.hashes.toString('hex', old * 64, old * 64 + 32) === projection
    ) {
      full = candidate.hashes.toString('hex', old * 64 + 32, old * 64 + 64);
    } else {
      const decoded = prepared.decode(row.value);
      if (
        !decoded ||
        typeof decoded !== 'object' ||
        Array.isArray(decoded) ||
        decoded.version !== 1 ||
        decoded.id !== row.id ||
        decoded.audience !== audience ||
        decoded.row?.id !== row.id ||
        !Array.isArray(decoded.row.appointments) ||
        !/^[a-f0-9]{64}$/.test(decoded.sourceHash)
      )
        throw bad();
      full = decoded.sourceHash;
    }
    pairs.set(row.id, { projection, full });
  }
  previous.clear();
  const cohortFull189 = cohort189 ? operation.directoryCohortFull189(cohort189) : null;
  const bound = cohortFull189
    ? null
    : await operation.probe([
        {
          scope: operation.scope,
          catalog: operation.cabinetCatalog,
          table: 'cabinet_summaries',
          where: 's.audience=$2',
          values: [audience],
        },
      ]);
  const source = bound?.sourceBounds.get('cabinet:cabinet_summaries');
  if (!cohortFull189 && (!source || source.rows > 2048 || source.bytes > 2 * 1024 * 1024))
    return null;
  if ((cohortFull189 ? cohortFull189.length : source.rows) !== pairs.size) throw bad();
  const selected = cohortFull189 || (await operation.selectView('directory', { audience }));
  const fullRows = [],
    seen = new Set();
  for (const row of selected) {
    if (row.bucket === 'meta') continue;
    const pair = pairs.get(row.id);
    // Compare with the CURRENT projection proof, not the OLD cached hash.
    // Changed projection+full pairs are legal updates; an inconsistent current
    // full cipher is still the same fail-closed503 as the original producer.
    if (
      row.bucket !== 'summary' ||
      !pair ||
      seen.has(row.id) ||
      prepared.hash(row.value) !== pair.full
    )
      throw bad();
    seen.add(row.id);
    fullRows.push(row);
  }
  if (seen.size !== pairs.size) throw bad();
  operation.assertActive();
  // No awaits after the clinical borrow. The cache rechecks TTL/token/timezone
  // synchronously; eviction/replacement means all fresh rows decode again.
  let index = cache.build185(key, candidate?.token, fullRows, {
    pairs,
    revision,
    timeZone,
    decode(row) {
      const summary = prepared.decode(row.value);
      if (
        !summary ||
        typeof summary !== 'object' ||
        Array.isArray(summary) ||
        summary.id !== row.id
      )
        throw bad();
      return summary;
    },
  });
  if (!index) return null;
  let logical196 = null;
  if (head196 && prepared.keyGeneration196 && typeof cache.initialize196 === 'function') {
    const initialized = cache.initialize196(index, { revision, timeZone });
    if (initialized) {
      index = initialized;
      logical196 = { head: head196, keyGeneration: prepared.keyGeneration196, current, timeZone };
    }
  }
  const serialized = directorySnapshotIndexInfo180(index).render({
    current,
    url,
    cursorCrypto: prepared,
  });
  if (serialized === null) return null;
  operation.assertActive();
  operation.afterCommit165(() => cache.publish({ key, stamp, claim, audience, index, logical196 }));
  return serialized;
}
module.exports = {
  stageDirectorySnapshot180,
  prepareDirectorySnapshot183,
  prepareDirectorySnapshot185,
};
