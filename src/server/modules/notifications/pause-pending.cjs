// Explicit administrative/recovery mutation only; never called by an idle tick.
function pausePendingNotifications(c, org, clientOnly = false) {
  if (!c.db.isTransaction) throw Error('Pausing notifications requires the platform transaction.');
  const exists = c.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?");
  const tables = [
    'telegram_jobs',
    'notification_jobs',
    'notification_channel_jobs',
    ...(clientOnly ? [] : ['staff_notification_jobs', 'staff_max_jobs', 'staff_push_jobs']),
  ];
  for (const table of tables) {
    if (!exists.get(table)) continue;
    c.db
      .prepare(
        'UPDATE ' +
          table +
          " SET status='cancelled',lease_until=0 WHERE organization_id=? AND status IN ('pending','reserved')",
      )
      .run(org);
  }
}
module.exports = { pausePendingNotifications };
