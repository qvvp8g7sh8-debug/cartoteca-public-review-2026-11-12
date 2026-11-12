const statement = (sql, key, kinds, bot = []) =>
  Object.freeze({
    sql,
    key: Object.freeze(key),
    kinds: Object.freeze(kinds),
    bot: Object.freeze(bot),
  });
const statements = Object.freeze({
  acquire: statement(
    `INSERT INTO max_runtime_leases VALUES(?,?,?)
    ON CONFLICT(bot_hash) DO UPDATE SET owner=excluded.owner,lease_until=excluded.lease_until
    WHERE max_runtime_leases.owner=excluded.owner OR max_runtime_leases.lease_until<=?`,
    [1],
    ['bot'],
  ),
  renew: statement(
    'UPDATE max_runtime_leases SET lease_until=? WHERE bot_hash=? AND owner=? AND lease_until=? AND lease_until>?',
    [2],
    ['bot'],
  ),
  release: statement('DELETE FROM max_runtime_leases WHERE bot_hash=? AND owner=?', [1], ['bot']),
  insert: statement(
    "INSERT INTO max_event_inbox(id,bot_hash,event_hash,value,status,created_at,next_at,expires_at) VALUES(?,?,?,?,'pending',?,?,?)",
    [2],
    ['admission'],
  ),
  recover: statement(
    "UPDATE max_event_inbox SET status='pending',lease_id=NULL,lease_until=0 WHERE id=? AND bot_hash=? AND status='processing' AND attempt=? AND lease_until=? AND lease_id IS ? AND lease_until<=?",
    [1],
    ['event'],
    [2],
  ),
  fail: statement(
    "UPDATE max_event_inbox SET status='failed',lease_id=NULL,lease_until=0 WHERE id=? AND bot_hash=? AND status=? AND attempt=? AND lease_until=? AND lease_id IS ? AND (status='pending' OR (status='processing' AND lease_until<=?)) AND (expires_at<=? OR attempt>=10)",
    [1],
    ['event'],
    [2],
  ),
  claim: statement(
    "UPDATE max_event_inbox SET status='processing',attempt=attempt+1,lease_until=?,lease_id=? WHERE id=? AND bot_hash=? AND status='pending' AND attempt=? AND lease_until=? AND lease_id IS ? AND next_at<=? AND expires_at>? AND attempt<10",
    [3],
    ['event'],
    [4],
  ),
  save: statement(
    "UPDATE max_event_inbox SET value=? WHERE id=? AND bot_hash=? AND status='processing' AND lease_id=? AND lease_until=? AND attempt=?",
    [2],
    ['event'],
    [3],
  ),
  finish: statement(
    "UPDATE max_event_inbox SET status=?,next_at=?,lease_until=0,lease_id=NULL WHERE id=? AND bot_hash=? AND status='processing' AND lease_id=? AND lease_until=? AND attempt=?",
    [3],
    ['event'],
    [4],
  ),
  defer: statement(
    "UPDATE max_event_inbox SET status='pending',attempt=max(0,attempt-1),next_at=?,lease_until=0,lease_id=NULL WHERE id=? AND bot_hash=? AND status='processing' AND lease_id=? AND lease_until=? AND attempt=?",
    [2],
    ['event'],
    [3],
  ),
});
function terminalPurge(count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 64)
    throw Error('Invalid MAX terminal cleanup page.');
  return statement(
    `DELETE FROM max_event_inbox WHERE (${Array.from({ length: count }, () => '(id=? AND status=? AND expires_at=?)').join(' OR ')}) AND status IN ('done','failed') AND expires_at<=?`,
    [],
    ['admission'],
  );
}
module.exports = { statements, terminalPurge };
