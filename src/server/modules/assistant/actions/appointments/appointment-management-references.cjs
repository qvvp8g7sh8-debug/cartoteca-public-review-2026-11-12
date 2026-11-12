const { readSteps } = require('../../read-steps.cjs');
const { fail } = require('../../../../../shared/errors.cjs');
const { cabinetForUser } = require('../../../access/cabinet-policy.cjs');
const {
  managementContext,
  eligibleManagementAppointment,
} = require('./appointment-management-scope.cjs');
const {
  assistantAppointmentStamp,
} = require('../../../../../shared/assistant-appointment-identity.cjs');
function managementAppointments(c, patientId, now = Date.now()) {
  return readSteps(function* () {
    c.assertCurrent();
    if (
      !c.current.organizationId ||
      c.current.globalAdmin ||
      !['owner', 'salon_admin', 'cosmetologist'].includes(c.current.role)
    )
      throw fail(403, 'Нет доступа к записям этой организации.');
    if (typeof patientId !== 'string' || !patientId || patientId.length > 128)
      throw fail(400, 'Уточните клиента.');
    const storage = c.tenantStore(c.current.organizationId);
    const selected = cabinetForUser(
      c.current,
      c.assistantReads
        ? yield c.assistantReads.selected([patientId])
        : storage.readSelected([patientId]),
    );
    const patient = selected.patients.find((row) => row.id === patientId);
    if (!patient) throw fail(404, 'Клиент больше недоступен.');
    const context = yield managementContext(c);
    const appointments = (patient.appointments || [])
      .filter((row) =>
        eligibleManagementAppointment(c, row, now, context.ownerId, false, context.timeZone),
      )
      .map((row) => structuredClone(row))
      .sort(
        (a, b) =>
          a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.id.localeCompare(b.id),
      );
    c.assertCurrent();
    return { patient, appointments, context };
  }).call(this);
}
function managementSource(c, identity, now = Date.now()) {
  return readSteps(function* () {
    if (
      !identity ||
      typeof identity.appointmentId !== 'string' ||
      !identity.appointmentId ||
      identity.appointmentId.length > 128 ||
      typeof identity.sourceStamp !== 'string' ||
      identity.sourceStamp.length > 32768
    )
      throw fail(400, 'Уточните существующую запись.');
    const refs = yield managementAppointments(c, identity.patientId, now);
    const appointment = refs.appointments.find((row) => row.id === identity.appointmentId);
    if (!appointment || assistantAppointmentStamp(appointment) !== identity.sourceStamp)
      throw fail(409, 'Эта запись изменилась или больше недоступна. Уточните её ещё раз.');
    const staffId = appointment.staffId || refs.context.ownerId;
    if (!staffId || (c.current.role === 'cosmetologist' && staffId !== c.current.accountId))
      throw fail(403, 'Можно изменить только доступную вам запись.');
    return { ...refs, appointment, staffId, duration: Number(appointment.duration || 60) };
  }).call(this);
}
function sourceIdentity(patientId, appointment) {
  return {
    patientId,
    appointmentId: appointment.id,
    sourceStamp: assistantAppointmentStamp(appointment),
  };
}
module.exports = { managementAppointments, managementSource, sourceIdentity };
