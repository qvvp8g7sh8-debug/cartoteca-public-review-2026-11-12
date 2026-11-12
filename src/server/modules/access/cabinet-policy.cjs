const { fail } = require('../../../shared/errors.cjs');
const same = require('node:util').isDeepStrictEqual;
const { assertPublicBookingAppend } = require('./public-booking-policy.cjs');
const byId = (values) => new Map((values || []).map((value) => [value.id, value]));
function assertNoCabinetDeletion(before, next) {
  const nextPatients = byId(next.patients),
    nextServices = byId(next.services);
  for (const service of before.services || [])
    if (!nextServices.has(service.id)) throw fail(403, 'Удалять услуги может только владелец.');
  for (const patient of before.patients || []) {
    const updated = nextPatients.get(patient.id);
    if (!updated) throw fail(403, 'Удалять карточки клиентов может только владелец.');
    const visits = byId(updated.visits),
      appointments = byId(updated.appointments);
    for (const visit of patient.visits || []) {
      const nextVisit = visits.get(visit.id);
      if (!nextVisit) throw fail(403, 'Удалять посещения может только владелец.');
      const photos = new Set((nextVisit.photos || []).map((photo) => photo.data));
      for (const photo of visit.photos || [])
        if (!photos.has(photo.data)) throw fail(403, 'Удалять фотографии может только владелец.');
    }
    for (const appointment of patient.appointments || [])
      if (!appointments.has(appointment.id))
        throw fail(403, 'Удалять записи может только владелец.');
  }
}
function authorizeCabinetChange(current, before, next) {
  if (current.role === 'public_booking') return assertPublicBookingAppend(current, before, next);
  if (current.role === 'owner') return;
  if (!['salon_admin', 'cosmetologist'].includes(current.role))
    throw fail(403, 'Недостаточно прав для изменения картотеки.');
  assertNoCabinetDeletion(before, next);
  const previousVisits = new Map(
    before.patients.flatMap((p) => (p.visits || []).map((v) => [v.id, { v, patientId: p.id }])),
  );
  for (const p of next.patients)
    for (const v of p.visits || []) {
      const prior = previousVisits.get(v.id);
      if (!prior) continue;
      const base = (value) =>
        Object.fromEntries(
          Object.entries(value).filter(([key]) => !['notes', 'photos'].includes(key)),
        );
      if (prior.patientId !== p.id || !same(base(prior.v), base(v)))
        throw fail(
          403,
          'Изменять сведения проведённого посещения может только владелец. Можно добавить заметки и фотографии.',
        );
      const oldNotes = prior.v.notes || '',
        newNotes = v.notes || '';
      if (
        newNotes !== oldNotes &&
        oldNotes &&
        (!newNotes.startsWith(oldNotes) || !/^\s/.test(newNotes.slice(oldNotes.length)))
      )
        throw fail(403, 'Сохранённые заметки нельзя заменять. Добавьте дополнение.');
      const oldPhotos = prior.v.photos || [],
        newPhotos = v.photos || [];
      if (!same(oldPhotos, newPhotos.slice(0, oldPhotos.length)))
        throw fail(
          403,
          'Сохранённые фотографии и подписи нельзя изменять. Можно добавить новые фотографии.',
        );
    }
  if (current.role === 'salon_admin') return;
  if (!same(before.services, next.services))
    throw fail(403, 'Изменять услуги может владелец или администратор.');
  const oldPatients = byId(before.patients);
  for (const patient of next.patients || []) {
    const prior = oldPatients.get(patient.id);
    if (!prior && ((patient.clientMark && patient.clientMark !== 'none') || patient.clientMarkNote))
      throw fail(403, 'Метки клиентов изменяет владелец или администратор.');
    if (prior) {
      if (patient.createdBy !== prior.createdBy)
        throw fail(403, 'Сотрудник не может изменять автора карточки.');
      // videoConsent is deliberately editable for every role on an accessible patient.
      for (const field of [
        'name',
        'firstName',
        'lastName',
        'middleName',
        'designation',
        'clientMark',
        'clientMarkNote',
        'phone',
        'birth',
        'allergies',
        'notes',
      ])
        if ((prior[field] || '') !== (patient[field] || ''))
          throw fail(403, 'Сотрудник не может изменять основные сведения клиента.');
    }
    const oldVisits = byId(prior?.visits),
      oldAppointments = byId(prior?.appointments);
    for (const visit of patient.visits || []) {
      const old = oldVisits.get(visit.id);
      if ((!old || !same(old, visit)) && visit.staffId !== current.accountId)
        throw fail(403, 'Сотрудник может изменять только свои посещения.');
    }
    for (const appointment of patient.appointments || []) {
      const old = oldAppointments.get(appointment.id);
      if ((!old || !same(old, appointment)) && appointment.staffId !== current.accountId)
        throw fail(403, 'Сотрудник может изменять только свои записи.');
    }
  }
}
function cabinetForUser(current, state) {
  if (current.role !== 'cosmetologist') return state;
  const patients = (state.patients || []).flatMap((patient) => {
    const visits = (patient.visits || []).filter((visit) => visit.staffId === current.accountId);
    const appointments = (patient.appointments || []).filter(
      (appointment) => appointment.staffId === current.accountId,
    );
    return patient.createdBy === current.accountId || visits.length || appointments.length
      ? [{ ...patient, visits, appointments }]
      : [];
  });
  return { ...state, patients };
}
function assertPhotoReferences(current, next, photoVisible) {
  if (current.role !== 'cosmetologist') return;
  const checked = new Set();
  for (const patient of next.patients)
    for (const visit of patient.visits || []) {
      // The merged state also contains protected history belonging to colleagues.
      // Only references the employee can submit must be checked, against pre-commit indexes.
      if (visit.staffId !== current.accountId) continue;
      for (const photo of visit.photos || []) {
        const id = photo.data.match(/^\/api\/photos\/([a-f0-9]{32})$/)?.[1];
        if (!id || checked.has(id)) continue;
        if (!photoVisible(id)) throw fail(403, 'Нет доступа к этой фотографии.');
        checked.add(id);
      }
    }
}
function mergeCosmetologistCabinet(current, before, submitted) {
  const visible = new Set(cabinetForUser(current, before).patients.map((p) => p.id));
  for (const incoming of submitted.patients || []) {
    if (before.patients.some((p) => p.id === incoming.id) && !visible.has(incoming.id))
      throw fail(403, 'Нет доступа к этой карточке.');
  }
  assertNoCabinetDeletion(cabinetForUser(current, before), submitted);
  const patients = byId(before.patients);
  for (const incoming of submitted.patients || []) {
    const prior = patients.get(incoming.id);
    if (!prior) {
      if (incoming.createdBy !== current.accountId)
        throw fail(403, 'Сотрудник может создавать карточки только от своего имени.');
      patients.set(incoming.id, structuredClone(incoming));
      continue;
    }
    if (incoming.createdBy !== prior.createdBy)
      throw fail(403, 'Сотрудник не может изменять автора карточки.');
    const otherVisits = (prior.visits || []).filter((visit) => visit.staffId !== current.accountId);
    const otherAppointments = (prior.appointments || []).filter(
      (appointment) => appointment.staffId !== current.accountId,
    );
    patients.set(incoming.id, {
      ...prior,
      ...incoming,
      visits: [...otherVisits, ...(incoming.visits || [])],
      appointments: [...otherAppointments, ...(incoming.appointments || [])],
    });
  }
  return {
    revision: submitted.revision,
    patients: [...patients.values()],
    services: before.services,
  };
}

module.exports = {
  authorizeCabinetChange,
  assertPhotoReferences,
  cabinetForUser,
  mergeCosmetologistCabinet,
};
