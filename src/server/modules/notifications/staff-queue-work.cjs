const { queueStatements } = require('../../infrastructure/postgres/queue-org-statements134.cjs');
const { channelEnabled, storedEvents } = require('./staff-event-preferences.cjs');
function clearStaffSelfTests(c, channel, org, account) {
  const prefix = `staff-selftest-v1:${channel}:`,
    table = channel === 'max' ? 'staff_max_jobs' : 'staff_notification_jobs';
  c.db
    .prepare(
      `DELETE FROM telegram_runtime WHERE key>=? AND key<? AND substr(key,?) IN (SELECT id FROM ${table} WHERE organization_id=? AND account_id=?)`,
    )
    .run(prefix, prefix + '\uffff', prefix.length + 1, org, account);
}
function createStaffQueueWork(c, links, channel) {
  const { db, seal } = c;
  const table = channel === 'max' ? 'staff_max_jobs' : 'staff_notification_jobs';
  const activity = require('./queue-activity.cjs').createQueueActivity(db, 'staff-' + channel);
  const nextPendingAt = require('./queue-idle-probe.cjs').createQueueNextDue(db, table);
  const prefix = `staff-selftest-v1:${channel}:`;
  function forget(id, org = '') {
    if (org) db.prepare(queueStatements('staff-' + channel).forget.sql).run(prefix + id, org);
    else db.prepare('DELETE FROM telegram_runtime WHERE key=?').run(prefix + id);
  }
  function prune(now) {
    db.prepare(
      `DELETE FROM telegram_runtime WHERE key>=? AND key<? AND NOT EXISTS
      (SELECT 1 FROM ${table} j WHERE j.id=substr(telegram_runtime.key,?) AND j.status IN ('pending','sending') AND j.expires_at>?)`,
    ).run(prefix, prefix + '\uffff', prefix.length + 1, now);
  }
  let pruneCursor = '',
    markerPage,
    markerLive;
  function pruneManaged(now, org = '') {
    if (!db.isTransaction) throw Error('Staff marker maintenance requires transaction.');
    markerPage ||= db.prepare(
      'SELECT key FROM telegram_runtime WHERE key>=? AND key<? AND key>? ORDER BY key LIMIT 64',
    );
    markerLive ||= db.prepare(
      `SELECT 1 FROM ${table} WHERE id=? AND status IN ('pending','sending') AND expires_at>?`,
    );
    const rows = org
      ? db
          .prepare(
            `SELECT r.key FROM telegram_runtime r JOIN ${table} j ON r.key='${prefix}' || j.id
       WHERE j.organization_id=? AND r.key>? ORDER BY r.key LIMIT 64`,
          )
          .all(org, pruneCursor)
      : markerPage.all(prefix, prefix + '\uffff', pruneCursor);
    for (const row of rows)
      if (!markerLive.get(row.key.slice(prefix.length), now))
        forget(row.key.slice(prefix.length), org);
    pruneCursor = rows.length === 64 ? rows.at(-1).key : '';
  }
  function remember(id, now) {
    if (!c.notificationMaintenance?.enabled) prune(now);
    db.prepare('INSERT OR REPLACE INTO telegram_runtime(key,value) VALUES(?,?)').run(
      prefix + id,
      seal({ active: true }),
    );
  }
  const pendingHint = db.prepare(
    `SELECT 1 FROM ${table} WHERE next_at<=? AND (status='pending' OR (status='sending' AND lease_until<=?)) ${c.notificationMaintenance?.enabled ? "AND status IN ('pending','sending') AND expires_at>?" : ''} LIMIT 1`,
  );
  function hasPendingWork(now) {
    if (!pendingHint.get(...(c.notificationMaintenance?.enabled ? [now, now, now] : [now, now])))
      return false;
    if (!channelEnabled(c, channel)) return false;
    if (!links.interest.hasEnabledRecipients())
      return Boolean(
        db
          .prepare(
            `SELECT 1 FROM telegram_runtime r
        CROSS JOIN ${table} j ON j.id=substr(r.key,?)
        WHERE r.key>=? AND r.key<? AND j.next_at<=? AND j.expires_at>? AND
        (j.status='pending' OR (j.status='sending' AND j.lease_until<=?)) LIMIT 1`,
          )
          .get(prefix.length + 1, prefix, prefix + '\uffff', now, now, now),
      );
    return true; // The fresh head above already proved a candidate exists.
  }
  function next(now, managed = false, org = '') {
    const hasRecipients = org
      ? links.interest.rows(org, null, 'delivery').some((row) => {
          const link = c.open(row.value);
          return link.enabled && storedEvents(link).length > 0;
        })
      : links.interest.hasEnabledRecipients();
    if ((c.notificationMaintenance?.enabled || managed) && hasRecipients)
      return db
        .prepare(
          `SELECT * FROM ${table} WHERE ${org ? 'organization_id=? AND ' : ''}status IN ('pending','sending') AND next_at<=? AND expires_at>? AND ${channel === 'max' ? "status='pending'" : "(status='pending' OR lease_until<=?)"} ORDER BY next_at,id LIMIT 1`,
        )
        .get(...(org ? [org] : []), ...(channel === 'max' ? [now, now] : [now, now, now]));
    if (hasRecipients)
      return db
        .prepare(
          `SELECT * FROM ${table} WHERE ${org ? 'organization_id=? AND ' : ''}next_at<=? AND (status='pending' OR (status='sending' AND lease_until<=?)) ORDER BY next_at,id LIMIT 1`,
        )
        .get(...(org ? [org] : []), now, now);
    return db
      .prepare(
        `SELECT j.* FROM telegram_runtime r CROSS JOIN ${table} j ON j.id=substr(r.key,?)
      WHERE ${org ? 'j.organization_id=? AND ' : ''}r.key>=? AND r.key<? AND j.next_at<=? AND j.expires_at>? AND (j.status='pending' OR (j.status='sending' AND j.lease_until<=?)) ${(c.notificationMaintenance?.enabled || managed) && channel === 'max' ? "AND j.status='pending'" : ''} ORDER BY j.next_at,j.id LIMIT 1`,
      )
      .get(prefix.length + 1, ...(org ? [org] : []), prefix, prefix + '\uffff', now, now, now);
  }
  return {
    remember,
    forget,
    prune,
    pruneManaged,
    hasPendingWork,
    next,
    nextPendingAt,
    subscribePending: activity.subscribe,
    notifyPending: activity.notify,
  };
}
module.exports = { createStaffQueueWork, clearStaffSelfTests };
