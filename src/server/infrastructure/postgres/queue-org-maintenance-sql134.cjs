const phases = [];
const add = (
  id,
  table,
  domain,
  channel,
  predicate,
  parameters,
  lagColumn,
  mode,
  reset = true,
  lagOffset = 0,
) =>
  phases.push(
    Object.freeze({
      id,
      table,
      domain,
      channel,
      predicate,
      parameters: Object.freeze(parameters),
      lagColumn,
      mode,
      reset,
      lagOffset,
    }),
  );
for (const channel of ['telegram', 'max']) {
  add(
    'client-' + channel + '-sending',
    'notification_channel_jobs',
    'client',
    channel,
    "status='sending' AND channel=? AND lease_until<=?",
    ['channel', 'now'],
    'lease_until',
    'uncertain',
    false,
  );
  add(
    'client-' + channel + '-reserved',
    'notification_channel_jobs',
    'client',
    channel,
    "status='reserved' AND channel=? AND lease_until<=?",
    ['channel', 'now'],
    'lease_until',
    'reserved',
    false,
  );
  add(
    'client-' + channel + '-expiry',
    'notification_channel_jobs',
    'client',
    channel,
    "status='pending' AND channel=? AND expires_at<=?",
    ['channel', 'now'],
    'expires_at',
    'cancelled',
    false,
  );
}
for (const [channel, table] of [
  ['telegram', 'staff_notification_jobs'],
  ['max', 'staff_max_jobs'],
  ['push', 'staff_push_jobs'],
]) {
  if (channel === 'max')
    add(
      'staff-max-sending',
      table,
      'staff-max',
      channel,
      "status='sending' AND lease_until<=?",
      ['now'],
      'lease_until',
      'uncertain',
    );
  add(
    'staff-' + channel + '-expiry',
    table,
    channel === 'push' ? 'push' : 'staff-' + channel,
    channel,
    "status IN ('pending','sending') AND expires_at<=?",
    ['now'],
    'expires_at',
    channel === 'max' ? 'max-expiry' : 'cancelled',
  );
  add(
    'staff-' + channel + '-retention',
    table,
    channel === 'push' ? 'push' : 'staff-' + channel,
    channel,
    "status IN ('sent','failed','cancelled'" +
      (channel === 'max' ? ",'uncertain'" : '') +
      ') AND expires_at<?',
    ['retention'],
    'expires_at',
    'delete',
    true,
    7 * 86400000,
  );
}
const definitions = Object.freeze(phases);
function parameters(d, now) {
  return d.parameters.map((key) =>
    key === 'channel' ? d.channel : key === 'retention' ? now - 7 * 86400000 : now,
  );
}
function status(d, row, now) {
  return d.mode === 'reserved'
    ? row.expires_at <= now
      ? 'cancelled'
      : 'pending'
    : d.mode === 'max-expiry'
      ? row.status === 'sending' && row.lease_until <= now
        ? 'uncertain'
        : 'cancelled'
      : d.mode;
}
function statement(d, count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 64)
    throw Error('Invalid bounded maintenance batch.');
  const body = Array.from(
    { length: count },
    () => '(id=? AND status=? AND lease_until=? AND expires_at=?)',
  ).join(' OR ');
  const assignment =
    d.mode === 'delete'
      ? ''
      : `status=CASE id ${Array.from({ length: count }, () => 'WHEN ? THEN ?').join(' ')} ELSE status END,lease_until=0${d.reset ? ',lease_id=NULL' : ''}`;
  return {
    sql: `${d.mode === 'delete' ? 'DELETE FROM ' + d.table : 'UPDATE ' + d.table + ' SET ' + assignment} WHERE organization_id=? AND (${d.predicate}) AND (${body})`,
    org: [d.mode === 'delete' ? 1 : count * 2 + 1],
    domains: [d.domain],
  };
}
function candidates(arity) {
  const entries = [];
  for (const d of definitions) {
    const n = (arity - 1 - d.parameters.length) / (d.mode === 'delete' ? 4 : 6);
    if (Number.isSafeInteger(n) && n >= 1 && n <= 64) entries.push(statement(d, n));
  }
  return entries;
}
const writes = [];
const addWrite = (sql, org, domains = ['schedule']) =>
  writes.push(Object.freeze({ sql, org: Object.freeze(org), domains: Object.freeze(domains) }));
addWrite('DELETE FROM notification_schedule WHERE kind=? AND organization_id=? AND subject=?', [2]);
addWrite('INSERT INTO notification_schedule VALUES(?,?,?,?,?,?,?,?)', [2]);
addWrite(
  'UPDATE notification_schedule_dirty SET cursor=? WHERE kind=? AND organization_id=? AND subject=?',
  [3],
);
addWrite(
  'DELETE FROM notification_schedule_dirty WHERE kind=? AND organization_id=? AND subject=?',
  [2],
);
addWrite(
  'UPDATE notification_schedule SET due_at=? WHERE kind=? AND organization_id=? AND subject=? AND entity=? AND version=?',
  [3],
);
addWrite(
  'DELETE FROM notification_schedule WHERE kind=? AND organization_id=? AND subject=? AND entity=? AND version=?',
  [2],
);
addWrite(
  "INSERT INTO notification_schedule_dirty(kind,organization_id,subject) VALUES(?,?,?) ON CONFLICT(kind,organization_id,subject) DO UPDATE SET version=version+1,cursor=''",
  [2],
);
addWrite(
  'DELETE FROM notification_schedule_intents WHERE id=? AND organization_id=? AND lease_until=?',
  [2],
);
addWrite(
  'DELETE FROM telegram_confirmations WHERE organization_id=? AND patient_id=? AND fingerprint=?',
  [1],
);
addWrite(
  "UPDATE telegram_jobs SET callback_hash=?,value=?,status='pending',attempts=0,next_at=?,lease_until=0,expires_at=? WHERE id=? AND organization_id=?",
  [6],
);
addWrite(
  "INSERT OR IGNORE INTO telegram_jobs(id,organization_id,patient_id,fingerprint,callback_hash,value,status,next_at,expires_at) VALUES(?,?,?,?,?,?,'pending',?,?)",
  [2],
);
const push = require('./compound-sql133.cjs').find((entry) =>
  entry.sql.startsWith('INSERT INTO staff_push_jobs'),
);
addWrite(push.sql, [...push.org]);
Object.defineProperties(writes, {
  candidates: { value: candidates },
  phases: { value: definitions },
  parameters: { value: parameters },
  status: { value: status },
  statement: { value: statement },
});
module.exports = Object.freeze(writes);
