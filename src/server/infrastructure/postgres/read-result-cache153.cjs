const { createHash } = require('node:crypto');
const { serialize } = require('node:v8');
const { retainValueBytes, readValueBytes } = require('../retained-value-bytes138.cjs');
const MAX_RESULT = 256 * 1024;
const volatile =
  /\b(?:platform_sessions|current_timestamp|current_date|localtimestamp|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday|pg_current_snapshot|random|nextval|currval|set_config|current_setting|now)\b/i;
function resultCacheKey(epoch, read, witness) {
  if (!witness || volatile.test(read.plan.text)) return null;
  return createHash('sha256')
    .update(
      serialize([
        epoch,
        read.scope.kind,
        read.scope.storeId,
        witness,
        read.plan.text,
        read.plan.values,
        read.method || 'all',
      ]),
    )
    .digest('hex');
}
function resultSize(result) {
  let size = 512 + result.fields.length * 128;
  for (const row of result.rows) {
    size += 64 + row.length * 32;
    for (const value of row)
      size += Buffer.isBuffer(value)
        ? value.byteLength
        : typeof value === 'string'
          ? value.length * 2
          : 16;
    if (size > MAX_RESULT) return size;
  }
  return size;
}
function createReadResultCache({ budget, maximumEntries = 256, ttlMs = 60000, now = Date.now }) {
  if (
    !budget ||
    !Number.isInteger(maximumEntries) ||
    maximumEntries < 1 ||
    maximumEntries > 1024 ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > 60000 ||
    typeof now !== 'function'
  )
    throw Error('Invalid SQL result cache bounds');
  const entries = new Map(),
    owner = {};
  const totals = { hits: 0, misses: 0, rejected: 0 };
  function remove(key) {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    budget.remove(entry.token);
  }
  return {
    get(key) {
      if (!key) return null;
      const entry = entries.get(key);
      if (!entry || entry.expires <= now()) {
        if (entry) remove(key);
        totals.misses++;
        return null;
      }
      totals.hits++;
      entries.delete(key);
      entries.set(key, entry);
      budget.touch(entry.token);
      return readValueBytes(entry.bytes);
    },
    put(key, result) {
      if (!key) return;
      remove(key);
      if (resultSize(result) > MAX_RESULT) {
        totals.rejected++;
        return;
      }
      const bytes = retainValueBytes(result);
      if (bytes.byteLength > MAX_RESULT) {
        totals.rejected++;
        return;
      }
      while (entries.size >= maximumEntries) remove(entries.keys().next().value);
      const entry = { token: {}, bytes, expires: now() + ttlMs };
      if (
        !budget.retain(
          entry.token,
          bytes.byteLength + key.length * 2 + 256,
          () => entries.delete(key),
          owner,
        )
      ) {
        totals.rejected++;
        return;
      }
      entries.set(key, entry);
    },
    clear() {
      entries.clear();
      budget.releaseOwner(owner);
    },
    stats: () => ({ ...totals, entries: entries.size }),
  };
}
module.exports = { createReadResultCache, resultCacheKey, resultSize, MAX_RESULT };
