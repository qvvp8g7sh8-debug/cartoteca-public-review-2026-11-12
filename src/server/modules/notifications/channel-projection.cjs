const KEY = 'notification-channel-state-v1';
// A second execution owner observes durable epochs. It never reconciles process
// configuration, generates epochs, or cancels another owner's pending jobs.
function createNotificationChannelProjection(c) {
  const read = c.db.prepare('SELECT value FROM telegram_runtime WHERE key=?');
  const current = () => {
    const row = read.get(KEY);
    return row ? c.open(row.value) : {};
  };
  return {
    enabled: (channel) => current()[channel]?.enabled === true,
    version: (channel) => current()[channel]?.version || '',
  };
}
module.exports = { createNotificationChannelProjection };
