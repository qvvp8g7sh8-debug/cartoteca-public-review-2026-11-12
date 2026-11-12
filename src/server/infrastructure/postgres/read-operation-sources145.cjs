const { calendarPeriod } = require('../../modules/cabinet/queries.cjs');
const organizationTables = Object.freeze([
  'subscriptions',
  'telegram_settings',
  'telegram_links',
  'telegram_confirmations',
  'telegram_jobs',
  'appointment_manual_confirmations',
  'notification_confirmations',
  'notification_channel_jobs',
  'max_client_links',
  'memberships',
]);
function operationSources(operation, { current, url, hash, platformOnly = false }) {
  const result = [],
    org = current.organizationId;
  const add = (scope, catalog, table, where, values = []) => {
    if (catalog.tables[table]) result.push({ scope, catalog, table, where, values });
  };
  const p = operation.platform,
    pc = operation.platformCatalog,
    c = operation.scope,
    cc = operation.cabinetCatalog;
  add(p, pc, 'organizations', 's.id=$2', [org]);
  if (url.pathname === '/api/cabinet/patient' && url.searchParams.get('view') === 'appointment') {
    const { patientId, id } =
      require('../../modules/cabinet/appointment-edit161.cjs').editSelection(url);
    const details = url.searchParams.get('details') === '1';
    if (details) {
      const broad = new URL(url);
      broad.searchParams.delete('view');
      result.push(
        ...operationSources(operation, { current, url: broad, hash, platformOnly: true }).filter(
          (source) => source.table !== 'organizations',
        ),
      );
    }
    add(
      c,
      cc,
      'meta',
      details
        ? "s.key IN ('revision','initialized') OR s.key LIKE 'booking-accepted:%'"
        : "s.key IN ('revision','initialized')",
    );
    add(c, cc, 'patients', 's.id=$2', [patientId]);
    add(c, cc, 'cabinet_patient_records', "s.patient_id=$2 AND s.kind='appointment' AND s.id=$3", [
      patientId,
      id,
    ]);
    return result;
  }
  if (url.pathname !== '/api/cabinet/directory') {
    for (const table of organizationTables) add(p, pc, table, 's.organization_id=$2', [org]);
    add(
      p,
      pc,
      'accounts',
      's.id IN (SELECT account_id FROM cartoteca_platform.memberships WHERE _store_id=$1 AND organization_id=$2)',
      [org],
    );
    add(p, pc, 'telegram_runtime', "s.key='notification-channel-state-v1'");
    add(
      p,
      pc,
      'booking_requests',
      "s.organization_id=$2 AND s.status IN ('accepted','pending','requested','expired')",
      [org],
    );
  }
  if (platformOnly) return result;
  add(
    c,
    cc,
    'meta',
    url.pathname === '/api/cabinet/directory'
      ? "s.key IN ('revision','initialized')"
      : "s.key IN ('revision','initialized') OR s.key LIKE 'booking-accepted:%'",
  );
  if (url.pathname === '/api/cabinet/patient') {
    const id = url.searchParams.get('id');
    if (typeof id !== 'string' || !id || id.length > 120)
      throw Object.assign(Error('Укажите карточку.'), { status: 400 });
    add(c, cc, 'patients', 's.id=$2', [id]);
    add(c, cc, 'cabinet_patient_records', 's.patient_id=$2', [id]);
    // Notification canonical projections may reuse this exact patient in the
    // owning RR. Include its contact summary and appointment index as a bound.
    add(c, cc, 'cabinet_summaries', 's.patient_id=$2', [id]);
    add(c, cc, 'cabinet_appointments', 's.patient_id=$2', [id]);
  } else if (url.pathname === '/api/cabinet/directory') {
    const audience = current.role === 'cosmetologist' ? hash('staff:' + current.accountId) : '*';
    add(c, cc, 'cabinet_summaries', 's.audience=$2', [audience]);
  } else {
    const periods = [calendarPeriod(url)];
    if (url.searchParams.get('compact') === '1') {
      const month = new URL(url);
      month.searchParams.set('from', url.searchParams.get('monthFrom'));
      month.searchParams.set('to', url.searchParams.get('monthTo'));
      periods.push(calendarPeriod(month));
    }
    const days = new Set();
    for (const { from, to } of periods)
      for (
        let day = Date.parse(from + 'T00:00:00Z');
        day <= Date.parse(to + 'T00:00:00Z');
        day += 86400000
      )
        days.add(hash('day:' + new Date(day).toISOString().slice(0, 10)));
    const keys = [...days];
    add(c, cc, 'cabinet_days', 's.day_hash=ANY($2::text[])', [keys]);
    add(
      c,
      cc,
      'cabinet_appointments',
      's.id IN (SELECT appointment_id FROM cartoteca_cabinet.cabinet_days WHERE _store_id=$1 AND day_hash=ANY($2::text[]))',
      [keys],
    );
    add(
      c,
      cc,
      'cabinet_summaries',
      "s.audience='*' AND s.patient_id IN (SELECT a.patient_id FROM cartoteca_cabinet.cabinet_appointments a JOIN cartoteca_cabinet.cabinet_days d ON d._store_id=a._store_id AND d.appointment_id=a.id WHERE a._store_id=$1 AND d.day_hash=ANY($2::text[]))",
      [keys],
    );
  }
  return result;
}
module.exports = { operationSources };
