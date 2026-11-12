const { isActiveAppointment } = require('../../../shared/appointment-status.cjs');

const indexKey = 'booking-classic-confirmations';
const key = (id) => 'booking-classic-confirmation:' + id;
// Explicitly paused by the owner. Keep the draft dormant until separately approved.
const enabled = false;

// Cabinet-owned receipt commits with the appointment, including across a later
// platform rollback. It is never supplied by the public form or editable card.
function classicConfirmation(platform, storage, patient, appointment, zone) {
  if (!enabled) return null;
  if (!isActiveAppointment(appointment)) return null;
  const saved = storage.get(key(appointment.id));
  return saved &&
    saved.patientId === patient &&
    saved.stamp === platform.appointmentConfirmations.stamp(appointment, zone)
    ? { automaticConfirmedAt: saved.confirmedAt }
    : null;
}

function writeClassicConfirmation(platform, storage, patient, appointment, zone, now) {
  if (!enabled) return;
  const entries = storage.get(indexKey) || [];
  const expiresAt = require('../notifications/appointments.cjs').startsAt(appointment, zone);
  const live = entries.filter((entry) => {
    if (entry.expiresAt > now) return true;
    // Keep the receipt for history; only retire expired delivery work.
    return false;
  });
  storage.set(key(appointment.id), {
    patientId: patient,
    stamp: platform.appointmentConfirmations.stamp(appointment, zone),
    confirmedAt: now,
  });
  storage.set(indexKey, [
    ...live,
    { patientId: patient, appointmentId: appointment.id, expiresAt },
  ]);
}

function classicNotices(storage, now) {
  if (!enabled) return [];
  return (storage.get(indexKey) || []).filter((entry) => entry.expiresAt > now);
}

module.exports = { classicConfirmation, writeClassicConfirmation, classicNotices };
