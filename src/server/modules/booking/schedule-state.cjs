const { startsAt } = require('../notifications/appointments.cjs');
const { nextDate } = require('../../../shared/work-schedule.cjs');

const dateFormatters = new Map();
function dateInZone(now, timeZone) {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    if (dateFormatters.size >= 64) dateFormatters.delete(dateFormatters.keys().next().value);
    dateFormatters.set(timeZone, formatter);
  }
  // Cache the formatter, not the date: midnight/DST remain evaluated every time.
  const parts = formatter.formatToParts(new Date(now));
  return ['year', 'month', 'day'].map((type) => parts.find((p) => p.type === type).value).join('-');
}
function hasFutureHours(date, day, timeZone, now) {
  return (
    day?.status === 'working' &&
    day.intervals.some(
      ([, to]) =>
        startsAt(
          { date: to === '24:00' ? nextDate(date) : date, time: to === '24:00' ? '00:00' : to },
          timeZone,
        ) > now,
    )
  );
}
// The existence of the organization's schedule is independent of catalog,
// service assignments, rooms, reservations and minimum booking lead time.
function hasOpenWorkingDays(context, org, now = Date.now()) {
  const settings = context.onlineBooking.settings(org);
  const members = context
    .workspaceIdentities(org)
    .filter(
      (m) =>
        m.status === 'active' &&
        (['owner', 'cosmetologist'].includes(m.role) ||
          (m.role === 'salon_admin' && settings.staff[m.accountId]?.enabled === true)),
    );
  if (!members.length) return false;
  const zone = context.organizationTimeZone(org);
  for (const group of context.workSchedules.futureDays(
    org,
    members.map((m) => m.accountId),
    dateInZone(now, zone),
  )) {
    if (group.closure?.status === 'closed') continue;
    if (members.some((m) => hasFutureHours(group.date, group.days.get(m.accountId), zone, now)))
      return true;
  }
  return false;
}
module.exports = { dateInZone, hasFutureHours, hasOpenWorkingDays };
