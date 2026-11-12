const LIMIT = 256 * 1024;
const valueBytes = (value) =>
  Buffer.isBuffer(value)
    ? value.byteLength
    : typeof value === 'string'
      ? Buffer.byteLength(value) * 2
      : 16;
// A private storage port: the caller already owns the ordinary transaction and
// its ACL/CAS policy. Bound each encrypted batch; large single values retain
// the established statement path. No SQL error is a reason to replay/fallback.
function createWriteBatch({ db, prepare }) {
  return (entries) => {
    let batch = [],
      bytes = 0;
    const single = (entry) => prepare(entry.sql).run(...entry.args);
    const flush = () => {
      if (!batch.length) return;
      if (typeof db.executeWriteBatch === 'function' && batch.length > 1)
        db.executeWriteBatch(batch);
      else for (const entry of batch) single(entry);
      batch = [];
      bytes = 0;
    };
    for (const entry of entries) {
      if (!entry || typeof entry.sql !== 'string' || !Array.isArray(entry.args))
        throw Error('Invalid private write batch');
      const size =
        512 +
        Buffer.byteLength(entry.sql) * 2 +
        entry.args.reduce((sum, value) => sum + valueBytes(value), 0);
      if (batch.length && (batch.length >= 32 || bytes + size > LIMIT)) flush();
      if (size > LIMIT) {
        single(entry);
        continue;
      }
      batch.push(entry);
      bytes += size;
    }
    flush();
  };
}
module.exports = { createWriteBatch, LIMIT };
