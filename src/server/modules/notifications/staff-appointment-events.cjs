const { createHash } = require('node:crypto');
const { fingerprint, serviceFingerprint } = require('./appointments.cjs');
const { isActiveAppointment } = require('../../../shared/appointment-status.cjs');
const journal = require('./appointment-event-journal.cjs');
const { channelEnabled, channelVersion } = require('./staff-event-preferences.cjs');
const channels = (platform) =>
  [
    ['telegram', platform.staffNotifications],
    ['max', platform.staffMaxNotifications],
  ].filter(([channel]) => channelEnabled(platform, channel));
function contentStamp(a, zone) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        fingerprint(a, zone),
        serviceFingerprint(a),
        a.status || 'scheduled',
        a.roomId || '',
      ]),
    )
    .digest('hex');
}
function notice(before, next) {
  if (['cancelled', 'completed', 'no_show'].includes(next.status) && before?.status !== next.status)
    return next.status;
  if (!before) return 'created';
  if (!isActiveAppointment(before) && isActiveAppointment(next)) return 'restored';
  if (before.date !== next.date || before.time !== next.time) return 'moved';
  return 'updated';
}
function reference(patientId, a, zone, event, revision) {
  return {
    patientId,
    id: a.id,
    stamp: fingerprint(a, zone),
    contentStamp: contentStamp(a, zone),
    notice: event,
    status: a.status || '',
    revision,
    ...(event === 'removed' ? { removed: true } : {}),
    snapshot: {
      date: a.date,
      time: a.time,
      duration: a.duration || 60,
      staffId: a.staffId || '',
      status: a.status || '',
    },
  };
}
function staffAppointmentEntries(platform, org, before, next) {
  const available = channels(platform).filter(
    ([, store]) =>
      typeof store?.appointmentRecipients === 'function' &&
      store.hasAppointmentRecipients?.(org) !== false,
  );
  if (!available.length) return [];
  const zone = platform.organizationTimeZone(org),
    prior = new Map(),
    entries = [];
  for (const p of before.patients)
    for (const a of p.appointments) prior.set(a.id, { a, patientId: p.id });
  function append(patientId, a, old, event) {
    const recipients = Object.fromEntries(
      available.map(([channel, store]) => [
        channel,
        store?.appointmentRecipients?.(org, a.staffId, event) || [],
      ]),
    );
    if (!Object.values(recipients).some((values) => values.length)) return;
    entries.push({
      kind: event,
      staffId: a.staffId || '',
      beforeStaffId: old?.staffId || '',
      recipients,
      channelVersions: Object.fromEntries(
        available
          .filter(([channel]) => recipients[channel].length)
          .map(([channel]) => [channel, channelVersion(platform, channel)]),
      ),
      reference: reference(patientId, a, zone, event, next.revision),
    });
  }
  for (const p of next.patients)
    for (const a of p.appointments) {
      const old = prior.get(a.id);
      prior.delete(a.id);
      if (old && old.patientId === p.id && contentStamp(old.a, zone) === contentStamp(a, zone))
        continue;
      append(p.id, a, old?.a, notice(old?.a, a));
    }
  for (const { a, patientId } of prior.values())
    if (isActiveAppointment(a)) append(patientId, a, a, 'removed');
  return entries;
}
// Stage only in the owning cabinet transaction; platform rollback cannot erase this journal.
function recordStaffAppointmentEvents(platform, org, storage, before, next, now = Date.now()) {
  return journal.record(
    storage,
    'staff',
    staffAppointmentEntries(platform, org, before, next),
    now,
  );
}
// Caller retires returned IDs only AFTER the platform queue transaction commits.
function replayStaffAppointmentEvents(platform, org, storage, now = Date.now()) {
  if (
    !channels(platform).some(
      ([, store]) =>
        typeof store?.enqueueAppointment === 'function' &&
        store.hasAppointmentRecipients?.(org) !== false,
    )
  )
    return [];
  return journal.replay(
    storage,
    'staff',
    (entry) => {
      for (const [channel, store] of channels(platform)) {
        if ((entry.channelVersions?.[channel] || '') !== channelVersion(platform, channel))
          continue;
        const intended = entry.recipients?.[channel] || [];
        if (intended.length)
          store?.enqueueAppointment?.(
            org,
            entry.staffId,
            entry.kind,
            entry.reference,
            entry.id,
            now,
            intended,
          );
      }
      return true;
    },
    now,
  );
}
function staffConfirmation(platform, org, patientId, a, now = Date.now()) {
  const destinations = channels(platform).filter(
    ([, store]) => store?.appointmentRecipients?.(org, a.staffId, 'confirmation')?.length,
  );
  if (!destinations.length) return;
  const zone = platform.organizationTimeZone(org),
    ref = reference(patientId, a, zone, 'confirmation', 0);
  for (const [, store] of destinations)
    store?.enqueueAppointment?.(
      org,
      a.staffId,
      'confirmation',
      ref,
      JSON.stringify(['confirmation', a.id, ref.contentStamp]),
      now,
    );
}
function resolveStaffAppointment(platform, tenantStore, job) {
  if (typeof tenantStore !== 'function') return null;
  const ref = job.decoded.reference;
  if (!ref || typeof ref.patientId !== 'string' || typeof ref.id !== 'string') return null;
  const storage = tenantStore(job.organization_id),
    patient = storage.readSelected([ref.patientId]).patients[0];
  const a = patient?.appointments?.find((value) => value.id === ref.id);
  if (ref.removed)
    return !a && ref.snapshot ? { ...ref.snapshot, services: [], kind: 'appointment' } : null;
  const zone = platform.organizationTimeZone(job.organization_id);
  if (
    !a ||
    (a.staffId || '') !== (job.decoded.staffId || '') ||
    fingerprint(a, zone) !== ref.stamp ||
    contentStamp(a, zone) !== ref.contentStamp ||
    (job.decoded.event === 'confirmation' && !isActiveAppointment(a))
  )
    return null;
  if (
    job.decoded.event === 'confirmation' &&
    !platform.appointmentConfirmations.read(job.organization_id, ref.patientId, a, zone) &&
    !platform.telegram.confirmed(
      job.organization_id,
      ref.patientId,
      fingerprint(a, zone),
      serviceFingerprint(a),
    ) &&
    !platform.notificationStore?.confirmed(
      job.organization_id,
      ref.patientId,
      a.id,
      platform.appointmentConfirmations.stamp(a, zone),
    )
  )
    return null;
  return {
    date: a.date,
    time: a.time,
    duration: a.duration || 60,
    services: [],
    kind: 'appointment',
  };
}
module.exports = {
  staffAppointmentEntries,
  recordStaffAppointmentEvents,
  replayStaffAppointmentEvents,
  staffConfirmation,
  resolveStaffAppointment,
};
