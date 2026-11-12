const { isActiveAppointment } = require('../../../shared/appointment-status.cjs');
const { roomFor } = require('../workspace/policy.cjs');
const { roomBlocksOverlap } = require('../workspace/overlap.cjs');
const civilStart = (value) => Date.parse(value.date + 'T' + value.time + ':00Z');
function mergeIntervals(values) {
  const result = [];
  for (const [start, end] of values.sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  return result;
}
function freeIntervals(start, end, busy) {
  const result = [];
  let cursor = start;
  for (const [from, to] of mergeIntervals(busy)) {
    if (to <= cursor || from >= end) continue;
    if (from > cursor) result.push([cursor, Math.min(from, end)]);
    cursor = Math.max(cursor, to);
  }
  if (cursor < end) result.push([cursor, end]);
  return result;
}

function activeOccupancy(appointments, reservations, now) {
  return [
    ...appointments.filter(isActiveAppointment),
    ...reservations.filter((row) => row.status === 'pending' && Number(row.expiresAt) > now),
  ];
}
// Shared facts for grid offers and continuous ranges; no storage reads or authorizations here.
function roomBusyIntervals({ date, staffId, room, workspace, entries, personalEvents }) {
  const origin = Date.parse(date + 'T00:00:00Z');
  const busy = entries.flatMap((entry) => {
    const assignedRoom = roomFor(workspace, entry);
    if (
      entry.staffId !== staffId &&
      (!roomBlocksOverlap(workspace, room) || (assignedRoom && assignedRoom.id !== room.id))
    )
      return [];
    const start = (civilStart(entry) - origin) / 60000;
    const length = Number(entry.duration ?? 60);
    if (!Number.isFinite(start) || !Number.isFinite(length) || length <= 0) return [[0, 1440]];
    return [[start, start + length]];
  });
  // Personal time belongs to the specialist and never reserves a physical room.
  for (const event of personalEvents) {
    if (event.staffId !== staffId) continue;
    const start = (civilStart(event) - origin) / 60000;
    busy.push([start, start + event.duration]);
  }
  return busy;
}
module.exports = { mergeIntervals, freeIntervals, activeOccupancy, roomBusyIntervals };
