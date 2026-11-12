const { validDate, minutes } = require('../../../shared/work-schedule.cjs');
const { startsAt } = require('../notifications/appointments.cjs');
const { availableRooms } = require('../workspace/policy.cjs');
const { fail } = require('../../../shared/errors.cjs');
const {
  mergeIntervals,
  freeIntervals,
  activeOccupancy,
  roomBusyIntervals,
} = require('./free-intervals.cjs');

const wallTime = (value) =>
  `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
// All calculations use organization wall time. Unknown days are never publicly bookable.
function availableSlots({
  date,
  duration,
  staff,
  dayAt,
  closure,
  workspace,
  roomId,
  appointments = [],
  personalEvents = [],
  reservations = [],
  mode = 'any',
  modeForStaff,
  atTime,
  minimumLeadMinutes = 60,
  timeZone = 'Europe/Moscow',
  now = Date.now(),
}) {
  if (
    !validDate(date) ||
    !Number.isSafeInteger(duration) ||
    duration < 5 ||
    duration > 1440 ||
    duration % 5 ||
    !['any', 'sequential'].includes(mode) ||
    (modeForStaff !== undefined && typeof modeForStaff !== 'function') ||
    (atTime !== undefined &&
      (typeof atTime !== 'string' || !/^([01]\d|2[0-3]):[0-5][05]$/.test(atTime))) ||
    !Number.isSafeInteger(minimumLeadMinutes) ||
    minimumLeadMinutes < 0 ||
    minimumLeadMinutes > 20160
  )
    throw fail(400, 'Проверьте дату, длительность и правила онлайн-записи.');
  if (closure?.status === 'closed') return [];
  const exactStart = atTime === undefined ? null : minutes(atTime);
  const entries = activeOccupancy(appointments, reservations, now);
  const result = [];
  for (const member of staff) {
    const staffMode = modeForStaff ? modeForStaff(member.accountId) : mode;
    if (!['any', 'sequential'].includes(staffMode))
      throw fail(400, 'Проверьте режим онлайн-записи сотрудника.');
    const day = dayAt(member.accountId, date);
    if (day?.status !== 'working') continue;
    const rooms = availableRooms(workspace, member.accountId).filter(
      (room) => !roomId || room.id === roomId,
    );
    const offered = new Map();
    for (const room of rooms) {
      const busy = roomBusyIntervals({
        date,
        staffId: member.accountId,
        room,
        workspace,
        entries,
        personalEvents,
      });
      for (const pair of day.intervals) {
        const from = minutes(pair[0]),
          to = minutes(pair[1], true);
        for (const [gapStart, gapEnd] of freeIntervals(from, to, busy)) {
          if (exactStart !== null && (exactStart < gapStart || exactStart + duration > gapEnd))
            continue;
          // Only new offers are aligned to the appointment's five-minute step.
          // Sequential follows occupancy; general selection retains a 15-min grid.
          const anchor = Math.ceil((staffMode === 'sequential' ? gapStart : from) / 5) * 5;
          let start = exactStart ?? anchor + Math.max(0, Math.ceil((gapStart - anchor) / 15)) * 15;
          for (; start + duration <= gapEnd; start += 15) {
            const time = wallTime(start);
            const instant = startsAt({ date, time }, timeZone);
            if (!Number.isFinite(instant) || instant < now + minimumLeadMinutes * 60000) {
              if (exactStart !== null) break;
              continue;
            }
            if (!offered.has(time))
              offered.set(time, {
                date,
                time,
                staffId: member.accountId,
                roomId: room.id,
                duration,
              });
            if (staffMode === 'sequential' || exactStart !== null) break;
          }
        }
      }
    }
    const sorted = [...offered.values()].sort((a, b) => a.time.localeCompare(b.time));
    result.push(...(staffMode === 'sequential' ? sorted.slice(0, 1) : sorted));
  }
  return result.sort((a, b) => (a.time + a.staffId).localeCompare(b.time + b.staffId));
}
module.exports = { availableSlots, freeIntervals, mergeIntervals };
