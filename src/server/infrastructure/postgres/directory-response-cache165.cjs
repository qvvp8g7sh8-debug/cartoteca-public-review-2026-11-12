const { ArrayBuffer, Uint8Array } = globalThis;
const { zonedClock } = require('../../../shared/time-zone.cjs');
const MAX_BODY = 64 * 1024;

// Only a small, already serialized kernel response is retained. Every hit needs
// fresh authority and an exact durable source stamp. A private claim is merely a
// no-body hint; only the after-COMMIT own-kernel JSON producer may supply one.
function createDirectoryResponseCache165({
  budget,
  maxBodyBytes = MAX_BODY,
  maxEntries = 128,
  now = Date.now,
  ttlMs = 60000,
}) {
  if (
    !budget ||
    !['retain', 'touch', 'remove', 'releaseOwner'].every(
      (method) => typeof budget[method] === 'function',
    ) ||
    !Number.isSafeInteger(maxBodyBytes) ||
    maxBodyBytes < 1 ||
    maxBodyBytes > MAX_BODY ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > 128 ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > 60000 ||
    typeof now !== 'function'
  )
    throw Error('Invalid directory response cache bounds');
  const entries = new Map(),
    claims170 = new Map(),
    owner = {},
    totals = { hits: 0, misses: 0, invalidated: 0, rejected: 0 };
  const validStamp = (stamp) => typeof stamp === 'string' && stamp.length > 0;
  const validClaim170 = (claim) =>
    claim === null || (typeof claim === 'string' && claim.length > 0 && claim.length <= 2048);
  function unlink(entry, releaseBudget) {
    // A delayed callback from an evicted old token cannot delete its replacement.
    if (entries.get(entry.key) !== entry) return;
    entries.delete(entry.key);
    if (entry.claimKey170 !== null) {
      const bucket = claims170.get(entry.claimKey170);
      bucket?.delete(entry);
      if (bucket?.size === 0) claims170.delete(entry.claimKey170);
    }
    // Explicit budget.remove does not invoke the release callback.
    if (releaseBudget) budget.remove(entry.token);
  }
  function remove(key) {
    const entry = entries.get(key);
    if (entry) unlink(entry, true);
  }
  function current(key) {
    const entry = entries.get(key);
    if (!entry) return null;
    const time = now();
    if (
      entry.expires <= time ||
      (!entry.explicitToday && zonedClock(time, entry.timeZone).date !== entry.day)
    ) {
      totals.invalidated++;
      unlink(entry, true);
      return null;
    }
    return entry;
  }
  return {
    has(key) {
      return current(key) !== null;
    },
    hasClaim170(claimKey) {
      if (!validClaim170(claimKey) || claimKey === null) return false;
      const bucket = claims170.get(claimKey);
      if (!bucket) return false;
      for (const entry of bucket) {
        // A bucket has at most maxEntries links and never reads entry.json.
        if (current(entry.key) === entry) return true;
      }
      return false;
    },
    // Metadata hint only: stale TTL/day may still return true. The final get
    // after actual authority/assets must repeat every retention/source guard.
    hasStamp171(key, stamp) {
      return validStamp(stamp) && entries.get(key)?.stamp === stamp;
    },
    get(key, stamp) {
      const entry = current(key);
      if (!entry || !validStamp(stamp) || entry.stamp !== stamp) {
        if (entry) {
          totals.invalidated++;
          unlink(entry, true);
        }
        totals.misses++;
        return null;
      }
      totals.hits++;
      budget.touch(entry.token);
      entries.delete(key);
      entries.set(key, entry);
      // Strings are immutable; no decoded graph or borrowed Buffer escapes.
      return { json: entry.json };
    },
    put(
      key,
      stamp,
      bodyBuffer,
      { timeZone, explicitToday = false, renderedDay, claimKey170 = null } = {},
    ) {
      remove(key);
      if (
        typeof key !== 'string' ||
        !key ||
        !validStamp(stamp) ||
        !(bodyBuffer instanceof ArrayBuffer || bodyBuffer instanceof Uint8Array) ||
        bodyBuffer.byteLength > maxBodyBytes ||
        typeof timeZone !== 'string' ||
        timeZone.length > 80 ||
        typeof explicitToday !== 'boolean' ||
        !validClaim170(claimKey170)
      ) {
        totals.rejected++;
        return false;
      }
      const time = now(),
        day = zonedClock(time, timeZone).date;
      if (!explicitToday && renderedDay !== undefined && renderedDay !== day) {
        totals.rejected++;
        return false;
      }
      // Reject over-cap bytes and invalid claims before constructing a string.
      const bytes =
          bodyBuffer instanceof ArrayBuffer
            ? Buffer.from(bodyBuffer)
            : Buffer.from(bodyBuffer.buffer, bodyBuffer.byteOffset, bodyBuffer.byteLength),
        json = bytes.toString('utf8'),
        claimBytes = claimKey170 === null ? 0 : claimKey170.length * 2 + 384,
        size =
          json.length * 2 + (key.length + stamp.length + timeZone.length) * 2 + 512 + claimBytes;
      while (entries.size >= maxEntries) remove(entries.keys().next().value);
      const entry = {
        key,
        token: {},
        stamp,
        json,
        timeZone,
        explicitToday,
        day,
        expires: time + ttlMs,
        claimKey170,
      };
      if (!budget.retain(entry.token, size, () => unlink(entry, false), owner)) {
        totals.rejected++;
        return false;
      }
      entries.set(key, entry);
      if (claimKey170 !== null) {
        let bucket = claims170.get(claimKey170);
        if (!bucket) claims170.set(claimKey170, (bucket = new Set()));
        bucket.add(entry);
      }
      return true;
    },
    clear() {
      entries.clear();
      claims170.clear();
      budget.releaseOwner(owner);
    },
    stats: () => ({ ...totals, entries: entries.size }),
  };
}
module.exports = { createDirectoryResponseCache165 };
