const { isActiveAppointment } = require('../../../shared/appointment-status.cjs');
const { nextDate } = require('../../../shared/work-schedule.cjs');
const { startsAt } = require('../notifications/appointments.cjs');
const { roomFor } = require('../workspace/policy.cjs');
const { fail } = require('../../../shared/errors.cjs');
const { roomBlocksOverlap } = require('../workspace/overlap.cjs');

const occupancy = (a) => JSON.stringify([a.date, a.time, a.duration, a.staffId, a.roomId]);
function assertReservationChanges(platform, org, before, next, now = Date.now(), acceptance) {
  const prior = new Map(before.patients.flatMap((p) => p.appointments || []).map((a) => [a.id, a]));
  let workspace;
  const zone = platform.organizationTimeZone(org);
  for (const patient of next.patients)
    for (const appointment of patient.appointments || []) {
      if (!isActiveAppointment(appointment)) continue;
      const old = prior.get(appointment.id);
      if (old && isActiveAppointment(old) && occupancy(old) === occupancy(appointment)) continue;
      const start = startsAt(appointment, zone),
        end = start + (Number(appointment.duration) || 60) * 60000;
      if (end <= now) continue;
      workspace ||= platform.workspaceSettings(org);
      const room = roomFor(workspace, appointment);
      const reserves = platform.bookingRequests.reserves(
        org,
        nextDate(appointment.date, -1),
        nextDate(appointment.date, 1),
        now,
        acceptance?.appointmentId === appointment.id ? acceptance.id : '',
      );
      for (const reserve of reserves) {
        const from = startsAt(reserve, zone),
          to = from + reserve.duration * 60000;
        if (from >= end || to <= start) continue;
        if (
          reserve.staffId === appointment.staffId ||
          !room ||
          (roomBlocksOverlap(workspace, room) && (!reserve.roomId || reserve.roomId === room.id))
        )
          throw fail(
            409,
            'Это время временно зарезервировано онлайн-заявкой. Выберите другое время.',
          );
      }
    }
}
module.exports = { assertReservationChanges };
