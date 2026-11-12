const { readSteps } = require('../read-steps.cjs');
const { fail } = require('../../../../shared/errors.cjs');
const { validAppointmentTime } = require('../../../../shared/appointment-time.cjs');
const { validDate, nextDate, minutes } = require('../../../../shared/work-schedule.cjs');
const { availableSlots } = require('../../booking/availability.cjs');
const { appointmentContext } = require('./availability-context.cjs');
const { dayAvailability } = require('./availability-day.cjs');
const { managementSource } = require('./appointments/appointment-management-references.cjs');
const {
  MAX_REPRESENTATIVE_SLOTS,
  representativeOptions,
  representativeSlots,
} = require('./representative-slots.cjs');
const MAX_DATE_DAYS = 7;
const MAX_DAYS = 31;
const MAX_SLOTS = 12;
const wallTime = (value) =>
  String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');

function bounds(values) {
  const from = values.from,
    to = values.to || from,
    start = values.time === undefined ? 0 : minutes(values.time),
    end = values.endTime === undefined ? 1440 : minutes(values.endTime, true);
  if (
    !validDate(from) ||
    !validDate(to) ||
    to < from ||
    (Date.parse(to) - Date.parse(from)) / 86400000 >= MAX_DAYS ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start >= end ||
    !Number.isSafeInteger(values.duration) ||
    values.duration < 5 ||
    values.duration > 1440 ||
    values.duration % 5
  )
    throw fail(400, 'Выберите период до 31 дня, время и длительность с шагом 5 минут.');
  return { from, to, start, end };
}
function selection(c, values) {
  return readSteps(function* () {
    const context = yield appointmentContext(c);
    if (
      !Array.isArray(values.staffIds) ||
      !values.staffIds.length ||
      values.staffIds.some((id) => !context.members.some((member) => member.accountId === id)) ||
      new Set(values.staffIds).size !== values.staffIds.length
    )
      throw fail(403, 'Выберите доступных специалистов этой организации.');
    const serviceIds = values.serviceIds || [];
    if (
      !Array.isArray(serviceIds) ||
      serviceIds.length > 10 ||
      new Set(serviceIds).size !== serviceIds.length ||
      serviceIds.some((id) => !context.services.some((service) => service.id === id))
    )
      throw fail(400, 'Уточните услуги в каталоге специалиста.');
    const staff = context.members.filter(
      (member) =>
        values.staffIds.includes(member.accountId) &&
        serviceIds.every((id) =>
          context.services.some(
            (service) => service.id === id && service.staffId === member.accountId,
          ),
        ),
    );
    return { ...context, staff, serviceIds };
  }).call(this);
}
function calculate(c, values, now, exact = false, excludedAppointmentId = '') {
  return readSteps(function* () {
    const { from, to, start, end } = bounds(values);
    const strategy = exact ? undefined : values.strategy;
    const allowClosedDay = exact && values.allowClosedDay === true;
    if (
      values.allowClosedDay === true &&
      (!exact || !['owner', 'salon_admin'].includes(c.current.role))
    )
      throw fail(403, 'Запись в неоткрытый день требует подтверждения администратора.');
    if (strategy !== undefined && !['representative', 'dates', 'day'].includes(strategy))
      throw fail(400, 'Уточните способ подбора свободного времени.');
    const representative = strategy === 'representative',
      dates = strategy === 'dates',
      day = strategy === 'day';
    if (
      ((representative || day) && from !== to) ||
      (day && values.staffIds?.length !== 1) ||
      (dates && (Date.parse(to) - Date.parse(from)) / 86400000 >= MAX_DATE_DAYS)
    )
      throw fail(400, 'Выберите один день для времени или не более семи дней для ближайших дат.');
    const representativeValues = representative ? representativeOptions(values) : null;
    const { staff, ownerId, serviceIds } = yield selection(c, values);
    if (day && staff.length !== 1) throw fail(400, 'Выберите услугу этого специалиста.');
    const maximum = representative || dates ? MAX_REPRESENTATIVE_SLOTS : MAX_SLOTS;
    const limit =
      Number.isSafeInteger(values.limit) && values.limit > 0
        ? Math.min(maximum, values.limit)
        : maximum;
    const org = c.current.organizationId;
    const timeZone = c.assistantReads
      ? yield c.assistantReads.timeZone()
      : c.platform.organizationTimeZone(org);
    if (exact && !validAppointmentTime(values.time))
      return {
        slots: [],
        availability: { from, to, timeZone, duration: values.duration, truncated: false },
      };
    const periodStart = from === '0001-01-01' ? from : nextDate(from, -1);
    const storage = c.tenantStore(org);
    // Occupancy omits patient contacts and personal-event comments, including shared-room staff.
    const snapshot = c.assistantReads
      ? yield c.assistantReads.availability({
          staffIds: staff.map((member) => member.accountId),
          from,
          to,
          now,
        })
      : null;
    const appointments = (
      snapshot
        ? snapshot.appointments
        : storage.indexes.appointments(periodStart, to, { includeNames: false })
    )
      .filter((row) => !excludedAppointmentId || row.id !== excludedAppointmentId)
      .map((row) => ({ ...row, staffId: row.staffId || ownerId }));
    const reservations = snapshot
      ? snapshot.reserves
      : c.platform.bookingRequests.reserves(org, periodStart, to, now);
    const personalEvents = snapshot
      ? snapshot.personalEvents
      : c.platform.personalEvents?.occupancy(org, periodStart, to) || [];
    const workspace = snapshot ? snapshot.settings : c.platform.workspaceSettings(org);
    const schedules = snapshot
      ? snapshot.schedules
      : new Map(
          staff.map((member) => [
            member.accountId,
            c.platform.workSchedules.view(c.token, member.accountId, from, to),
          ]),
        );
    if (day) {
      const staffId = staff[0].accountId;
      const schedule = schedules.get(staffId);
      const dayInfo = dayAvailability({
        date: from,
        staffId,
        schedule,
        closure: schedule.closures[from],
        workspace,
        appointments,
        reservations,
        personalEvents,
        duration: values.duration,
        timeZone,
        now,
        start,
        end,
      });
      c.assertCurrent?.();
      return {
        slots: [],
        availability: {
          from,
          to,
          timeZone,
          duration: values.duration,
          truncated: false,
          scheduleIncomplete: dayInfo.status === 'missing',
          dayInfo,
        },
      };
    }
    const slots = [];
    let truncated = false,
      scheduleIncomplete = false;
    for (let date = from; ; date = nextDate(date)) {
      const closure = schedules.values().next().value?.closures[date];
      // Only exact admission can carry a server-bound owner/admin consent.
      // It covers a closed day and an exact interval outside a working day's hours.
      const closedOverride = allowClosedDay;
      const dateSlots = availableSlots({
        date,
        duration: values.duration,
        staff,
        closure: closedOverride ? undefined : closure,
        dayAt(id) {
          const day = schedules.get(id).days[date];
          if (!day) scheduleIncomplete = true;
          // Execution still obtains the ordinary signed acknowledgement for the exact final tuple.
          if (closedOverride) return { status: 'working', intervals: [[wallTime(start), '24:00']] };
          if (day?.status !== 'working') return day;
          // New appointment starts follow the cabinet's five-minute grid; saved work hours stay intact.
          // Exact admission still accepts five-minute starts outside the displayed fifteen-minute grid.
          return {
            ...day,
            intervals: day.intervals
              .map(([fromTime, toTime]) => [
                wallTime(Math.ceil(Math.max(minutes(fromTime), exact ? start : 0) / 5) * 5),
                toTime,
              ])
              .filter(([fromTime, toTime]) => minutes(fromTime) < minutes(toTime, true)),
          };
        },
        workspace,
        ...(values.roomId ? { roomId: values.roomId } : {}),
        appointments,
        reservations,
        personalEvents,
        mode: 'any',
        minimumLeadMinutes: 0,
        timeZone,
        now,
      });
      for (const slot of dateSlots) {
        const value = minutes(slot.time);
        if (value < start || value + slot.duration > end || (exact && value !== start)) continue;
        if (!representative && slots.length >= limit) {
          truncated = true;
          break;
        }
        const member = staff.find((entry) => entry.accountId === slot.staffId);
        slots.push({
          ...slot,
          endTime: wallTime(value + slot.duration),
          staffName: member?.displayName || 'Специалист',
          ...(serviceIds.length ? { serviceIds: [...serviceIds] } : {}),
        });
        if (dates) break;
      }
      if (truncated || date === to) break;
    }
    const result = representative
      ? representativeSlots(slots, { duration: values.duration, ...representativeValues })
      : { slots, truncated };
    c.assertCurrent?.();
    return {
      slots: result.slots,
      availability: {
        from,
        to,
        timeZone,
        duration: values.duration,
        truncated: result.truncated,
        scheduleIncomplete,
      },
    };
  }).call(this);
}
function findAvailability(c, values, now = Date.now()) {
  return readSteps(function* () {
    return yield calculate(c, values, now);
  }).call(this);
}
function verifyAvailability(c, values, now = Date.now()) {
  return readSteps(function* () {
    const result = yield calculate(
      c,
      {
        ...values,
        from: values.date,
        to: values.date,
        staffIds: [values.staffId],
        limit: 1,
      },
      now,
      true,
    );
    return result.slots[0] || null;
  }).call(this);
}
function managementAvailability(c, values, identity, now, exact) {
  return readSteps(function* () {
    const source = yield managementSource(c, identity, now);
    if (
      (values.staffId && values.staffId !== source.staffId) ||
      (values.staffIds &&
        (values.staffIds.length !== 1 || values.staffIds[0] !== source.staffId)) ||
      values.duration !== source.duration ||
      values.serviceIds?.length
    )
      throw fail(400, 'Для переноса сохраните специалиста, услуги и длительность исходной записи.');
    const input = {
      ...values,
      duration: source.duration,
      staffIds: [source.staffId],
      serviceIds: [],
      ...(exact ? { from: values.date, to: values.date, limit: 1 } : {}),
    };
    return yield calculate(c, input, now, exact, source.appointment.id);
  }).call(this);
}
function findAppointmentMoveAvailability(c, values, identity, now = Date.now()) {
  return readSteps(function* () {
    return yield managementAvailability(c, values, identity, now, false);
  }).call(this);
}
function verifyAppointmentMoveAvailability(c, values, identity, now = Date.now()) {
  return readSteps(function* () {
    return (yield managementAvailability(c, values, identity, now, true)).slots[0] || null;
  }).call(this);
}
module.exports = {
  MAX_DAYS,
  MAX_SLOTS,
  MAX_DATE_DAYS,
  findAvailability,
  verifyAvailability,
  findAppointmentMoveAvailability,
  verifyAppointmentMoveAvailability,
};
