const { availableRooms } = require('../../workspace/policy.cjs');
const {
  activeOccupancy,
  roomBusyIntervals,
  freeIntervals,
} = require('../../booking/free-intervals.cjs');
const { minutes, nextDate } = require('../../../../shared/work-schedule.cjs');
const { startsAt } = require('../../../../shared/time-zone-instant.cjs');
const wallTime = (value) =>
  String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
function currentClock(now, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(now))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return {
    date: parts.year + '-' + parts.month + '-' + parts.day,
    minute:
      Number(parts.hour) * 60 + Number(parts.minute) + (Number(parts.second) || now % 1000 ? 1 : 0),
  };
}
function civilIntervals(date, timeZone) {
  const first = startsAt({ date, time: '00:00' }, timeZone),
    last = startsAt({ date: nextDate(date), time: '00:00' }, timeZone);
  if (Number.isFinite(first) && Number.isFinite(last) && last - first === 86400000)
    return [[0, 1440]];
  // Only a transition day needs the bounded minute scan; never announce a nonexistent civil hour.
  const result = [];
  for (let value = 0; value < 1440; value++) {
    if (!Number.isFinite(startsAt({ date, time: wallTime(value) }, timeZone))) continue;
    const previous = result.at(-1);
    if (previous?.[1] === value) previous[1] = value + 1;
    else result.push([value, value + 1]);
  }
  return result;
}
function dayAvailability({
  date,
  staffId,
  schedule,
  closure,
  workspace,
  appointments,
  reservations,
  personalEvents,
  duration,
  timeZone,
  now,
  start = 0,
  end = 1440,
}) {
  const day = schedule.days[date];
  const status =
    closure?.status === 'closed' || day?.status === 'closed'
      ? 'closed'
      : day?.status === 'working'
        ? 'working'
        : 'missing';
  const workingIntervals = day?.status === 'working' ? day.intervals.map((pair) => [...pair]) : [];
  const result = {
    date,
    staffId,
    status,
    workingIntervals,
    freeRanges: [],
    empty: false,
    remainingOnly: false,
  };
  if (status !== 'working') return result;
  const clock = currentClock(now, timeZone);
  result.remainingOnly =
    date < clock.date ||
    (date === clock.date && workingIntervals.some(([from]) => minutes(from) < clock.minute));
  const lower = date < clock.date ? 1440 : Math.max(start, date === clock.date ? clock.minute : 0);
  const civil = civilIntervals(date, timeZone),
    entries = activeOccupancy(appointments, reservations, now);
  const rooms = availableRooms(workspace, staffId),
    ranges = [];
  let occupied = false;
  for (const room of rooms) {
    const busy = roomBusyIntervals({ date, staffId, room, workspace, entries, personalEvents });
    for (const [fromText, toText] of workingIntervals) {
      const from = minutes(fromText),
        to = minutes(toText, true);
      if (busy.some(([left, right]) => left < to && right > from)) occupied = true;
      for (const [left, right] of freeIntervals(from, to, busy))
        for (const [civilFrom, civilTo] of civil) {
          const opening = Math.max(left, lower, civilFrom),
            closing = Math.min(right, end, civilTo);
          if (closing - opening >= duration) ranges.push([opening, closing]);
        }
    }
  }
  result.empty = rooms.length > 0 && !occupied;
  // A union across partly overlapping rooms could promise a longer continuous room than exists.
  const maximal = [];
  for (const pair of ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]))
    if (!maximal.some(([from, to]) => from <= pair[0] && to >= pair[1])) maximal.push(pair);
  result.freeRanges = maximal.map(([from, to]) => [wallTime(from), wallTime(to)]);
  return result;
}
module.exports = { dayAvailability };
