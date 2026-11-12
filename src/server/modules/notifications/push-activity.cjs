const { storedPreferences, EVENTS, CHANGE_EVENTS } = require('./push-validation.cjs');
const { createReadVersion } = require('../../infrastructure/read-version.cjs');
const PREFIX = 'push-interest-v1:';
const TYPES = [...EVENTS, 'all', 'change'];
const marker = (type, org, device) => PREFIX + type + ':' + encodeURIComponent(org) + ':' + device;
function resetPushNotificationInterest(db, org = '') {
  const remove = db.prepare('DELETE FROM telegram_runtime WHERE key>=? AND key<?');
  if (!org) remove.run(PREFIX, PREFIX + '\uffff');
  else
    for (const type of TYPES) {
      const prefix = marker(type, org, '');
      remove.run(prefix, prefix + '\uffff');
    }
}
// Derived markers are planning hints. Fresh queue validation remains authoritative.
function createPushActivity(c) {
  const { db, open, seal, transaction } = c;
  let runtimeEnabled = true,
    stamp = '',
    pendingTest = null;
  const ready = db.prepare('SELECT 1 FROM telegram_runtime WHERE key=?');
  const insert = db.prepare('INSERT OR REPLACE INTO telegram_runtime VALUES(?,?)');
  const remove = db.prepare('DELETE FROM telegram_runtime WHERE key=?');
  const readVersion = createReadVersion(db);
  const organizationCandidates = db.prepare(
    'SELECT id FROM organizations WHERE id>? ORDER BY id LIMIT ?',
  );
  const queries = new Map();
  const tests = db.prepare(
    "SELECT status,next_at,lease_until,expires_at FROM staff_push_jobs WHERE event_key NOT LIKE 'staff-push-event:%' AND expires_at>? AND status IN ('pending','sending') ORDER BY CASE WHEN status='sending' THEN lease_until ELSE next_at END LIMIT 1",
  );
  const runtimeAvailable = () =>
    runtimeEnabled && c.notificationChannels?.enabled('push') !== false;
  const channelVersion = () => c.notificationChannels?.version('push') || '';
  function write(org, device, value) {
    for (const type of TYPES) remove.run(marker(type, org, device));
    if (value?.enabled !== true) return;
    const selected = storedPreferences(value.preferences).events;
    const types = [
      ...selected,
      ...(selected.length ? ['all'] : []),
      ...(selected.some((type) => CHANGE_EVENTS.includes(type)) ? ['change'] : []),
    ];
    for (const type of types) insert.run(marker(type, org, device), seal({ active: true }));
  }
  function ensure() {
    if (ready.get(PREFIX + 'ready')) return;
    const build = () => {
      if (ready.get(PREFIX + 'ready')) return;
      for (const row of db.prepare('SELECT id,organization_id,value FROM staff_push_devices').all())
        write(row.organization_id, row.id, open(row.value));
      insert.run(PREFIX + 'ready', seal({ version: 1 }));
    };
    if (db.isTransaction) build();
    else transaction(build);
  }
  function query(org, event, cursor = '', limit = 1, list = false) {
    if (!runtimeAvailable()) return [];
    const type = event || 'all';
    if (!TYPES.includes(type)) throw Error('Invalid Push interest category.');
    if (['COMPOUND', 'QUEUEORG'].includes(db.transactionIntent) && !ready.get(PREFIX + 'ready')) {
      // A cabinet command may be the first Push reader after migration. Its
      // scope cannot rebuild global planning hints; use current owned rows.
      if (!org || list) throw Error('Scoped Push interest requires an organization.');
      return db
        .prepare(
          `SELECT d.value FROM staff_push_devices d
        JOIN organizations o ON o.id=d.organization_id AND o.status='active'
        JOIN memberships m ON m.organization_id=d.organization_id AND m.account_id=d.account_id
        JOIN accounts a ON a.id=d.account_id
        WHERE d.organization_id=? AND m.status='active' AND a.status='active'
          AND m.role IN ('owner','salon_admin','cosmetologist')`,
        )
        .all(org)
        .filter((row) => {
          const device = open(row.value);
          if (device.enabled !== true) return false;
          const events = storedPreferences(device.preferences).events;
          return type === 'all'
            ? events.length > 0
            : type === 'change'
              ? events.some((event) => CHANGE_EVENTS.includes(event))
              : events.includes(type);
        })
        .slice(0, limit);
    }
    ensure();
    const prefix = PREFIX + type + ':' + (org ? encodeURIComponent(org) + ':' : '');
    // CROSS JOIN fixes the indexed marker range as the driving table; devices
    // are PK lookups only, including when unrelated queues are being written.
    const id = org ? 'substr(r.key,?+1)' : "substr(r.key,?+instr(substr(r.key,?+1),':')+1)";
    const shape = (org ? 'organization' : 'global') + (list ? ':list' : ':exists');
    if (!queries.has(shape))
      queries.set(
        shape,
        db.prepare(
          (list ? 'SELECT DISTINCT d.organization_id' : 'SELECT 1') +
            ' FROM telegram_runtime r CROSS JOIN staff_push_devices d ON d.id=' +
            id +
            " CROSS JOIN organizations o ON o.id=d.organization_id AND o.status='active'" +
            " CROSS JOIN memberships m ON m.organization_id=d.organization_id AND m.account_id=d.account_id AND m.status='active' AND m.role IN ('owner','salon_admin','cosmetologist')" +
            " CROSS JOIN accounts a ON a.id=d.account_id AND a.status='active'" +
            " WHERE r.key>=? AND r.key<? AND (?='' OR d.organization_id=?) AND d.organization_id>?" +
            (list ? ' ORDER BY d.organization_id' : '') +
            ' LIMIT ?',
        ),
      );
    return queries
      .get(shape)
      .all(
        ...(org ? [prefix.length] : [prefix.length, prefix.length]),
        prefix,
        prefix + '\uffff',
        org,
        org,
        cursor,
        limit,
      );
  }
  function hasPendingTests(now = Date.now()) {
    if (!runtimeAvailable()) return false;
    const version = [...readVersion(), channelVersion()].join(':');
    if (version !== stamp) {
      pendingTest = null;
      stamp = version;
    }
    let candidate = pendingTest;
    if (!candidate || (candidate.row && candidate.row.expires_at <= now)) {
      candidate = { row: tests.get(now) || null };
      if (!db.isTransaction) pendingTest = candidate;
    }
    const row = candidate.row;
    return Boolean(row && (row.status === 'sending' ? row.lease_until : row.next_at) <= now);
  }
  function reminderOrganizationPage(cursor = '', limit = 10) {
    if (typeof cursor !== 'string' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw Error('Invalid Push interest organization page.');
    if (!runtimeAvailable()) return { organizations: [], cursor: '' };
    ensure();
    // Bound candidates, not matches. Inactive/empty organizations must still
    // advance the cursor without rescanning/sorting every device marker range.
    const candidates = organizationCandidates.all(cursor, limit);
    return {
      organizations: candidates
        .filter((row) => query(row.id, 'reminder').length > 0)
        .map((row) => row.id),
      cursor: candidates.length === limit ? candidates.at(-1).id : '',
    };
  }
  function reminderOrganizations() {
    const organizations = [];
    let cursor = '';
    do {
      const page = reminderOrganizationPage(cursor, 100);
      organizations.push(...page.organizations);
      cursor = page.cursor;
    } while (cursor);
    return organizations;
  }
  return {
    runtimeAvailable,
    channelVersion,
    hasPendingTests,
    setRuntimeAvailable(value) {
      runtimeEnabled = value === true;
      pendingTest = null;
    },
    hasEnabledEvents: (org = '', event = '') => query(org, event).length > 0,
    updateDeviceInterest(org, device, value) {
      if (!db.isTransaction) throw Error('Push interests must commit with device settings.');
      if (runtimeAvailable()) ensure();
      write(org, device, value);
    },
    reminderOrganizations,
    reminderOrganizationPage,
  };
}
module.exports = { createPushActivity, resetPushNotificationInterest };
