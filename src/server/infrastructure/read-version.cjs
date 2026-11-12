const { randomUUID } = require('node:crypto');
// data_version alone is connection-local and misses this connection's commits.
// Include both counters and a unique connection epoch. A different worker safely
// causes a cache miss. This deliberately invalidates on unrelated platform writes.
function createReadVersion(db) {
  const epoch = randomUUID();
  if (db.dialect === 'postgres' && db.revisionProfile === 3) {
    if (typeof db.snapshotVersion !== 'function')
      throw Error('PostgreSQL MVCC read version capability is unavailable.');
    // Capture BEFORE dependent rows. An exact snapshot detects late commits by
    // xip removal, not only xid allocation. The monotonic local clock covers
    // this connection's writes and rollback/savepoint ABA inside one snapshot.
    return () => [epoch, db.snapshotVersion(), db.localMutationClock];
  }
  const external = db.prepare('PRAGMA data_version');
  // Both compatibility counters map to the same fresh catalog revision on PG.
  // Read it once: no cross-request cache and no stale authority/cache token.
  if (db.dialect === 'postgres')
    return () => {
      const revision = external.get().data_version;
      return [epoch, revision, db.revisionProfile === 2 ? db.localMutationClock : revision];
    };
  const local = db.prepare('SELECT total_changes() AS n');
  return () => [epoch, external.get().data_version, local.get().n];
}
module.exports = { createReadVersion };
