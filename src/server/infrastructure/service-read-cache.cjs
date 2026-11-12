const { ownedBytes, retainValueBytes, readValueBytes } = require('./retained-value-bytes138.cjs');
// Each connection owns byte-backed values. Current SQL ciphertext is checked on
// every read; a hit avoids decryption and returns a fresh decoded object.
function createServiceReadCache({
  db,
  decode,
  budget,
  owner,
  maxEntries = 2000,
  maxBytes = 8 * 1024 * 1024,
}) {
  const select = db.prepare('SELECT id,value FROM services ORDER BY rowid');
  const cache = new Map();
  let bytes = 0;
  function remove(id) {
    const entry = cache.get(id);
    if (entry) {
      bytes -= entry.bytes;
      budget?.remove(entry);
    }
    cache.delete(id);
  }
  const eviction = (id) => () => remove(id);
  function clear() {
    for (const id of cache.keys()) remove(id);
  }
  function read() {
    const rows = select.all(),
      present = new Set(rows.map((row) => row.id));
    for (const id of cache.keys()) if (!present.has(id)) remove(id);
    return rows.map((row) => {
      const prior = cache.get(row.id);
      if (prior?.ciphertext.equals(row.value)) {
        cache.delete(row.id);
        cache.set(row.id, prior);
        budget?.touch(prior);
        return readValueBytes(prior.data);
      }
      remove(row.id);
      const ciphertext = ownedBytes(row.value),
        value = decode(ciphertext),
        data = retainValueBytes(value),
        size = row.value.byteLength + data.byteLength + Buffer.byteLength(row.id) + 64;
      if (size <= maxBytes && maxEntries > 0) {
        while (cache.size && (cache.size >= maxEntries || bytes + size > maxBytes))
          remove(cache.keys().next().value);
        const entry = { ciphertext, data, bytes: size };
        if (!budget || budget.retain(entry, size, eviction(row.id), owner)) {
          cache.set(row.id, entry);
          bytes += size;
        }
      }
      return value;
    });
  }
  return { read, clear };
}
module.exports = { createServiceReadCache };
