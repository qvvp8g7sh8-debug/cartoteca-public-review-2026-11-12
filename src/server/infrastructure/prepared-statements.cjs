// Statements belong to exactly one connection, never to a tenant id or global cache.
// Re-execution still reads the current transaction; no query results are cached.
function createPreparedStatements(db, { limit = 160 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512)
    throw Error('Invalid prepared statement limit');
  const entries = new Map();
  let hits = 0,
    misses = 0;
  function prepare(sql) {
    let statement = entries.get(sql);
    if (statement) {
      hits++;
      entries.delete(sql);
    } else {
      misses++;
      statement = db.prepare(sql);
      if (entries.size >= limit) entries.delete(entries.keys().next().value);
    }
    entries.set(sql, statement);
    return statement;
  }
  return {
    prepare,
    clear: () => entries.clear(),
    stats: () => ({ entries: entries.size, limit, hits, misses }),
  };
}
module.exports = { createPreparedStatements };
