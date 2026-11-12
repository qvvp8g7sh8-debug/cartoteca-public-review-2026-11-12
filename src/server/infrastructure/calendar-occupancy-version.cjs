const { randomUUID } = require('node:crypto');
const { isClosedAppointment } = require('../../shared/appointment-status.cjs');
const { patientNameParts } = require('../../shared/patient-names.cjs');

// Versions belong to the encrypted cabinet meta and commit with canonical records.
// They are per staff, not per cabinet revision: phone/history edits keep feeds warm.
function createCalendarOccupancyVersion({ db, get, set, hash, prepare, decode }) {
  const key = (staffId) => 'calendar-occupancy:' + hash('calendar-occupancy:' + staffId);
  function version(staffId) {
    if (!staffId || typeof staffId !== 'string') return '';
    return get(key(staffId), '');
  }
  function projection(appointments, result, patientName) {
    for (const appointment of appointments) {
      if (!appointment.staffId || isClosedAppointment(appointment)) continue;
      result.set(appointment.id, {
        staffId: appointment.staffId,
        value: JSON.stringify([
          appointment.id,
          appointment.staffId,
          appointment.date,
          appointment.time,
          appointment.duration || 60,
          // Missing historical index names stay unknown, forcing conservative invalidation.
          patientName ??
            (typeof appointment.patientName === 'string' ? appointment.patientName : null),
        ]),
      });
    }
  }
  function update(patients, indexedIds, previousPatients) {
    if (!db.isTransaction) throw Error('Cabinet transaction required');
    const before = new Map(),
      after = new Map();
    for (const id of indexedIds) {
      if (previousPatients.has(id)) {
        const patient = previousPatients.get(id);
        projection(patient?.appointments || [], before, patientNameParts(patient || {}).lastFirst);
      } else {
        // Deletions are absent from previousPatients. Read only the old appointment
        // index before replacement; never reload clinical profiles or visit history.
        const rows = prepare('SELECT value FROM cabinet_appointments WHERE patient_id=?').all(id);
        projection(
          rows.map((row) => decode(row.value)),
          before,
        );
      }
    }
    for (const patient of patients)
      if (indexedIds.has(patient.id))
        projection(patient.appointments, after, patientNameParts(patient).lastFirst);
    const affected = new Set();
    for (const [id, appointment] of before) {
      const next = after.get(id);
      if (appointment.value !== next?.value) {
        affected.add(appointment.staffId);
        if (next) affected.add(next.staffId);
      }
      after.delete(id);
    }
    for (const appointment of after.values()) affected.add(appointment.staffId);
    for (const staffId of affected) set(key(staffId), randomUUID());
    return affected;
  }
  return { version, update };
}
module.exports = { createCalendarOccupancyVersion };
