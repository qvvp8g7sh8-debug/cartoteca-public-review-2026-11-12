// One long-poll consumer per shared local platform database. Job delivery has its own leases.
function createTelegramCoordination({ db, seal, open, transaction }) {
  const key = 'poll-leader';
  function acquirePollLease(owner, now = Date.now()) {
    return transaction(() => {
      const row = db.prepare('SELECT value FROM telegram_runtime WHERE key=?').get(key);
      const lease = row ? open(row.value) : null;
      if (lease && lease.owner !== owner && lease.until > now) return false;
      db.prepare('INSERT OR REPLACE INTO telegram_runtime(key,value) VALUES(?,?)').run(
        key,
        seal({ owner, until: now + 120000 }),
      );
      return true;
    });
  }
  function releasePollLease(owner) {
    transaction(() => {
      const row = db.prepare('SELECT value FROM telegram_runtime WHERE key=?').get(key);
      if (row && open(row.value).owner === owner)
        db.prepare('DELETE FROM telegram_runtime WHERE key=?').run(key);
    });
  }
  return { acquirePollLease, releasePollLease };
}
module.exports = { createTelegramCoordination };
