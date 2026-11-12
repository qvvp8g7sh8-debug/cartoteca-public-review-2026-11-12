const { clientNotificationEvents } = require('./appointments.cjs');
const PREFIX = 'client-interest-v1:';
// Derived lookup only: encrypted settings remain authoritative at enqueue/send.
function createClientNotificationInterest(c) {
  const { db, seal, open } = c;
  const enabled = (channel) => c.notificationChannels?.enabled?.(channel) !== false;
  const marker = (org, kind) => PREFIX + kind + ':' + org;
  const ready = db.prepare('SELECT 1 FROM telegram_runtime WHERE key=?');
  function expectedKeys(org, settings) {
    if (settings.enabled === false || settings.restoredPaused === true) return [];
    const selected = clientNotificationEvents(settings.events);
    return [
      ...(selected.length ? ['all'] : []),
      ...(selected.includes('reminder') ? ['reminder'] : []),
      ...(selected.some((kind) => kind !== 'reminder') ? ['lifecycle'] : []),
    ].map((kind) => marker(org, kind));
  }
  function update(org, settings) {
    db.prepare('DELETE FROM telegram_runtime WHERE key IN (?,?,?)').run(
      marker(org, 'all'),
      marker(org, 'reminder'),
      marker(org, 'lifecycle'),
    );
    const insert = db.prepare('INSERT OR REPLACE INTO telegram_runtime VALUES(?,?)');
    for (const key of expectedKeys(org, settings)) insert.run(key, seal({ active: true }));
  }
  function touch(org) {
    const row = db.prepare('SELECT value FROM telegram_settings WHERE organization_id=?').get(org);
    const settings = row ? open(row.value) : {};
    update(org, { ...settings, enabled: settings.restoredPaused !== true });
  }
  const ensure = require('./client-interest-bootstrap.cjs').createClientInterestBootstrap(
    c,
    expectedKeys,
  );
  function query(channels, kind, org = '', cursor = '', limit = 0) {
    if (
      !['all', 'reminder', 'lifecycle'].includes(kind) ||
      !Array.isArray(channels) ||
      channels.some((channel) => !['telegram', 'max'].includes(channel))
    )
      throw Error('Invalid client notification interest.');
    const selected = [...new Set(channels)].filter(enabled);
    if (!selected.length) return [];
    const prefix = PREFIX + kind + ':';
    const bindings = selected
      .map((channel) => {
        const table = channel === 'telegram' ? 'telegram_links' : 'max_client_links';
        return `EXISTS(SELECT 1 FROM ${table} l WHERE l.organization_id=o.id)`;
      })
      .join(' OR ');
    // A scoped transaction cannot initialize a global derived projection. Read
    // only its authoritative organization, current bindings and encrypted flags.
    if (
      org &&
      ['COMPOUND', 'QUEUEORG'].includes(db.transactionIntent) &&
      !ready.get(PREFIX + 'ready')
    ) {
      const row = db
        .prepare(
          `SELECT s.value FROM organizations o
        LEFT JOIN telegram_settings s ON s.organization_id=o.id
        WHERE o.id=? AND o.status='active' AND (${bindings})`,
        )
        .get(org);
      if (!row) return [];
      const settings = row.value ? open(row.value) : {};
      return expectedKeys(org, { ...settings, enabled: settings.restoredPaused !== true }).includes(
        marker(org, kind),
      )
        ? [org]
        : [];
    }
    ensure();
    // Start at the marker's primary-key range: all-off is an empty range lookup,
    // independent of the number of old links or encrypted settings rows.
    return db
      .prepare(
        `SELECT o.id organization_id FROM telegram_runtime r
      CROSS JOIN organizations o ON o.id=substr(r.key,?)
      WHERE ${org ? 'r.key=?' : 'r.key>? AND r.key<?'} AND o.status='active'
        AND (${bindings}) ORDER BY r.key` + (limit ? ' LIMIT ?' : ''),
      )
      .all(
        prefix.length + 1,
        ...(org ? [prefix + org] : [prefix + cursor, prefix + '\uffff']),
        ...(limit ? [limit] : []),
      )
      .map((row) => row.organization_id);
  }
  return {
    update,
    touch,
    organizations: (channels, kind = 'all') => query(channels, kind),
    batch(cursor = '', limit = 25, channels = ['telegram', 'max'], kind = 'all') {
      if (typeof cursor !== 'string' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw Error('Invalid client notification interest page.');
      return query(channels, kind, '', cursor, limit);
    },
    has: (org = '', channels = ['telegram'], kind = 'reminder') =>
      query(channels, kind, org, '', 1).length > 0,
  };
}
module.exports = { createClientNotificationInterest };
