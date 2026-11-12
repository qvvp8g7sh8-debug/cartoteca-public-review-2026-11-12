const { fail } = require('../../../shared/errors.cjs');
const { validDate, nextDate } = require('../../../shared/work-schedule.cjs');
const { createOperationCabinet } = require('./read-operation-cabinet145.cjs');
const {
  assistantDirectory,
  assistantSummaries,
  validateIds,
} = require('./assistant-read-directory.cjs');

function period(from, to, maximum = 62) {
  if (
    !validDate(from) ||
    !validDate(to) ||
    from > to ||
    (Date.parse(to) - Date.parse(from)) / 86400000 > maximum
  )
    throw fail(400, 'Укажите ограниченный период календаря.');
}
function sources(env) {
  const { operation } = env;
  const all = [];
  return {
    all,
    platform(table, where, values = []) {
      all.push({
        scope: operation.platform,
        catalog: operation.platformCatalog,
        table,
        where,
        values,
      });
    },
    cabinet(table, where, values = []) {
      all.push({ scope: operation.scope, catalog: operation.cabinetCatalog, table, where, values });
    },
  };
}
function workspaceSources(plan, org) {
  plan.platform('organizations', 's.id=$2', [org]);
  plan.platform('memberships', 's.organization_id=$2', [org]);
  plan.platform(
    'accounts',
    's.id IN(SELECT account_id FROM cartoteca_platform.memberships WHERE _store_id=$1 AND organization_id=$2)',
    [org],
  );
}
function calendarSources(plan, prepared, from, to) {
  const days = [];
  for (let date = from; date <= to; date = nextDate(date)) days.push(prepared.hash('day:' + date));
  plan.cabinet('cabinet_days', 's.day_hash=ANY($2::text[])', [days]);
  plan.cabinet(
    'cabinet_appointments',
    's.id IN(SELECT appointment_id FROM cartoteca_cabinet.cabinet_days WHERE _store_id=$1 AND day_hash=ANY($2::text[]))',
    [days],
  );
  plan.cabinet(
    'cabinet_summaries',
    "s.audience='*' AND s.patient_id IN(SELECT a.patient_id FROM cartoteca_cabinet.cabinet_appointments a JOIN cartoteca_cabinet.cabinet_days d ON d._store_id=a._store_id AND d.appointment_id=a.id WHERE a._store_id=$1 AND d.day_hash=ANY($2::text[]))",
    [days],
  );
}
async function assistantProjection(env, kind, input) {
  const { operation, prepared, current } = env;
  const org = current.organizationId,
    platform = prepared.platform;
  if (kind === 'directory') return assistantDirectory(env, input);
  if (kind === 'summaries') {
    validateIds(input.ids, 12);
    const result = await assistantSummaries(env, input.ids);
    return input.predicate ? result.filter(input.predicate) : result;
  }
  const plan = sources(env);
  if (kind === 'timeZone' || kind === 'serviceGroups') {
    plan.platform('organizations', 's.id=$2', [org]);
    await operation.probe(plan.all);
    await prepared.db.prefetchAll(platform.organization.readRequests(org));
    if (kind === 'timeZone') return platform.organizationTimeZone(org);
    const query = prepared.db.prepare('SELECT value FROM organizations WHERE id=?');
    await prepared.db.prefetchAll([query.readRequest('get', [org])]);
    return platform.serviceGroups(org);
  }
  plan.cabinet('meta', "s.key IN('revision','initialized')");
  if (kind === 'appointmentContext' || kind === 'availability') workspaceSources(plan, org);
  if (kind === 'appointmentContext') plan.cabinet('services', 'TRUE');
  if (kind === 'selected') {
    validateIds(input.ids, 12);
    validateIds(input.serviceIds, 10);
    const visible = await assistantSummaries(env, input.ids);
    if (visible.length !== input.ids.length) throw fail(403, 'Карточка клиента недоступна.');
    plan.cabinet('patients', 's.id=ANY($2::text[])', [input.ids]);
    plan.cabinet('cabinet_patient_records', 's.patient_id=ANY($2::text[])', [input.ids]);
    plan.cabinet('services', 's.id=ANY($2::text[])', [input.serviceIds]);
  }
  let periodStart;
  if (kind === 'availability') {
    period(input.from, input.to, 30);
    validateIds(input.staffIds, 100);
    if (!Number.isSafeInteger(input.now) || input.now < 0)
      throw fail(400, 'Укажите специалистов и время проверки.');
    if (current.role === 'cosmetologist' && input.staffIds.some((id) => id !== current.accountId))
      throw fail(403, 'Недостаточно прав для этого графика.');
    periodStart = input.from === '0001-01-01' ? input.from : nextDate(input.from, -1);
    calendarSources(plan, prepared, periodStart, input.to);
    plan.platform('work_schedule_profiles', 's.organization_id=$2 AND s.staff_id=ANY($3::text[])', [
      org,
      [...input.staffIds, 'organization'],
    ]);
    plan.platform('work_schedule_days', 's.organization_id=$2 AND s.date BETWEEN $3 AND $4', [
      org,
      input.from,
      input.to,
    ]);
    plan.platform(
      'booking_requests',
      "s.organization_id=$2 AND s.status='pending' AND s.expires_at>$3",
      [org, input.now],
    );
  }
  if (kind === 'calendar') {
    period(input.from, input.to);
    if (input.options?.overview) {
      period(input.options.overview.from, input.options.overview.to);
      calendarSources(plan, prepared, input.options.overview.from, input.options.overview.to);
    }
    if (
      current.role === 'cosmetologist' &&
      input.options?.staffId !== current.accountId &&
      input.options?.projection !== 'occupancy'
    )
      throw fail(403, 'Недостаточно прав для этого календаря.');
    calendarSources(plan, prepared, input.from, input.to);
  }
  if (!['revision', 'appointmentContext', 'selected', 'availability', 'calendar'].includes(kind))
    throw fail(400, 'Неизвестная операция чтения помощника.');
  const bound = await operation.probe(plan.all);
  if (bound.rows > 50000) throw fail(503, 'Период содержит слишком много записей.');
  const storage = await createOperationCabinet({
    db: prepared.cabinetDb,
    encode: prepared.encode,
    decode: prepared.decode,
    hash: prepared.hash,
    directory: prepared.directory,
    readCacheBudget: prepared.readCacheBudget,
  });
  try {
    if (kind === 'revision') return storage.get('revision', 0);
    if (kind === 'selected') return await storage.readSelectedAsync(input.ids, input.serviceIds);
    if (kind === 'calendar')
      return await storage.calendarSnapshotAsync(input.from, input.to, input.options);
    const requests = [
      ...platform.organization.readRequests(org),
      ...platform.workspaceMembers.readRequests(org),
    ];
    if (kind === 'appointmentContext') {
      const query = prepared.cabinetDb.prepare('SELECT value FROM services ORDER BY rowid');
      await prepared.db.prefetchAll(requests);
      await prepared.cabinetDb.prefetchAll([query.readRequest('all', [])]);
      return {
        members: platform.workspaceMembers(org),
        services: query.all().map((row) => prepared.decode(row.value)),
      };
    }
    requests.push(...platform.workspaceSettings.readRequests(org));
    requests.push(
      ...platform.bookingRequests.reserves.readRequests(org, periodStart, input.to, input.now),
    );
    if (current.role === 'cosmetologist')
      requests.push(...platform.workspaceMembers.readRequests(org, current.accountId));
    for (const staffId of input.staffIds)
      requests.push(
        ...platform.workspaceIdentities.readRequests(org, staffId),
        ...platform.workSchedules.viewForActor.readRequests(current, staffId, input.from, input.to),
      );
    await prepared.db.prefetchAll(requests);
    const occupancy = await storage.calendarSnapshotAsync(periodStart, input.to, {
      projection: 'occupancy',
    });
    operation.assertActive();
    return {
      appointments: occupancy.appointments,
      personalEvents: platform.personalEvents.occupancy(org, periodStart, input.to),
      reserves: platform.bookingRequests.reserves(org, periodStart, input.to, input.now),
      settings: platform.workspaceSettings(org),
      schedules: new Map(
        input.staffIds.map((staffId) => [
          staffId,
          platform.workSchedules.viewForActor(current, staffId, input.from, input.to),
        ]),
      ),
      timeZone: platform.organizationTimeZone(org),
    };
  } finally {
    storage.close();
  }
}
module.exports = { assistantProjection };
