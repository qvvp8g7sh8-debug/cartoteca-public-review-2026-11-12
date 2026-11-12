// Reusable clinical projections only. Fresh authority and a fresh physical RR
// source witness are required by the caller on every hit. No timers grant access.
function createReadViewCache({ budget, maximumEntries = 128, ttlMs = 60000, now = Date.now }) {
  if (
    !budget ||
    !Number.isInteger(maximumEntries) ||
    maximumEntries < 1 ||
    maximumEntries > 512 ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > 60000 ||
    typeof now !== 'function'
  )
    throw Error('Invalid read view cache bounds');
  const entries = new Map(),
    owner = {};
  const totals = { hits: 0, misses: 0, invalidated: 0, rejected: 0 };
  function remove(key) {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    budget.remove(entry.token);
  }
  function get(key, witness) {
    const entry = entries.get(key);
    if (!entry || !witness || entry.witness !== witness || entry.expires <= now()) {
      if (entry) {
        totals.invalidated++;
        remove(key);
      }
      totals.misses++;
      return null;
    }
    totals.hits++;
    budget.touch(entry.token);
    entries.delete(key);
    entries.set(key, entry);
    // Never lend a mutable clinical graph or an operation's crypto capability.
    return JSON.parse(entry.serialized);
  }
  function put(key, witness, value) {
    remove(key);
    if (!witness) return;
    const serialized = JSON.stringify(value),
      bytes = 2 * serialized.length + 2 * key.length + 512;
    if (bytes > 1024 * 1024) {
      totals.rejected++;
      return;
    }
    while (entries.size >= maximumEntries) remove(entries.keys().next().value);
    const entry = { token: {}, witness, serialized, expires: now() + ttlMs };
    if (!budget.retain(entry.token, bytes, () => entries.delete(key), owner)) {
      totals.rejected++;
      return;
    }
    entries.set(key, entry);
  }
  return {
    get,
    put,
    clear() {
      entries.clear();
      budget.releaseOwner(owner);
    },
    stats: () => ({ ...totals, entries: entries.size }),
  };
}
module.exports = { createReadViewCache };
