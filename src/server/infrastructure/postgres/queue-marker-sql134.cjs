const entries = [];
for (const [channel, table] of [
  ['telegram', 'staff_notification_jobs'],
  ['max', 'staff_max_jobs'],
])
  entries.push(
    Object.freeze({
      sql: `DELETE FROM telegram_runtime WHERE key=? AND NOT EXISTS(SELECT 1 FROM ${table} WHERE id=substr(telegram_runtime.key,${('staff-selftest-v1:' + channel + ':').length + 1}) AND status IN ('pending','sending') AND expires_at>?)`,
      key: Object.freeze([1]),
      kinds: Object.freeze(['marker']),
      domains: Object.freeze(['staff-' + channel]),
    }),
  );
module.exports = Object.freeze(entries);
