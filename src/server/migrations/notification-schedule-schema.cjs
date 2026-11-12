// Derived schedule only: delivery receipts, bindings and channel jobs stay unchanged.
const scheduleTables = `CREATE TABLE notification_schedule (
  kind TEXT NOT NULL CHECK(kind IN ('client','workday')),
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subject TEXT NOT NULL, entity TEXT NOT NULL, value BLOB NOT NULL,
  due_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, version TEXT NOT NULL,
  PRIMARY KEY(kind,organization_id,subject,entity));
  CREATE INDEX notification_schedule_due ON notification_schedule(kind,due_at);
  CREATE TABLE notification_schedule_dirty (
  kind TEXT NOT NULL CHECK(kind IN ('client','workday')),
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subject TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
  cursor TEXT NOT NULL DEFAULT '', PRIMARY KEY(kind,organization_id,subject));
  CREATE TABLE notification_schedule_intents (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lease_until INTEGER NOT NULL, value BLOB NOT NULL);
  CREATE INDEX notification_schedule_intent_expiry ON notification_schedule_intents(lease_until);`;

const dirty = (kind, org, subject = "''") =>
  `INSERT INTO notification_schedule_dirty(kind,organization_id,subject) VALUES('${kind}',${org},${subject})
  ON CONFLICT(kind,organization_id,subject) DO UPDATE SET version=version+1,cursor='';`;
const triggerNames = [];
function triggers() {
  triggerNames.length = 0;
  const sql = [];
  function trigger(table, event, body, suffix = '') {
    const name =
      'notification_schedule_' + table + '_' + event.split(' ')[0].toLowerCase() + suffix;
    triggerNames.push(name);
    sql.push(`CREATE TRIGGER ${name} AFTER ${event} ON ${table} BEGIN ${body} END;`);
  }
  for (const table of ['telegram_links', 'max_client_links'])
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      const row = event === 'DELETE' ? 'OLD' : 'NEW';
      trigger(table, event, dirty('client', row + '.organization_id', row + '.patient_id'));
    }
  // A removed manual/legacy confirmation can make a still-future reminder due
  // again. Inserted receipts are checked freshly and cannot authorize a resend.
  for (const table of [
    'appointment_manual_confirmations',
    'telegram_confirmations',
    'notification_confirmations',
  ])
    trigger(table, 'DELETE', dirty('client', 'OLD.organization_id', 'OLD.patient_id'));
  for (const table of ['telegram_settings', 'subscriptions', 'memberships'])
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      const org = (event === 'DELETE' ? 'OLD' : 'NEW') + '.organization_id';
      trigger(
        table,
        event,
        dirty('client', org) + (table === 'telegram_settings' ? '' : dirty('workday', org)),
      );
    }
  trigger(
    'organizations',
    'UPDATE OF value,status',
    dirty('client', 'NEW.id') + dirty('workday', 'NEW.id'),
  );
  trigger(
    'accounts',
    'UPDATE OF status',
    ['client', 'workday']
      .map(
        (kind) =>
          `INSERT INTO notification_schedule_dirty(kind,organization_id,subject)
      SELECT '${kind}',organization_id,'' FROM memberships WHERE account_id=NEW.id
      ON CONFLICT(kind,organization_id,subject) DO UPDATE SET version=version+1,cursor='';`,
      )
      .join(''),
  );
  for (const table of ['work_schedule_days', 'work_schedule_profiles', 'staff_push_devices'])
    for (const event of ['INSERT', 'UPDATE', 'DELETE'])
      trigger(
        table,
        event,
        dirty('workday', (event === 'DELETE' ? 'OLD' : 'NEW') + '.organization_id'),
      );
  // Once-only bootstrap. Subsequent reads use dirty/due indexes, not all organizations.
  sql.push(`INSERT INTO notification_schedule_dirty(kind,organization_id,subject)
    SELECT 'client',organization_id,'' FROM telegram_links
    UNION SELECT 'client',organization_id,'' FROM max_client_links;
    INSERT INTO notification_schedule_dirty(kind,organization_id,subject)
    SELECT DISTINCT 'workday',organization_id,'' FROM staff_push_devices;`);
  return sql.join('\n');
}
function dropTriggers() {
  if (!triggerNames.length) triggers();
  return triggerNames.map((name) => `DROP TRIGGER ${name};`).join('\n');
}
module.exports = { scheduleTables, triggers, dropTriggers };
