const path = require('node:path');
const crypto = require('node:crypto');
const { readKey, openValue } = require('../backup/snapshot.cjs');
const { readTypedRows } = require('./backup-rows.cjs');
const { digest } = require('./catalog-sqlite.cjs');
const assistantRows = require('../../modules/assistant/access/row-schema.cjs');
const { personalCollection } = require('../../../shared/personal-calendar.cjs');
const { updatePersonalVersions } = require('../../modules/calendar/personal-feed-state.cjs');
const { STAFF_EVENTS } = require('../../modules/notifications/staff-event-preferences.cjs');
const { EVENTS } = require('../../modules/notifications/push-validation.cjs');
const RESTORE = new Set([
  'appointment_manual_confirmations',
  'work_schedule_days',
  'booking_requests',
  'telegram_jobs',
  'telegram_confirmations',
  'notification_jobs',
  'notification_channel_jobs',
  'notification_confirmations',
]);
const PRESERVE = new Set([
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
  'assistant_grants',
  'assistant_reservations',
]);
const REVOKE = new Set([
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
const SPECIAL = new Set([
  'organizations',
  'work_schedule_profiles',
  'staff_telegram_links',
  'staff_max_links',
  'telegram_settings',
  'telegram_links',
  'max_client_links',
  'notification_preferences',
  'telegram_runtime',
]);
function tablePolicy(metadata) {
  return Object.values(metadata.tables)
    .filter((table) => table.columns.some((column) => column.name === 'organization_id'))
    .map((table) => {
      const mode = RESTORE.has(table.name)
        ? 'restore'
        : PRESERVE.has(table.name)
          ? 'preserve'
          : REVOKE.has(table.name)
            ? 'revoke'
            : null;
      if (!mode) throw Error('Unclassified organization-scoped PostgreSQL table.');
      return { name: table.name, mode };
    });
}
function modifiedTable(name, policy) {
  return SPECIAL.has(name) || policy.some((row) => row.name === name && row.mode !== 'preserve');
}
function rows(directory, store, name) {
  const table = store.metadata.tables[name],
    report = store.tables.find((row) => row.name === name);
  if (!table || !report) return (async function* () {})();
  return readTypedRows(path.join(directory, report.file), table);
}
async function first(directory, store, name, test) {
  for await (const row of rows(directory, store, name)) if (test(row)) return row;
  return null;
}
function decode(key, value) {
  return JSON.parse(openValue(key, value).toString('utf8'));
}
function seal(key, value) {
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
}
function interestPolicy(org, selfTests = new Set()) {
  return (key) => {
    if (selfTests.has(key)) return true;
    if (
      ['all', 'reminder', 'lifecycle'].some(
        (kind) => key === 'client-interest-v1:' + kind + ':' + org,
      )
    )
      return true;
    const tuple = JSON.stringify([org]).slice(0, -1) + ',';
    if (
      ['telegram', 'max'].some((channel) =>
        ['delivery', 'appointment', ...STAFF_EVENTS].some((kind) =>
          key.startsWith('staff-interest-v1:' + channel + ':' + kind + ':' + tuple),
        ),
      )
    )
      return true;
    return [...EVENTS, 'all', 'change'].some((kind) =>
      key.startsWith('push-interest-v1:' + kind + ':' + encodeURIComponent(org) + ':'),
    );
  };
}
async function context({
  source,
  recovered,
  before,
  historical,
  currentPlatform,
  currentCabinet,
  historicalPlatform,
  historicalCabinet,
  organizationId,
  client,
}) {
  const key = readKey(path.join(source, 'platform/platform.key'));
  if (!key.equals(readKey(path.join(recovered, 'platform/platform.key'))))
    throw Error('Platform key changed; explicit key migration required.');
  if (
    currentPlatform.metadata.version !== historicalPlatform.metadata.version ||
    digest(currentCabinet.metadata) !== digest(historicalCabinet.metadata)
  )
    throw Error(
      'Selective recovery requires compatible prepared platform and equal cabinet schemas.',
    );
  const policy = tablePolicy(currentPlatform.metadata),
    oldPolicy = tablePolicy(historicalPlatform.metadata);
  const preserved = new Set(assistantRows.tables);
  const comparable = (items) =>
    items.filter((row) => row.name !== 'booking_public_links' && !preserved.has(row.name));
  if (JSON.stringify(comparable(policy)) !== JSON.stringify(comparable(oldPolicy)))
    throw Error('Organization restore policies differ.');
  const live = await first(
    before,
    currentPlatform,
    'organizations',
    (row) => row.id === organizationId,
  );
  const old = await first(
    historical,
    historicalPlatform,
    'organizations',
    (row) => row.id === organizationId,
  );
  if (!live || !old) throw Error('Organization must exist in both snapshots.');
  const profile = decode(key, live.value),
    oldProfile = decode(key, old.value);
  if (profile.legacyData || oldProfile.legacyData)
    throw Error('Legacy shared cabinet requires an explicit recovery migration.');
  for (const field of ['timeZone', 'workspace'])
    if (JSON.stringify(profile[field] ?? null) !== JSON.stringify(oldProfile[field] ?? null))
      throw Error('Time zone or workspace changed.');
  const currentPersonal = personalCollection(profile.personalEvents),
    oldPersonal = personalCollection(oldProfile.personalEvents);
  const members = new Set();
  for await (const row of rows(before, currentPlatform, 'memberships'))
    if (row.organization_id === organizationId) members.add(row.account_id);
  const check = (id) => {
    if (id && !members.has(id)) throw Error('Historical staff reference is no longer a member.');
  };
  for (const event of oldPersonal.events) check(event.staffId);
  const cabinetKey = readKey(path.join(recovered, 'tenants', organizationId, 'encryption.key'));
  const patients = new Set();
  for await (const row of rows(historical, historicalCabinet, 'patients')) {
    const patient = decode(cabinetKey, row.value);
    if (!patient || patient.id !== row.id || patients.has(row.id))
      throw Error('Invalid historical patient.');
    patients.add(row.id);
    check(patient.createdBy);
    if (historicalCabinet.metadata.version === 2) {
      if ('visits' in patient || 'appointments' in patient)
        throw Error('Invalid historical canonical patient.');
    } else
      for (const item of [...(patient.visits || []), ...(patient.appointments || [])])
        check(item.staffId);
  }
  const positions = new Map();
  for await (const row of rows(historical, historicalCabinet, 'cabinet_patient_records')) {
    const value = decode(cabinetKey, row.value),
      id = row.patient_id + ':' + row.kind,
      position = BigInt(row.position);
    let sequence = positions.get(id);
    if (!sequence) {
      sequence = new Set();
      positions.set(id, sequence);
    }
    if (
      !patients.has(row.patient_id) ||
      !['appointment', 'visit'].includes(row.kind) ||
      value?.id !== row.id ||
      position < 0n ||
      position > BigInt(Number.MAX_SAFE_INTEGER) ||
      sequence.has(position)
    )
      throw Error('Invalid historical canonical record.');
    sequence.add(position);
    check(value.staffId);
  }
  for (const sequence of positions.values())
    for (let i = 0n; i < BigInt(sequence.size); i++)
      if (!sequence.has(i)) throw Error('Invalid historical canonical record order.');
  for (const item of policy)
    if (item.mode === 'restore')
      for await (const row of rows(historical, historicalPlatform, item.name)) {
        if (row.organization_id !== organizationId) continue;
        for (const field of ['staff_id', 'account_id'])
          if (Object.hasOwn(row, field)) check(row[field]);
      }
  if (historicalPlatform.metadata.tables.booking_public_links) {
    if (!currentPlatform.metadata.tables.booking_public_links)
      throw Error('Prepare current public booking identities first.');
    for await (const link of rows(historical, historicalPlatform, 'booking_public_links')) {
      if (link.organization_id !== organizationId) continue;
      const found = await client.query(
        'SELECT code,organization_id,staff_id FROM cartoteca_platform.booking_public_links WHERE _store_id=$1 AND (code=$2 OR (organization_id=$3 AND staff_id=$4))',
        [currentPlatform.storeId, link.code, organizationId, link.staff_id],
      );
      for (const liveLink of found.rows)
        if (
          liveLink.code !== link.code ||
          liveLink.organization_id !== link.organization_id ||
          liveLink.staff_id !== link.staff_id
        )
          throw Error('Public booking link identity conflicts.');
    }
  }
  const selfTests = new Set();
  for (const [channel, name] of [
    ['telegram', 'staff_notification_jobs'],
    ['max', 'staff_max_jobs'],
  ])
    for await (const row of rows(before, currentPlatform, name))
      selfTests.add('staff-selftest-v1:' + channel + ':' + row.id);
  let recoveredProfile = profile;
  if (profile.personalEvents !== undefined || oldProfile.personalEvents !== undefined) {
    const revision = Math.max(currentPersonal.revision, oldPersonal.revision) + 1;
    if (!Number.isSafeInteger(revision)) throw Error('Personal calendar revision overflow.');
    recoveredProfile = {
      ...updatePersonalVersions(profile, currentPersonal.events, oldPersonal.events),
      personalEvents: { ...oldPersonal, revision },
    };
  }
  return {
    key,
    patients,
    policy,
    profile: recoveredProfile,
    interest: interestPolicy(organizationId, selfTests),
  };
}
module.exports = { tablePolicy, modifiedTable, rows, first, decode, seal, interestPolicy, context };
