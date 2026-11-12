const crypto = require('node:crypto');
const { bookingWarning, validDate, minutes } = require('../../../shared/work-schedule.cjs');
const { isActiveAppointment } = require('../../../shared/appointment-status.cjs');
const { duration } = require('../cabinet/validation.cjs');
function createScheduleBooking(context, store) {
  const signature = (value) =>
    crypto.createHmac('sha256', context.key).update(JSON.stringify(value)).digest('base64url');
  function facts(current, appointment, identities) {
    if (!appointment || typeof appointment !== 'object' || Array.isArray(appointment))
      throw context.fail(400, 'Укажите дату, время, сотрудника и длительность.');
    appointment = { ...appointment, duration: duration(appointment.duration ?? 60) };
    const staffId = appointment.staffId || current.accountId;
    store.authorize(current, staffId, false, identities);
    if (
      !validDate(appointment.date) ||
      !Number.isFinite(minutes(appointment.time)) ||
      !Number.isInteger(appointment.duration) ||
      appointment.duration < 1 ||
      appointment.duration > 1440
    )
      throw context.fail(400, 'Укажите другую дату и время записи; проверьте длительность.');
    const org = current.organizationId;
    return {
      staffId,
      warning: bookingWarning(
        appointment,
        (date) => store.day(org, staffId, date),
        (date) => store.day(org, 'organization', date),
        { warnUnset: true },
      ),
      binding: [
        org,
        current.accountId,
        staffId,
        appointment.date,
        appointment.time,
        appointment.duration,
        store.profile(org, staffId).revision,
        store.profile(org, 'organization').revision,
        context.organizationTimeZone(org),
      ],
    };
  }
  function check(current, appointment) {
    const value = facts(current, appointment),
      canOverride = ['owner', 'salon_admin'].includes(current.role);
    const expires = Date.now() + 5 * 60 * 1000;
    return {
      warning: value.warning,
      canOverride,
      acknowledgement:
        value.warning && canOverride ? expires + '.' + signature([...value.binding, expires]) : '',
    };
  }
  function assertChanges(current, before, after, acknowledgement = '', identities) {
    const old = new Map(before.patients.flatMap((p) => p.appointments.map((a) => [a.id, a])));
    for (const p of after.patients)
      for (const a of p.appointments) {
        if (!isActiveAppointment(a)) continue;
        const prior = old.get(a.id);
        if (
          prior &&
          isActiveAppointment(prior) &&
          ['staffId', 'date', 'time', 'duration'].every((field) => prior[field] === a[field])
        )
          continue;
        const value = facts(current, a, identities);
        if (!value.warning) continue;
        if (!['owner', 'salon_admin'].includes(current.role))
          throw context.fail(403, value.warning + ' Обратитесь к администратору.');
        const [expiresText, digest] = String(acknowledgement).split('.'),
          expires = Number(expiresText);
        const expected = signature([...value.binding, expires]);
        if (
          !Number.isSafeInteger(expires) ||
          expires <= Date.now() ||
          expires > Date.now() + 5 * 60 * 1000 ||
          typeof digest !== 'string' ||
          !/^[A-Za-z0-9_-]{43}$/.test(digest) ||
          digest.length !== expected.length ||
          !crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(expected))
        )
          throw context.fail(412, value.warning + ' Подтвердите запись вне графика заново.');
      }
  }
  return { check, assertChanges, signature };
}
module.exports = { createScheduleBooking };
