const {
  STAFF_EVENTS,
  APPOINTMENT_EVENTS,
  storedEvents,
  channelEnabled,
} = require('./staff-event-preferences.cjs');
function resetStaffNotificationInterest(db, org = '') {
  for (const channel of ['telegram', 'max']) {
    const namespace = `staff-interest-v1:${channel}:`;
    const ranges = org
      ? ['delivery', 'appointment', ...STAFF_EVENTS].map(
          (kind) => namespace + kind + ':' + JSON.stringify([org]).slice(0, -1) + ',',
        )
      : [namespace];
    for (const start of ranges)
      db.prepare('DELETE FROM telegram_runtime WHERE key>=? AND key<?').run(
        start,
        start + '\uffff',
      );
  }
  for (const channel of ['telegram', 'max']) {
    const namespace = `staff-selftest-v1:${channel}:`,
      table = channel === 'max' ? 'staff_max_jobs' : 'staff_notification_jobs';
    if (!org)
      db.prepare('DELETE FROM telegram_runtime WHERE key>=? AND key<?').run(
        namespace,
        namespace + '\uffff',
      );
    else if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
      db.prepare(
        `DELETE FROM telegram_runtime WHERE key>=? AND key<? AND substr(key,?) IN (SELECT id FROM ${table} WHERE organization_id=?)`,
      ).run(namespace, namespace + '\uffff', namespace.length + 1, org);
  }
}
// Derived, nonclinical interest keys use the existing indexed runtime table. The
// encrypted links remain authoritative; this index only avoids idle cabinet work.
function createStaffNotificationInterest(c, channel) {
  const { db, open, seal, transaction } = c;
  if (!['telegram', 'max'].includes(channel)) throw Error('Unknown staff notification channel.');
  const table = channel === 'max' ? 'staff_max_links' : 'staff_telegram_links';
  const namespace = `staff-interest-v1:${channel}:`,
    readyKey = namespace + 'ready';
  const prefix = (kind) => namespace + kind + ':';
  const seekOrganization = db.prepare(
    'SELECT key FROM telegram_runtime WHERE key>=? AND key<? ORDER BY key LIMIT 1',
  );
  const probes = new Map();
  const ready = () =>
    Boolean(db.prepare('SELECT 1 FROM telegram_runtime WHERE key=?').get(readyKey));
  function update(org, account, link) {
    const suffix = JSON.stringify([org, account]);
    const kinds = ['delivery', 'appointment', ...STAFF_EVENTS];
    const remove = db.prepare('DELETE FROM telegram_runtime WHERE key=?');
    for (const kind of kinds) remove.run(prefix(kind) + suffix);
    if (!link?.enabled) return;
    const events = storedEvents(link);
    if (events.length) events.push('delivery');
    if (events.some((event) => APPOINTMENT_EVENTS.includes(event))) events.push('appointment');
    const insert = db.prepare('INSERT OR REPLACE INTO telegram_runtime(key,value) VALUES(?,?)');
    for (const kind of events) insert.run(prefix(kind) + suffix, seal({ active: true }));
  }
  function ensure() {
    if (!channelEnabled(c, channel) || ready()) return;
    const build = () => {
      if (ready()) return;
      db.prepare('DELETE FROM telegram_runtime WHERE key>=? AND key<?').run(
        namespace,
        namespace + '\uffff',
      );
      // Once per database/channel, only on an enabled channel. Never opens cabinets.
      for (const row of db.prepare(`SELECT organization_id,account_id,value FROM ${table}`).all())
        update(row.organization_id, row.account_id, open(row.value));
      db.prepare('INSERT INTO telegram_runtime(key,value) VALUES(?,?)').run(
        readyKey,
        seal({ version: 1 }),
      );
    };
    if (db.isTransaction) build();
    else transaction(build);
  }
  function query(kind, org = null, staffId = null, cursor = '', limit = 0, probe = false) {
    const start = prefix(kind),
      offset = start.length + 1;
    const range = org === null ? start : start + JSON.stringify([org]).slice(0, -1) + ',';
    const values = [offset, offset, range, range + '\uffff'];
    let condition = '';
    if (staffId !== null) {
      condition += " AND (m.role IN ('owner','salon_admin') OR m.account_id=?)";
      values.push(staffId);
    }
    if (org === null) {
      condition += ' AND l.organization_id>?';
      values.push(cursor);
    }
    if (limit && !probe) values.push(limit);
    const select = probe
      ? '1'
      : limit
        ? 'DISTINCT l.organization_id id'
        : 'l.account_id,m.role,l.value';
    const sql = `SELECT ${select} FROM telegram_runtime r
      CROSS JOIN ${table} l ON l.organization_id=json_extract(substr(r.key,?), '$[0]') AND l.account_id=json_extract(substr(r.key,?), '$[1]')
      CROSS JOIN memberships m ON m.organization_id=l.organization_id AND m.account_id=l.account_id
      CROSS JOIN accounts a ON a.id=m.account_id CROSS JOIN organizations o ON o.id=l.organization_id
      WHERE r.key>=? AND r.key<? AND m.status='active' AND a.status='active' AND o.status='active'${condition}
      ${probe ? 'LIMIT 1' : limit ? 'ORDER BY l.organization_id LIMIT ?' : ''}`;
    if (!probe) return db.prepare(sql).all(...values);
    const shape = (org === null ? 'global' : 'organization') + (staffId === null ? '' : ':staff');
    if (!probes.has(shape)) probes.set(shape, db.prepare(sql));
    return probes.get(shape).all(...values);
  }
  function rows(org, staffId, event) {
    if (!channelEnabled(c, channel)) return [];
    if (ready()) return query(event, org, staffId);
    // A process can start while globally off, then receive a mutation before its
    // first runtime tick. Be conservative until ensure() builds the durable index.
    return db
      .prepare(
        `SELECT m.account_id,m.role,l.value FROM memberships m JOIN accounts a ON a.id=m.account_id
      JOIN ${table} l ON l.organization_id=m.organization_id AND l.account_id=m.account_id
      WHERE m.organization_id=? AND m.status='active' AND a.status='active'${staffId === null ? '' : " AND (m.role IN ('owner','salon_admin') OR m.account_id=?)"}`,
      )
      .all(...(staffId === null ? [org] : [org, staffId]));
  }
  function hasAppointments(org) {
    if (!channelEnabled(c, channel)) return false;
    if (ready()) return query('appointment', org, null, '', 1, true).length > 0;
    return rows(org, null, 'appointment').some((row) => {
      const link = open(row.value);
      return link.enabled && storedEvents(link).some((event) => APPOINTMENT_EVENTS.includes(event));
    });
  }
  function hasEnabledRecipients() {
    if (!channelEnabled(c, channel)) return false;
    ensure();
    return query('delivery', null, null, '', 1, true).length > 0;
  }
  function organizations(cursor, limit) {
    if (!channelEnabled(c, channel)) return [];
    ensure();
    return query('appointment', null, null, cursor, limit).map((row) => row.id);
  }
  function organizationPage(cursor = '', limit = 5) {
    if (typeof cursor !== 'string' || !Number.isSafeInteger(limit) || limit < 1 || limit > 25)
      throw Error('Invalid staff notification interest page.');
    if (!channelEnabled(c, channel)) return { organizations: [], cursor: '' };
    ensure();
    const start = prefix('appointment');
    const boundary = (org) => start + JSON.stringify([org]).slice(0, -1) + ',\uffff';
    let lower = cursor ? boundary(cursor) : start;
    const organizations = [];
    let last = '';
    for (let i = 0; i < limit; i++) {
      const row = seekOrganization.get(lower, start + '\uffff');
      if (!row) return { organizations, cursor: '' };
      let pair;
      try {
        pair = JSON.parse(row.key.slice(start.length));
      } catch {
        throw Error('Invalid staff notification interest marker.');
      }
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        typeof pair[0] !== 'string' ||
        !pair[0] ||
        typeof pair[1] !== 'string' ||
        row.key !== start + JSON.stringify(pair)
      )
        throw Error('Invalid staff notification interest marker.');
      const next = boundary(pair[0]);
      // SQLite BINARY compares UTF-8 bytes; JS string ordering differs for some
      // Unicode IDs. Never continue from a noncanonical or nonprogressing hint.
      if (Buffer.compare(Buffer.from(next), Buffer.from(row.key)) <= 0)
        throw Error('Invalid staff notification interest marker.');
      if (hasAppointments(pair[0])) organizations.push(pair[0]);
      last = pair[0];
      lower = next;
    }
    return { organizations, cursor: last };
  }
  ensure();
  return { update, rows, hasAppointments, hasEnabledRecipients, organizations, organizationPage };
}
module.exports = { createStaffNotificationInterest, resetStaffNotificationInterest };
