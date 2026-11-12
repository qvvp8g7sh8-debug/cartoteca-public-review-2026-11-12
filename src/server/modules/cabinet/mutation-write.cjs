const { isActiveAppointment } = require('../../../shared/appointment-status.cjs');
const { fingerprint } = require('../notifications/appointments.cjs');

// Caller holds platform then cabinet locks and has run the shared mutation policy.
function writeCabinetMutation(
  platform,
  org,
  storage,
  before,
  next,
  changedIds,
  normalizedImages,
  preparedWrite,
  { sharedNoEffects = false, appointmentOnly = false } = {},
) {
  const saved = storage.write(next, {
    normalizedImages,
    insideTransaction: true,
    changedIds,
    preparedWrite,
    preparedBefore: before,
    appointmentOnly,
  });
  const eventState = { ...next, revision: saved.revision };
  require('../notifications/client-appointment-events.cjs').recordClientAppointmentChanges(
    platform,
    org,
    storage,
    before,
    eventState,
  );
  require('../notifications/staff-appointment-events.cjs').recordStaffAppointmentEvents(
    platform,
    org,
    storage,
    before,
    eventState,
  );
  // Only the shared caller has revalidated that this mutation changes no
  // platform effects. A prepared but explicitly disabled scheduler does not
  // require a dirty write; enabled/unknown modes retain the atomic path.
  if (
    platform.notificationSchedule &&
    !(sharedNoEffects === true && platform.notificationSchedule.enabled === false)
  ) {
    if (changedIds)
      for (const id of changedIds.patients)
        platform.notificationSchedule.markDirty(org, 'client', id);
    else platform.notificationSchedule.markDirty(org);
  }
  platform.appointmentConfirmations.invalidateChanges(
    org,
    before,
    next,
    platform.organizationTimeZone(org),
  );
  const zone = platform.organizationTimeZone(org);
  const updated = new Map(next.patients.flatMap((p) => p.appointments.map((a) => [a.id, a])));
  for (const p of before.patients)
    for (const a of p.appointments)
      if (isActiveAppointment(a) && (!updated.has(a.id) || !isActiveAppointment(updated.get(a.id))))
        platform.telegram.cancelPending(org, p.id, fingerprint(a, zone));
  require('../notifications/push-events.cjs').pushAppointmentChanges(platform, org, before, {
    ...next,
    revision: saved.revision,
  });
  return saved;
}
module.exports = { writeCabinetMutation };
