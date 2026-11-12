// Civil-day occupancy: intersect unioned appointments with unioned working intervals.
function calendarLoadDay(date, schedule, records, organizationClosed = false) {
  const minutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const merge = (ranges) => {
    const result = [];
    for (const pair of ranges.filter((p) => p[1] > p[0]).sort((a, b) => a[0] - b[0])) {
      const last = result.at(-1);
      if (last && pair[0] <= last[1]) last[1] = Math.max(last[1], pair[1]);
      else result.push([...pair]);
    }
    return result;
  };
  const length = (ranges) => ranges.reduce((sum, p) => sum + p[1] - p[0], 0);
  const origin = Date.parse(date + 'T00:00:00Z');
  const entries = records.flatMap((a) => {
    if (['cancelled', 'no_show'].includes(a.status)) return [];
    const start = (Date.parse(a.date + 'T00:00:00Z') - origin) / 60000 + minutes(a.time);
    const end = start + (Number(a.duration) || 60);
    return Number.isFinite(start) && end > 0 && start < 1440
      ? [{ id: a.id, range: [Math.max(0, start), Math.min(1440, end)] }]
      : [];
  });
  const occupied = merge(entries.map((e) => e.range));
  const status = organizationClosed ? 'common' : schedule?.status || 'unset';
  const working = status === 'working' ? merge(schedule.intervals.map((p) => p.map(minutes))) : [];
  const covered = merge(
    occupied.flatMap((a) => working.flatMap((b) => [[Math.max(a[0], b[0]), Math.min(a[1], b[1])]])),
  );
  const capacity = status === 'unset' ? null : length(working);
  const booked = length(covered);
  return {
    status,
    capacity,
    booked,
    count: entries.length,
    ids: entries.map((e) => e.id),
    occupied: length(occupied),
    outside: status === 'unset' ? 0 : length(occupied) - booked,
    free: capacity === null ? null : capacity - booked,
    percent: capacity ? Math.round((booked / capacity) * 100) : null,
  };
}
function calendarLoadDates(anchor, period = 'week') {
  const start = new Date(
    anchor.getFullYear(),
    anchor.getMonth(),
    period === 'month' ? 1 : anchor.getDate(),
  );
  const count =
    period === 'day'
      ? 1
      : period === 'month'
        ? new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate()
        : 7;
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start);
    date.setDate(date.getDate() + index);
    return date;
  });
}
function createCalendarLoadMath() {
  return { calendarLoadDay, calendarLoadDates };
}
if (typeof module !== 'undefined' && module.exports)
  module.exports = { calendarLoadDay, calendarLoadDates };
