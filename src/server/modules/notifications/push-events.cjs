const { fingerprint } = require('./appointments.cjs');
const { createWorkdayPush } = require('./push-workday.cjs');
const { isActiveAppointment } = require('../../../shared/appointment-status.cjs');
function changeNotice(before, next) {
  if (['cancelled', 'completed', 'no_show'].includes(next.status))
    return !before || before.status !== next.status ? next.status : 'updated';
  if (!before) return 'created';
  if (!isActiveAppointment(before) && isActiveAppointment(next)) return 'restored';
  if (before.date !== next.date || before.time !== next.time) return 'moved';
  return 'updated';
}
// Called under the platform -> cabinet write locks; queue changes roll back with platform.
function pushAppointmentChanges(platform, org, before, next) {
  if (!platform.staffPush || platform.staffPush.hasEnabledEvents?.(org, 'change') === false) return;
  const zone = platform.organizationTimeZone(org),
    prior = new Map();
  for (const p of before.patients)
    for (const a of p.appointments) prior.set(a.id, { a, patientId: p.id });
  for (const p of next.patients)
    for (const a of p.appointments) {
      const old = prior.get(a.id);
      prior.delete(a.id);
      if (
        old &&
        fingerprint(old.a, zone) === fingerprint(a, zone) &&
        isActiveAppointment(old.a) === isActiveAppointment(a)
      )
        continue;
      const ref = {
        kind: 'appointment',
        patientId: p.id,
        id: a.id,
        stamp: fingerprint(a, zone),
        cancelled: !isActiveAppointment(a),
        notice: changeNotice(old?.a, a),
      };
      platform.staffPush.enqueue(
        org,
        a.staffId,
        'change',
        ref,
        JSON.stringify(['change', a.id, ref.stamp, ref.cancelled, next.revision]),
      );
    }
  for (const { a, patientId } of prior.values())
    if (isActiveAppointment(a))
      platform.staffPush.enqueue(
        org,
        a.staffId,
        'change',
        { kind: 'appointment', patientId, id: a.id, removed: true },
        JSON.stringify(['removed', a.id, next.revision]),
      );
}
function createPushSchedule(platform, tenantStore, store, clock = Date.now) {
  const workday = createWorkdayPush(platform, store, clock);
  function current(job) {
    if (job.decoded.event === 'test') return true;
    if (job.decoded.event === 'reminder') return workday.current(job);
    const ref = job.decoded.reference;
    if (ref.kind === 'request') {
      const r = platform.bookingRequests.get(job.organization_id, ref.id, clock());
      return (
        r &&
        r.revision === ref.revision &&
        r.staffId === job.decoded.staffId &&
        !['expired', 'cancelled'].includes(r.status)
      );
    }
    const storage = tenantStore(job.organization_id);
    const a =
      typeof storage.readAppointment === 'function'
        ? storage.readAppointment(ref.patientId, ref.id)
        : storage
            .readSelected([ref.patientId])
            .patients[0]?.appointments?.find((row) => row.id === ref.id);
    if (ref.removed) return !a;
    if (
      !a ||
      a.staffId !== job.decoded.staffId ||
      fingerprint(a, platform.organizationTimeZone(job.organization_id)) !== ref.stamp
    )
      return false;
    return ref.cancelled ? !isActiveAppointment(a) : isActiveAppointment(a);
  }
  return {
    schedule: workday.schedule,
    scheduleBatch: workday.scheduleBatch,
    scheduleBatched: workday.scheduleBatched,
    current,
  };
}
module.exports = { pushAppointmentChanges, createPushSchedule };
