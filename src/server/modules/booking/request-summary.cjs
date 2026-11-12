const crypto = require('node:crypto');
const OTHER_TIME_TTL = 24 * 60 * 60000;

// A small, ACL-scoped feed stamp: never decrypt or return client contact data.
// The sealed blob prefix is the AES-GCM nonce/tag (platform-database.cjs).
// It also detects acceptance preparation, which deliberately keeps revision unchanged.
function createBookingRequestSummary({ db, limitKey }) {
  function summary(org, staffId = null, now = Date.now()) {
    const query = db.prepare(
      `SELECT id,revision,status,expires_at,created_at,substr(value,1,28) stamp
       FROM booking_requests WHERE organization_id=?
       AND status IN ('pending','requested','expired')` +
        (staffId ? ' AND staff_id=?' : '') +
        ' ORDER BY id',
    );
    const hash = crypto.createHash('sha256');
    let count = 0;
    for (const row of query.iterate(...(staffId ? [org, staffId] : [org]))) {
      const deadline =
        row.status === 'requested'
          ? Math.min(row.expires_at ?? Infinity, row.created_at + OTHER_TIME_TTL)
          : row.expires_at;
      const status = row.status !== 'expired' && deadline <= now ? 'expired' : row.status;
      hash.update(JSON.stringify([row.id, row.revision, status, row.expires_at]));
      hash.update(row.stamp);
      count++;
    }
    return {
      count,
      version: limitKey('booking-inbox', JSON.stringify([org, staffId, hash.digest('hex')])),
      checkedAt: now,
    };
  }
  function withSummary(read, org, staffId, now) {
    const owned = !db.isTransaction;
    if (owned) db.exec('BEGIN DEFERRED');
    try {
      // Rows and their stamp must belong to one SQLite snapshot across workers.
      const result = { ...read(), ...summary(org, staffId, now) };
      if (owned) db.exec('COMMIT');
      return result;
    } catch (error) {
      if (owned) db.exec('ROLLBACK');
      throw error;
    }
  }
  return { summary, withSummary };
}
module.exports = { createBookingRequestSummary };
