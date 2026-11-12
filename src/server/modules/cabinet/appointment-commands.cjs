const { isDeepStrictEqual } = require('node:util');
const { fail } = require('../../../shared/errors.cjs');
const { cabinetForUser, mergeCosmetologistCabinet } = require('../access/cabinet-policy.cjs');
const { editable } = require('./changes.cjs');

function validateAppointmentCommand(body) {
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value),
    validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 120;
  if (
    !object(body) ||
    Object.keys(body).some((key) => !['revision', 'patientId', 'changes'].includes(key)) ||
    !Number.isSafeInteger(body.revision) ||
    body.revision < 0 ||
    !validId(body.patientId) ||
    !Array.isArray(body.changes) ||
    !body.changes.length ||
    body.changes.length > 200
  )
    throw fail(400, 'Укажите карточку, версию и от 1 до 200 изменений записей.');
  const ids = new Set();
  for (const change of body.changes) {
    if (
      !object(change) ||
      Object.keys(change).some((key) => !['id', 'before', 'after'].includes(key)) ||
      !validId(change.id) ||
      ids.has(change.id) ||
      (change.before === null && change.after === null)
    )
      throw fail(400, 'Неверный формат изменения записи.');
    ids.add(change.id);
    for (const side of ['before', 'after'])
      if (change[side] !== null && (!object(change[side]) || change[side].id !== change.id))
        throw fail(400, 'Неверная версия записи.');
  }
  return body;
}

const editableAppointment = (value) =>
  value === null
    ? null
    : editable({ patients: [{ appointments: [value] }] }).patients[0].appointments[0];

// Internal strategy only: the HTTP command cannot supply executable callbacks,
// card profile/history, services, or a trusted commit hook. The common mutation
// pipeline hashes the original command and re-runs this build under both locks.
function createAppointmentMutation(body) {
  validateAppointmentCommand(body);
  const changedIds = { patients: [body.patientId], services: [] },
    receiptBody = { patients: [{ id: body.patientId, after: {} }], services: [] };
  function build(current, before) {
    const visible = cabinetForUser(current, before),
      patient = visible.patients.find((row) => row.id === body.patientId);
    if (!patient) throw fail(404, 'Карточка не найдена.');
    const appointments = new Map(
        patient.appointments.map((row) => [row.id, editableAppointment(row)]),
      ),
      allIds = new Set(
        before.patients.find((row) => row.id === body.patientId).appointments.map((row) => row.id),
      );
    for (const change of body.changes) {
      if (allIds.has(change.id) && !appointments.has(change.id))
        throw fail(403, 'Нет доступа к этой записи.');
      if (
        !isDeepStrictEqual(appointments.get(change.id) || null, editableAppointment(change.before))
      )
        throw fail(409, 'Эта запись уже изменена. Обновите страницу перед повторным сохранением.');
      if (change.after === null) appointments.delete(change.id);
      else appointments.set(change.id, editableAppointment(change.after));
    }
    // History stays owned by the fresh snapshot; only appointment values are
    // copied. The common policy still validates all lifecycle/ACL/photo rules.
    const next = {
      ...visible,
      patients: visible.patients.map((row) =>
        row.id === patient.id ? { ...patient, appointments: [...appointments.values()] } : row,
      ),
    };
    return current.role === 'cosmetologist'
      ? mergeCosmetologistCabinet(current, before, next)
      : next;
  }
  const compact = new WeakSet();
  return {
    changedIds,
    receiptBody,
    build,
    appointmentRead: { patientId: body.patientId, changes: body.changes },
    acceptCompact: (snapshot) => compact.add(snapshot),
    isCompact: (snapshot) => compact.has(snapshot),
  };
}

// Legacy PATCH keeps its full-card CAS and original body/receipt identity. Only
// its internal write strategy may share the appointment delta implementation.
function createAppointmentPatchMutation(body) {
  if (body.services.length || body.patients.length !== 1) return null;
  const change = body.patients[0],
    { before, after } = change;
  if (!before || !after) return null;
  const { appointments: oldAppointments, ...oldProfile } = before;
  const { appointments: nextAppointments, ...nextProfile } = after;
  if (!isDeepStrictEqual(oldProfile, nextProfile)) return null;
  if (
    !Array.isArray(oldAppointments) ||
    !Array.isArray(nextAppointments) ||
    new Set(oldAppointments.map((row) => row.id)).size !== oldAppointments.length ||
    new Set(nextAppointments.map((row) => row.id)).size !== nextAppointments.length
  )
    return null;
  const old = new Map(oldAppointments.map((row) => [row.id, editableAppointment(row)]));
  const next = new Map(nextAppointments.map((row) => [row.id, editableAppointment(row)]));
  const changes = [...new Set([...old.keys(), ...next.keys()])].flatMap((id) =>
    isDeepStrictEqual(old.get(id) || null, next.get(id) || null)
      ? []
      : [{ id, before: old.get(id) || null, after: next.get(id) || null }],
  );
  if (!changes.length || changes.length > 200) return null;
  const command = createAppointmentMutation({
    revision: body.revision,
    patientId: change.id,
    changes,
  });
  const build = command.build;
  command.receiptBody = body;
  command.appointmentRead.legacyBefore = before;
  command.build = (current, snapshot) => {
    const visible = cabinetForUser(current, snapshot).patients.find(
      (patient) => patient.id === change.id,
    );
    if (!visible && snapshot.patients.some((patient) => patient.id === change.id))
      throw fail(403, 'Нет доступа к этой карточке.');
    const clean = (patient) =>
      patient ? { ...patient, appointments: patient.appointments.map(editableAppointment) } : null;
    const expected = command.isCompact(snapshot) ? { ...before, visits: [] } : before;
    if (!isDeepStrictEqual(clean(visible), clean(expected)))
      throw fail(
        409,
        'Эта карточка или услуга уже изменена. Обновите страницу перед повторным сохранением.',
      );
    return build(current, snapshot);
  };
  return command;
}
module.exports = {
  validateAppointmentCommand,
  createAppointmentMutation,
  createAppointmentPatchMutation,
};
