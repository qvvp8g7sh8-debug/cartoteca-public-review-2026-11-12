const { randomUUID } = require('node:crypto');
const { createReadVersion } = require('../../infrastructure/read-version.cjs');
const CHANNELS = ['telegram', 'max', 'push'];
const KEY = 'notification-channel-state-v1';
// Configuration is process-wide; temporary transport failures never change epochs.
function createNotificationChannelState(c, configured = null) {
  if (!configured) return { enabled: () => true, version: () => '' };
  if (configured.passive) return { enabled: () => false, version: () => '' };
  const flags = Object.fromEntries(
    CHANNELS.map((channel) => [channel, configured[channel] === true]),
  );
  const read = c.db.prepare('SELECT value FROM telegram_runtime WHERE key=?');
  const readVersion = createReadVersion(c.db);
  const tables = new Set(
    c.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name),
  );
  let cached, dataVersion, localVersion;
  function current() {
    if (c.db.isTransaction) {
      // Keep every guarded check fresh, including this transaction's own change.
      // Uncommitted rows and counters never replace the outside committed cache.
      const row = read.get(KEY);
      return row ? c.open(row.value) : {};
    }
    const [, revision, changes] = readVersion();
    if (!cached || revision !== dataVersion || changes !== localVersion) {
      const row = read.get(KEY);
      cached = row ? c.open(row.value) : {};
      dataVersion = revision;
      localVersion = changes;
    }
    return cached;
  }
  function cancel(channel) {
    if (channel !== 'push')
      c.db
        .prepare('DELETE FROM telegram_runtime WHERE key GLOB ?')
        .run('staff-selftest-v1:' + channel + ':*');
    if (tables.has('notification_channel_jobs') && channel !== 'push')
      c.db
        .prepare(
          "UPDATE notification_channel_jobs SET status='cancelled',lease_until=0 WHERE channel=? AND status IN ('pending','reserved')",
        )
        .run(channel);
    const queue =
      channel === 'telegram'
        ? ['telegram_jobs', 'staff_notification_jobs']
        : channel === 'max'
          ? ['staff_max_jobs']
          : ['staff_push_jobs'];
    for (const table of queue) {
      if (!tables.has(table)) continue;
      // Sending/uncertain work is never relabelled: its outcome may already be external.
      c.db.prepare('UPDATE ' + table + " SET status='cancelled' WHERE status='pending'").run();
    }
  }
  c.transaction(() => {
    const previous = current(),
      next = { ...previous };
    let changed = false;
    for (const channel of CHANNELS) {
      const before = previous[channel],
        enabled = flags[channel];
      if (before && before.enabled === enabled) continue;
      next[channel] = { enabled, version: !before && enabled ? '' : randomUUID() };
      changed = true;
      if (!enabled) cancel(channel);
    }
    if (changed)
      c.db
        .prepare('INSERT OR REPLACE INTO telegram_runtime(key,value) VALUES(?,?)')
        .run(KEY, c.seal(next));
    cached = next;
  });
  return {
    enabled: (channel) => flags[channel] === true && current()[channel]?.enabled === true,
    version: (channel) => current()[channel]?.version || '',
  };
}
module.exports = { createNotificationChannelState };
