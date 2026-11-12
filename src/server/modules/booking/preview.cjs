const { availableSlots } = require('./availability.cjs');
const { validDate, nextDate } = require('../../../shared/work-schedule.cjs');
const { fail } = require('../../../shared/errors.cjs');
const { duration: serviceDuration } = require('../cabinet/validation.cjs');
const { bookingTiming } = require('./timing.cjs');
const { effectiveStaffRules } = require('./staff-rules.cjs');

function bookingPreview(platform, token, storage, values, now = Date.now(), internal = {}) {
  const actor = platform.onlineBooking.actor(token),
    org = actor.organizationId;
  return calculateBookingPreview(
    platform,
    org,
    storage,
    values,
    now,
    internal,
    (staffId) => platform.workSchedules.view(token, staffId, values.date, values.date),
    actor.role === 'cosmetologist' ? actor.accountId : null,
  );
}
// Server-only shared calculation, not an alternate HTTP authorization path.
function calculateBookingPreview(
  platform,
  org,
  storage,
  values,
  now,
  internal,
  scheduleFor,
  ownStaff = null,
  snapshot = null,
) {
  if (
    !values ||
    !validDate(values.date) ||
    !Array.isArray(values.serviceIds) ||
    !values.serviceIds.length ||
    values.serviceIds.length > 10 ||
    values.serviceIds.some((id) => typeof id !== 'string' || !id || id.length > 120) ||
    new Set(values.serviceIds).size !== values.serviceIds.length ||
    Object.keys(values).some((k) => !['date', 'serviceIds', 'staffId'].includes(k))
  )
    throw fail(400, 'Выберите дату и от одной до десяти услуг.');
  const services =
    snapshot?.services ??
    bookingTiming(
      snapshot || {},
      'booking-services',
      () => storage.readSelected([], values.serviceIds).services,
    );
  if (services.length !== values.serviceIds.length) throw fail(400, 'Одна из услуг недоступна.');
  // A fresh request-local memo lets the response reuse this validated selection.
  if (snapshot) snapshot.services = services;
  const duration = services.reduce(
    (sum, service) => sum + serviceDuration(service.duration ?? 60),
    0,
  );
  const settings = snapshot?.settings ?? platform.onlineBooking.settings(org);
  const providers = platform.onlineBooking
    .providers(org, values.serviceIds, services, snapshot || undefined)
    .filter(
      (m) =>
        (!ownStaff || m.accountId === ownStaff) &&
        (!values.staffId || m.accountId === values.staffId),
    );
  const rulesByStaff = Object.fromEntries(
    providers.map((member) => [member.accountId, effectiveStaffRules(settings, member.accountId)]),
  );
  const rules = providers.length === 1 ? rulesByStaff[providers[0].accountId] : null;
  const days = new Map();
  let closure;
  for (const member of providers) {
    const schedule = scheduleFor(member.accountId);
    days.set(member.accountId, schedule.days[values.date]);
    closure = schedule.closures[values.date];
  }
  const appointments = bookingTiming(snapshot || {}, 'booking-occupancy', () =>
    storage.indexes.appointments(nextDate(values.date, -1), values.date, { includeNames: false }),
  );
  const reservations = bookingTiming(snapshot || {}, 'booking-occupancy', () =>
    platform.bookingRequests.reserves(
      org,
      nextDate(values.date, -1),
      values.date,
      now,
      internal.excludeRequestId || '',
    ),
  );
  const slots = bookingTiming(snapshot || {}, 'booking-slot-calculation', () =>
    availableSlots({
      date: values.date,
      duration,
      staff: providers,
      closure,
      dayAt: (id) => days.get(id),
      workspace: platform.workspaceSettings(org),
      roomId: internal.roomId,
      appointments,
      personalEvents:
        platform.personalEvents?.occupancy(org, nextDate(values.date, -1), values.date) || [],
      reservations,
      mode: internal.mode || settings.mode,
      modeForStaff: (staffId) => internal.mode || rulesByStaff[staffId].mode,
      atTime: internal.atTime,
      minimumLeadMinutes: settings.minimumLeadMinutes,
      timeZone: snapshot?.timeZone ?? platform.organizationTimeZone(org),
      now,
    }),
  );
  return {
    duration,
    mode: rules?.mode || settings.mode,
    ...(rules ? { rules } : { rulesByStaff }),
    timeZone: snapshot?.timeZone ?? platform.organizationTimeZone(org),
    slots,
  };
}
module.exports = { bookingPreview, calculateBookingPreview };
