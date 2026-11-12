const { availableSlots } = require('./availability.cjs');
const { availableRooms } = require('../workspace/policy.cjs');
const { nextDate } = require('../../../shared/work-schedule.cjs');
const { duration } = require('../cabinet/validation.cjs');
const { serviceOwner } = require('../services/catalog.cjs');
const { dateInZone, hasFutureHours } = require('./schedule-state.cjs');
const { bookingTiming } = require('./timing.cjs');
const { effectiveStaffRules } = require('./staff-rules.cjs');
const { fail } = require('../../../shared/errors.cjs');

const issues = {
  awaiting_activation: [
    'График настроен — включите онлайн-запись',
    'После автоматического выключения запись включается только вручную.',
    'publication',
  ],
  no_staff: [
    'Нет принимающих сотрудников',
    'Разрешите сотруднику принимать по онлайн-записи.',
    'online',
  ],
  no_services: [
    'Нет услуг для записи',
    'Добавьте хотя бы одну услугу с длительностью.',
    'services',
  ],
  no_assignments: [
    'Нет услуг у принимающих сотрудников',
    'Добавьте услуги в личный каталог принимающего сотрудника.',
    'services',
  ],
  no_rooms: [
    'Нет доступного кабинета',
    'Назначьте принимающим сотрудникам действующий кабинет.',
    'workspace',
  ],
  no_working_days: [
    'Нет открытых рабочих дней',
    'Настройте будущие рабочие дни и часы приёма.',
    'schedule',
  ],
  no_slots: [
    'Нет свободного времени',
    'Откройте дополнительные часы или дни. Учитываются занятость, резервы, длительность услуги и минимум до визита.',
    'schedule',
  ],
};
const issue = (code) => {
  const [title, message, target] = issues[code];
  return { code, title, message, target };
};
// A read-only diagnostic, never an admission gate or a persisted enabled flag.
// Existence can be established with the shortest assigned service per provider.
// The same slot engine still checks every actual service selection on submission.
function bookingReadiness(
  platform,
  org,
  storage,
  now = Date.now(),
  catalog = storage.readServices(),
  snapshot = null,
) {
  const result = (problems, first = null) => ({
    available: problems.length === 0,
    issues: problems.map(issue),
    nextDate: first?.date || null,
    checkedAt: now,
  });
  const members = snapshot?.members ?? platform.onlineBooking.providers(org, []);
  const settings = snapshot?.settings ?? platform.onlineBooking.settings(org);
  const ownerId = snapshot?.ownerId ?? platform.serviceCatalog(org).ownerId;
  const prerequisites = [];
  if (!members.length) prerequisites.push('no_staff');
  if (!catalog.length) prerequisites.push('no_services');
  if (prerequisites.length) return result(prerequisites);
  const shortest = new Map();
  const memberIds = new Set(members.map((member) => member.accountId));
  for (const service of catalog) {
    const length = duration(service.duration ?? 60);
    const staffId = serviceOwner(service, ownerId);
    if (memberIds.has(staffId))
      shortest.set(staffId, Math.min(shortest.get(staffId) ?? Infinity, length));
  }
  if (!shortest.size) return result(['no_assignments']);
  const workspace = platform.workspaceSettings(org);
  const providers = members.filter((m) => shortest.has(m.accountId));
  const rulesByStaff = new Map(
    providers.map((member) => [member.accountId, effectiveStaffRules(settings, member.accountId)]),
  );
  const withRooms = new Set(
    providers.filter((m) => availableRooms(workspace, m.accountId).length).map((m) => m.accountId),
  );
  if (!withRooms.size) return result(['no_rooms']);
  const timeZone = snapshot?.timeZone ?? platform.organizationTimeZone(org);
  let working = false;
  let workingWithoutRoom = false;
  for (const group of platform.workSchedules.futureDays(
    org,
    providers.map((m) => m.accountId),
    dateInZone(now, timeZone),
  )) {
    if (group.closure?.status === 'closed') continue;
    const scheduled = providers.filter((m) =>
      hasFutureHours(group.date, group.days.get(m.accountId), timeZone, now),
    );
    if (scheduled.some((m) => !withRooms.has(m.accountId))) workingWithoutRoom = true;
    const candidates = scheduled.filter((m) => withRooms.has(m.accountId));
    if (!candidates.length) continue;
    working = true;
    const from = nextDate(group.date, -1);
    const appointments = bookingTiming(snapshot || {}, 'booking-occupancy', () =>
      storage.indexes.appointments(from, group.date, { includeNames: false }),
    );
    const reservations = bookingTiming(snapshot || {}, 'booking-occupancy', () =>
      platform.bookingRequests.reserves(org, from, group.date, now),
    );
    const personalEvents = platform.personalEvents?.occupancy(org, from, group.date) || [];
    for (const member of candidates) {
      const rules = rulesByStaff.get(member.accountId);
      const slots = bookingTiming(snapshot || {}, 'booking-slot-calculation', () =>
        availableSlots({
          date: group.date,
          duration: shortest.get(member.accountId),
          staff: [member],
          dayAt: (id) => group.days.get(id),
          closure: group.closure,
          workspace,
          appointments,
          personalEvents,
          reservations,
          mode: rules.mode,
          minimumLeadMinutes: rules.minimumLeadMinutes,
          timeZone,
          now,
        }),
      );
      if (slots.length) return result([], slots[0]);
    }
  }
  if (working) return result(workingWithoutRoom ? ['no_slots', 'no_rooms'] : ['no_slots']);
  return result([workingWithoutRoom ? 'no_rooms' : 'no_working_days']);
}
function privateHealthProjection(context, publication, now) {
  const health = publication.enabled
    ? bookingReadiness(
        context.platform,
        context.current.organizationId,
        context.tenantStore(context.current.organizationId),
        now,
      )
    : {
        available: false,
        issues:
          publication.disabledReason === 'no_working_days'
            ? [issue(publication.hasWorkingDays ? 'awaiting_activation' : 'no_working_days')]
            : [],
        nextDate: null,
        checkedAt: now,
      };
  return {
    ...health,
    canManage: true,
    enabled: publication.enabled,
    disabledReason: publication.disabledReason,
    hasWorkingDays: publication.hasWorkingDays,
    publication,
  };
}
function privateBookingHealth(context, now = Date.now()) {
  const { platform } = context;
  const pending = Symbol('publication repair');
  const cancelled = () => Boolean(context.req?.aborted || context.res?.destroyed);
  const assertCurrent = () => {
    if (cancelled()) throw fail(499, 'Запрос отменён.');
    context.assertCurrent?.();
  };
  function read(repairs) {
    const result = platform.withReadOnlySnapshot(() => {
      assertCurrent();
      const inspected = platform.bookingPublication.inspectView(context.token, now);
      if (!inspected.publication.canManage) return { canManage: false };
      if (inspected.needsLinks || inspected.needsReconcile) return pending;
      return privateHealthProjection(context, inspected.publication, now);
    });
    // A policy change committed during the snapshot must not publish its result.
    assertCurrent();
    if (result !== pending) return result;
    if (repairs >= 2) throw fail(503, 'Настройки изменились. Повторите проверку записи.');
    const repair = () => {
      assertCurrent();
      // This view rechecks actor/subscription/providers and owns link allocation.
      const current = platform.bookingPublication.view(context.token, now);
      if (current.canManage)
        platform.bookingPublication.reconcileInTransaction(context.current.organizationId, now);
    };
    // PG3 capability identifies the native owner; the rare repair retains its
    // GLOBAL writer and admin projections. SQLite keeps its synchronous writer.
    // Only acquisition may await/retry. Callback and COMMIT are never replayed.
    const resultOfRepair =
      platform.withAsyncCompoundMutation && platform.withAsyncWriteLock
        ? platform.withAsyncWriteLock(repair, { cancelled })
        : platform.withWriteLock(repair);
    return resultOfRepair && typeof resultOfRepair.then === 'function'
      ? resultOfRepair.then(() => read(repairs + 1))
      : read(repairs + 1);
  }
  return read(0);
}
function publicBookingHealth(health) {
  return {
    available: health.available,
    reason: health.issues[0]?.code || null,
    nextDate: health.nextDate,
    checkedAt: health.checkedAt,
  };
}
module.exports = {
  bookingReadiness,
  privateBookingHealth,
  publicBookingHealth,
};
