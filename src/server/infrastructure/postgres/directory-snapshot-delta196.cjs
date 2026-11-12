const { createHash } = require('node:crypto');
const { createDirectoryDeltaRender196 } = require('./directory-snapshot-delta-render196.cjs');
const snapshots = new WeakMap(),
  MAX_CHANGES = 32;
const digest = (id) => createHash('sha256').update(id).digest();
function find(base, id) {
  let lo = 0,
    hi = base.idOrder.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1,
      position = base.idOrder[mid],
      value = base.ids[position];
    if (value === id) return position;
    if (value < id) lo = mid + 1;
    else hi = mid;
  }
  return -1;
}
function assemble(base, overlay, { revision, timeZone, previous = null, kind196 = 'patch' }) {
  let count = base.ids.length,
    appointments = base.appointments,
    jsonBytes = base.jsonBytes,
    charge = base.charge + 1024;
  for (const item of overlay.values()) {
    if (item.position >= 0) {
      count--;
      appointments -= base.appointmentCounts[item.position];
      jsonBytes -= base.jsonLengths[item.position];
    }
    if (item.row) {
      count++;
      appointments += item.row.appointments;
      jsonBytes += item.row.jsonBytes;
    }
    charge += 1024 + (item.row?.charge || 0);
  }
  if (count > 2048 || appointments > 8192 || jsonBytes > 2 * 1024 * 1024) return null;
  const render = createDirectoryDeltaRender196({ base, overlay, revision, timeZone, previous }),
    index = Object.freeze({}),
    info = Object.freeze({ rows: count, charge, jsonBytes, render, logical196: true, kind196 });
  snapshots.set(index, { base, overlay, timeZone, render, info });
  return index;
}
function createDirectoryBase196(data, { charge, revision, timeZone }) {
  if (
    !data ||
    !Number.isSafeInteger(charge) ||
    charge < 0 ||
    data.ids.length > 2048 ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    typeof timeZone !== 'string' ||
    !timeZone
  )
    return null;
  const size = data.ids.length,
    idOrder = Uint32Array.from(
      Array.from({ length: size }, (_, i) => i).sort((a, b) =>
        data.ids[a] < data.ids[b] ? -1 : data.ids[a] > data.ids[b] ? 1 : 0,
      ),
    );
  let appointments = 0,
    jsonBytes = 0;
  for (let i = 0; i < size; i++) {
    if (i && data.ids[idOrder[i]] === data.ids[idOrder[i - 1]]) return null;
    appointments += data.appointmentCounts[i];
    jsonBytes += data.jsonLengths[i];
  }
  // Only immutable columns are shared. No previous index, renderer, cache entry,
  // raw SQL rows, decoder, authority, or owning-operation closure is retained.
  const base = Object.freeze({
    ids: data.ids,
    first: data.first,
    last: data.last,
    full: data.full,
    texts: data.texts,
    lastDates: data.lastDates,
    dates: data.dates,
    json: data.json,
    order: data.order,
    hashes: data.hashes,
    appointmentCounts: data.appointmentCounts,
    jsonLengths: data.jsonLengths,
    idOrder,
    appointments,
    jsonBytes,
    charge: charge + idOrder.byteLength + 2048,
  });
  return assemble(base, new Map(), { revision, timeZone, kind196: 'bootstrap' });
}
function patchDirectorySnapshot196(index, changes, { compile, revision, timeZone }) {
  let previous = snapshots.get(index);
  if (
    !previous ||
    previous.timeZone !== timeZone ||
    !Array.isArray(changes) ||
    changes.length > MAX_CHANGES ||
    typeof compile !== 'function' ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  )
    return null;
  const base = previous.base,
    overlay = new Map(previous.overlay),
    seen = new Set();
  let nextRank = base.ids.length;
  for (const item of overlay.values()) nextRank = Math.max(nextRank, item.rank + 1);
  if (!Number.isSafeInteger(nextRank) || nextRank >= Number.MAX_SAFE_INTEGER - MAX_CHANGES)
    return null;
  try {
    for (const change of changes) {
      const id = change?.id;
      if (typeof id !== 'string' || !id || id.length > 120 || seen.has(id)) return null;
      seen.add(id);
      const position = find(base, id),
        hashed = digest(id),
        existing = overlay.get(id);
      for (const [otherId, item] of overlay)
        if (otherId !== id && item.digest.equals(hashed)) return null;
      if (change.summary === null) {
        if (position < 0) overlay.delete(id);
        else
          overlay.set(
            id,
            Object.freeze({
              position,
              row: null,
              digest: hashed,
              rank: existing?.rank ?? position,
            }),
          );
      } else {
        const row = compile(change.summary);
        if (!row || row.id !== id || !/^[a-f0-9]{64}$/.test(change.fullHash || '')) return null;
        const rank = existing?.row
          ? existing.rank
          : existing || position < 0
            ? nextRank++
            : position;
        if (
          position >= 0 &&
          rank === position &&
          row.json === base.json[position] &&
          change.fullHash === base.hashes.toString('hex', position * 64 + 32, position * 64 + 64)
        )
          overlay.delete(id);
        else
          overlay.set(
            id,
            Object.freeze({ position, row, digest: hashed, fullHash: change.fullHash, rank }),
          );
      }
    }
    if (overlay.size > MAX_CHANGES) return null;
    return assemble(base, overlay, { revision, timeZone, previous: previous.render });
  } finally {
    previous = index = changes = compile = null;
    seen.clear();
  }
}
function resolveDirectorySnapshot196(index, identities) {
  const state = snapshots.get(index);
  if (!state || !Array.isArray(identities) || identities.length > MAX_CHANGES) return null;
  const base = state.base,
    result = [],
    missing = new Map(),
    seen = new Set();
  for (const value of identities) {
    const hex = typeof value === 'string' ? value : value?.identityDigest;
    if (typeof hex !== 'string' || !/^[a-f0-9]{64}$/.test(hex) || seen.has(hex)) return null;
    seen.add(hex);
    const id = typeof value === 'string' ? null : (value.patientId ?? null);
    if (id !== null) {
      if (typeof id !== 'string' || !id || id.length > 120 || digest(id).toString('hex') !== hex)
        return null;
      result.push({ identityDigest: hex, id });
    } else {
      missing.set(hex, result.length);
      result.push({ identityDigest: hex, id: null });
    }
  }
  // Complete journal identities take the O(changes) branch above. Only rare
  // projection-only events trigger ONE bounded pass for all requested digests;
  // no eager N hashes or N digest-order storage burden a cold bootstrap.
  if (missing.size) {
    const consider = (id) => {
      const hex = digest(id).toString('hex'),
        position = missing.get(hex);
      if (position === undefined) return true;
      if (result[position].id !== null && result[position].id !== id) return false;
      result[position].id = id;
      return true;
    };
    for (const id of base.ids) if (!consider(id)) return null;
    for (const id of state.overlay.keys()) if (!consider(id)) return null;
    if ([...missing.values()].some((position) => result[position].id === null)) return null;
  }
  return Object.freeze(result.map(Object.freeze));
}
function directorySnapshotInfo196(index) {
  return snapshots.get(index)?.info || null;
}
function peekDirectorySnapshot196(index, input) {
  const state = snapshots.get(index);
  if (!state) return null;
  const ids = state.render({ ...input, proofOnly196: true });
  if (!Array.isArray(ids) || ids.length > 100) return null;
  return Object.freeze(
    ids.map((id) => {
      const item = state.overlay.get(id),
        position = item?.position ?? find(state.base, id),
        fullHash = item?.row
          ? item.fullHash
          : state.base.hashes.toString('hex', position * 64 + 32, position * 64 + 64);
      return Object.freeze({ id, fullHash });
    }),
  );
}
module.exports = {
  createDirectoryBase196,
  patchDirectorySnapshot196,
  resolveDirectorySnapshot196,
  directorySnapshotInfo196,
  peekDirectorySnapshot196,
};
