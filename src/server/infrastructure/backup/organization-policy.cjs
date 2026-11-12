const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openValue, readKey } = require('./snapshot.cjs');
const { tables, columns } = require('./organization-inventory.cjs');
const { createPatientRecords } = require('../cabinet-records.cjs');
const publicLinks = require('../booking-public-links-schema.cjs');
const assistantRows = require('../../modules/assistant/access/row-schema.cjs');
const { personalCollection } = require('../../../shared/personal-calendar.cjs');

// Unknown organization-scoped tables fail closed instead of silently omitting new features.
const restoreTables = new Set([
  'appointment_manual_confirmations',
  'work_schedule_days',
  'booking_requests',
  'telegram_jobs',
  'telegram_confirmations',
  'notification_jobs',
  'notification_channel_jobs',
  'notification_confirmations',
]);
const preserveTables = new Set([
  'booking_public_links',
  'memberships',
  'subscriptions',
  'platform_audit',
  'support_requests',
  'work_schedule_profiles',
  'staff_telegram_links',
  'staff_max_links',
  'telegram_settings',
  'telegram_links',
  'max_client_links',
  'notification_preferences',
  // Financial state stays current when only clinical/calendar data is recovered.
  'billing_organization_settings',
  'billing_wallets',
  'billing_reservations',
  'billing_entries',
  'billing_service_connections',
  'billing_customer_operations',
  'billing_package_grants',
  'billing_package_tasks',
  'billing_payment_orders',
  'billing_financial_actions',
  // A selective clinical restore must never resurrect historical pilot access,
  // rewind current usage, or discard still-accounted provider reservations.
  'assistant_grants',
  'assistant_reservations',
]);
const revokeTables = new Set([
  'platform_sessions',
  'invitations',
  'email_invitations',
  'telegram_link_tokens',
  'staff_telegram_tokens',
  'staff_notification_jobs',
  'max_client_tokens',
  'staff_max_tokens',
  'staff_max_jobs',
  'staff_push_devices',
  'staff_push_jobs',
  'notification_schedule',
  'notification_schedule_dirty',
  'notification_schedule_intents',
]);
function tablePolicy(db) {
  return tables(db)
    .filter((table) => columns(db, table.name).includes('organization_id'))
    .map(({ name }) => {
      const mode = restoreTables.has(name)
        ? 'restore'
        : preserveTables.has(name)
          ? 'preserve'
          : revokeTables.has(name)
            ? 'revoke'
            : null;
      if (!mode) throw Error('Unclassified organization-scoped table.');
      return { name, mode };
    });
}
function organizationContext(current, historical, organizationId) {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(organizationId || ''))
    throw Error('Invalid organization identifier.');
  const currentKey = readKey(path.join(current, 'platform', 'platform.key'));
  const oldKey = readKey(path.join(historical, 'platform', 'platform.key'));
  // HMAC indexes depend on this key, not just ciphertext. Key rotation requires a separate migration.
  if (!currentKey.equals(oldKey))
    throw Error('Platform key changed; explicit key migration required.');
  const now = new DatabaseSync(path.join(current, 'platform', 'platform.sqlite'), {
    readOnly: true,
  });
  const old = new DatabaseSync(path.join(historical, 'platform', 'platform.sqlite'), {
    readOnly: true,
  });
  try {
    const version = now.prepare('PRAGMA user_version').get().user_version;
    if (
      ![11, 12, 13, 14, 15, 16, 17, 18, 19, 20].includes(version) ||
      version !== old.prepare('PRAGMA user_version').get().user_version
    )
      throw Error('Restore requires equal supported platform schemas.');
    const readOrg = (db) => {
      const row = db.prepare('SELECT value FROM organizations WHERE id=?').get(organizationId);
      if (!row) throw Error('Organization must exist in both snapshots.');
      return JSON.parse(openValue(currentKey, row.value).toString('utf8'));
    };
    const liveOrg = readOrg(now),
      oldOrg = readOrg(old);
    personalCollection(liveOrg.personalEvents);
    const historicalPersonal = personalCollection(oldOrg.personalEvents);
    if (liveOrg.legacyData || oldOrg.legacyData)
      throw Error('Shared legacy cabinet needs an explicit recovery plan.');
    // Keep the current identity/profile. Do not reinterpret recovered times or room assignments.
    for (const field of ['timeZone', 'workspace'])
      if (JSON.stringify(liveOrg[field] ?? null) !== JSON.stringify(oldOrg[field] ?? null))
        throw Error('Time zone or workspace changed; resolve the recovery conflict first.');
    const root = 'tenants/' + organizationId;
    if (
      !fs.existsSync(path.join(current, root, 'cabinet.sqlite')) ||
      !fs.existsSync(path.join(historical, root, 'cabinet.sqlite'))
    )
      throw Error('An initialized organization cabinet is required.');
    const currentLinks = publicLinks.validate(now),
      historicalLinks = publicLinks.validate(old);
    if (!currentLinks && historicalLinks)
      throw Error('Prepare current public booking links component before organization restore.');
    if (historicalLinks) {
      const existing = now.prepare(
        'SELECT code,organization_id,staff_id FROM booking_public_links WHERE code=? OR (organization_id=? AND staff_id=?)',
      );
      for (const link of old
        .prepare(
          'SELECT code,organization_id,staff_id FROM booking_public_links WHERE organization_id=?',
        )
        .iterate(organizationId))
        for (const live of existing.all(link.code, link.organization_id, link.staff_id))
          if (
            live.code !== link.code ||
            live.organization_id !== link.organization_id ||
            live.staff_id !== link.staff_id
          )
            throw Error('Public booking link identity conflicts with current mappings.');
    }
    const policy = tablePolicy(now);
    const currentAssistant = assistantRows.validate(now),
      historicalAssistant = assistantRows.validate(old);
    if (!currentAssistant && historicalAssistant)
      throw Error('Prepare current assistant rows before organization restore.');
    // Public identities always come from the current snapshot. Historical copies
    // from before component-v1 legitimately lack this preserve-only table.
    const assistantPreserved = new Set(assistantRows.tables);
    const comparable = (items) =>
      items.filter(({ name }) => name !== 'booking_public_links' && !assistantPreserved.has(name));
    if (JSON.stringify(comparable(policy)) !== JSON.stringify(comparable(tablePolicy(old))))
      throw Error('Table policies differ.');
    const members = new Set(
      now
        .prepare('SELECT account_id FROM memberships WHERE organization_id=?')
        .all(organizationId)
        .map((row) => row.account_id),
    );
    const cabinet = new DatabaseSync(path.join(historical, root, 'cabinet.sqlite'), {
      readOnly: true,
    });
    try {
      const key = readKey(path.join(historical, root, 'encryption.key'));
      const checkMember = (id) => {
        if (id && !members.has(id))
          throw Error('Historical staff reference is no longer a member.');
      };
      for (const event of historicalPersonal.events) checkMember(event.staffId);
      const decode = (value) => JSON.parse(openValue(key, value).toString('utf8'));
      const records = createPatientRecords({ db: cabinet, decode });
      for (const row of cabinet.prepare('SELECT id,value FROM patients').iterate()) {
        const patient = records ? records.hydrate([row])[0] : decode(row.value);
        checkMember(patient.createdBy);
        for (const record of [...(patient.visits || []), ...(patient.appointments || [])])
          checkMember(record.staffId);
      }
      for (const { name, mode } of policy) {
        if (mode !== 'restore') continue;
        const names = columns(old, name);
        for (const column of ['staff_id', 'account_id'])
          if (names.includes(column))
            for (const row of old
              .prepare(`SELECT ${column} id FROM ${name} WHERE organization_id=?`)
              .iterate(organizationId))
              checkMember(row.id);
      }
    } finally {
      cabinet.close();
    }
    return { root, version, policy };
  } finally {
    old.close();
    now.close();
  }
}
module.exports = { organizationContext };
