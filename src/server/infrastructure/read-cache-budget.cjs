// Account retained serialized data, not total V8/SQLite memory. One budget is shared
// by every tenant connection in a server process; tokens never leave that process.
function createReadCacheBudget({ maxBytes = 64 * 1024 * 1024, directoryMaxRows } = {}) {
  if (directoryMaxRows !== undefined && directoryMaxRows !== 150000)
    throw Error('Invalid directory row budget');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 512 * 1024 * 1024)
    throw Error('Invalid read cache budget');
  const entries = new Map();
  let bytes = 0,
    peakBytes = 0,
    evictions = 0,
    rejected = 0;
  function remove(token, evict = false) {
    const entry = entries.get(token);
    if (!entry) return;
    entries.delete(token);
    bytes -= entry.bytes;
    if (evict) {
      evictions++;
      entry.release();
    }
  }
  function retain(token, size, release, owner) {
    if (!Number.isSafeInteger(size) || size < 0 || typeof release !== 'function')
      throw Error('Invalid read cache entry');
    remove(token, true);
    if (!maxBytes || size > maxBytes) {
      rejected++;
      return false;
    }
    while (entries.size && bytes + size > maxBytes) remove(entries.keys().next().value, true);
    entries.set(token, { bytes: size, release, owner });
    bytes += size;
    peakBytes = Math.max(peakBytes, bytes);
    return true;
  }
  function touch(token) {
    const entry = entries.get(token);
    if (!entry) return;
    entries.delete(token);
    entries.set(token, entry);
  }
  function releaseOwner(owner) {
    for (const [token, entry] of entries) if (entry.owner === owner) remove(token, true);
  }
  function clear() {
    for (const token of entries.keys()) remove(token, true);
  }
  const budget = {
    retain,
    remove,
    touch,
    releaseOwner,
    clear,
    stats: () => ({
      maxBytes,
      bytes,
      peakBytes,
      entries: entries.size,
      evictions,
      rejected,
    }),
  };
  if (directoryMaxRows !== undefined)
    Object.defineProperty(budget, 'directoryMaxRows', {
      value: directoryMaxRows,
      enumerable: true,
    });
  return budget;
}
module.exports = { createReadCacheBudget };
