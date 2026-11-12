const { isDeepStrictEqual } = require('node:util');
const { fail } = require('../../../shared/errors.cjs');
const { validateState } = require('./validation.cjs');
const { cabinetForUser, mergeCosmetologistCabinet } = require('../access/cabinet-policy.cjs');

// Confirmations and booking provenance are server-owned, not editable patient fields.
function editable(value) {
  const copy = structuredClone(value);
  for (const patient of copy.patients || [])
    for (const appointment of patient.appointments || [])
      for (const field of [
        'bookingSource',
        'telegramConfirmedAt',
        'manualConfirmedAt',
        'manualConfirmedBy',
        'confirmationKey',
        'notificationConfirmedAt',
        'notificationConfirmedChannel',
        'deliveryReady',
        'deliveryPreference',
        'deliveryRevision',
        'deliveryChannel',
        'deliveryChannels',
        'deliveryStatuses',
        'deliveryStatus',
      ])
        delete appointment[field];
  return copy;
}
function validateChanges(body) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !['patients', 'services', 'revision'].includes(key))
  )
    throw fail(400, 'Неверный формат изменений.');
  if (!Number.isSafeInteger(body.revision) || body.revision < 0)
    throw fail(400, 'Некорректная версия картотеки.');
  for (const collection of ['patients', 'services']) {
    const changes = body[collection];
    if (!Array.isArray(changes) || changes.length > 200)
      throw fail(400, 'Сохраняйте не более 200 карточек или услуг за один запрос.');
    const ids = new Set();
    for (const change of changes) {
      if (
        !change ||
        typeof change !== 'object' ||
        Array.isArray(change) ||
        Object.keys(change).some((key) => !['id', 'before', 'after'].includes(key)) ||
        typeof change.id !== 'string' ||
        !change.id ||
        change.id.length > 120 ||
        ids.has(change.id)
      )
        throw fail(400, 'Неверный идентификатор изменения.');
      ids.add(change.id);
      for (const version of ['before', 'after']) {
        const value = change[version];
        if (value === null) continue;
        if (!value || typeof value !== 'object' || Array.isArray(value) || value.id !== change.id)
          throw fail(400, 'Неверная версия карточки или услуги.');
        validateState({
          revision: 0,
          patients: collection === 'patients' ? [value] : [],
          services: collection === 'services' ? [value] : [],
        });
      }
      if (change.before === null && change.after === null) throw fail(400, 'Пустое изменение.');
    }
  }
  return body;
}
function applyChanges(current, before, body) {
  if (current.role === 'cosmetologist' && body.services.length)
    throw fail(403, 'Изменять услуги может владелец или администратор.');
  const visible = editable(cabinetForUser(current, before));
  for (const collection of ['patients', 'services']) {
    const records = new Map(visible[collection].map((value) => [value.id, value]));
    const allIds = new Set(before[collection].map((value) => value.id));
    for (const change of body[collection]) {
      if (allIds.has(change.id) && !records.has(change.id))
        throw fail(403, 'Нет доступа к этой карточке.');
      const expected =
        editable(
          collection === 'patients'
            ? { patients: change.before ? [change.before] : [] }
            : { services: change.before ? [change.before] : [] },
        )[collection][0] || null;
      if (!isDeepStrictEqual(records.get(change.id) || null, expected))
        throw fail(
          409,
          'Эта карточка или услуга уже изменена. Обновите страницу перед повторным сохранением.',
        );
      if (change.after === null) records.delete(change.id);
      else
        records.set(
          change.id,
          editable(
            collection === 'patients' ? { patients: [change.after] } : { services: [change.after] },
          )[collection][0],
        );
    }
    visible[collection] = [...records.values()];
  }
  visible.revision = before.revision;
  if (current.role !== 'cosmetologist') return visible;
  const merged = mergeCosmetologistCabinet(current, before, visible);
  const changedIds = new Set(body.patients.map((change) => change.id)),
    original = new Map(before.patients.map((patient) => [patient.id, patient]));
  return {
    ...merged,
    patients: merged.patients.map((patient) =>
      changedIds.has(patient.id) ? patient : original.get(patient.id) || patient,
    ),
  };
}
function changedResponse(current, saved, body) {
  const visible = cabinetForUser(current, saved);
  const result = {
    revision: saved.revision,
    partialWrites: true,
    ...(saved.appointmentOnly === true ? { appointmentOnly: true } : {}),
  };
  for (const collection of ['patients', 'services']) {
    const changedIds = new Set(body[collection].map((value) => value.id));
    result[collection] = visible[collection].filter((value) => changedIds.has(value.id));
    result[collection === 'patients' ? 'removedPatientIds' : 'removedServiceIds'] = body[collection]
      .filter((value) => value.after === null)
      .map((value) => value.id);
  }
  return result;
}
module.exports = { editable, validateChanges, applyChanges, changedResponse };
