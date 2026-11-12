const { fail } = require('../../../shared/errors.cjs');
const { cabinetForUser } = require('../access/cabinet-policy.cjs');
function editSelection(url) {
  const patientId = url.searchParams.get('id'),
    id = url.searchParams.get('appointmentId');
  if (![patientId, id].every((v) => typeof v === 'string' && v.length > 0 && v.length <= 120))
    throw fail(400, 'Укажите карточку и запись.');
  return { patientId, id };
}
function editSnapshot(current, revision, patient, appointment) {
  if (!patient || !appointment || !['owner', 'salon_admin', 'cosmetologist'].includes(current.role))
    throw fail(404, 'Запись не найдена или недоступна.');
  if ('visits' in patient || 'appointments' in patient)
    throw Object.assign(Error('Invalid canonical appointment profile'), { status: 503 });
  const visible = cabinetForUser(current, {
    patients: [{ ...patient, visits: [], appointments: [appointment] }],
    services: [],
  });
  if (!visible.patients[0]?.appointments.some((a) => a.id === appointment.id))
    throw fail(404, 'Запись не найдена или недоступна.');
  return { kind: 'appointment-edit-v1', revision, patient, appointment };
}
function readEditSnapshot(storage, current, url) {
  const { patientId, id } = editSelection(url);
  if (!storage.capabilities?.normalizedRecords) return { appointmentViewUnsupported: true };
  return storage.readOnlySnapshot(() => {
    const p = storage.db.prepare('SELECT value FROM patients WHERE id=?').get(patientId);
    const row = storage.db
      .prepare(
        "SELECT id,value FROM cabinet_patient_records WHERE patient_id=? AND kind='appointment' AND id=?",
      )
      .get(patientId, id);
    const patient = p && storage.decode(p.value),
      appointment = row && storage.decode(row.value);
    if ((patient && patient.id !== patientId) || (appointment && appointment.id !== id))
      throw Error('Invalid canonical appointment edit');
    return editSnapshot(current, storage.get('revision', 0), patient, appointment);
  });
}
// An explicit edit response is never a full patient baseline. Legacy delta-v1
// responses keep their established DTO and replay contract.
function pointResponse(result, body) {
  const ids = new Set(body.changes.map((c) => c.id));
  return {
    ...result,
    appointmentEdit: true,
    patients: result.patients.map((p) => ({
      ...p,
      visits: [],
      appointments: p.appointments.filter((a) => ids.has(a.id)),
    })),
  };
}
module.exports = { editSelection, editSnapshot, readEditSnapshot, pointResponse };
