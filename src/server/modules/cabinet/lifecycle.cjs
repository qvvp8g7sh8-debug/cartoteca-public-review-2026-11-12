const { fail } = require('../../../shared/errors.cjs');
const same = require('node:util').isDeepStrictEqual;
const {
  isActiveAppointment,
  isClosedAppointment,
} = require('../../../shared/appointment-status.cjs');
const { startsAt } = require('../notifications/appointments.cjs');
const invalid = (message) => {
  throw fail(400, message);
};
function validateServiceItems(record) {
  if (record.serviceItems === undefined) return;
  if (!Array.isArray(record.serviceItems) || record.serviceItems.length > 100)
    invalid('Некорректный список выбранных услуг.');
  const ids = new Set();
  for (const s of record.serviceItems) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) invalid('Некорректная выбранная услуга.');
    for (const [key, max] of [
      ['id', 120],
      ['name', 500],
      ['category', 100],
    ])
      if (typeof s[key] !== 'string' || s[key].length > max)
        invalid('Некорректное поле выбранной услуги.');
    for (const key of ['product', 'description'])
      if (s[key] !== undefined && (typeof s[key] !== 'string' || s[key].length > 2000))
        invalid('Некорректное описание выбранной услуги.');
    if (
      s.categoryTitle !== undefined &&
      (typeof s.categoryTitle !== 'string' || s.categoryTitle.length > 100)
    )
      invalid('Некорректное название группы услуги.');
    if (!s.id || !s.name.trim() || ids.has(s.id))
      invalid('Выбранные услуги должны быть уникальными.');
    ids.add(s.id);
    if (!Number.isSafeInteger(s.duration) || s.duration < 5 || s.duration > 1440 || s.duration % 5)
      invalid('Некорректная длительность выбранной услуги.');
    if (typeof s.price !== 'number' || !Number.isFinite(s.price) || s.price < 0 || s.price > 1e9)
      invalid('Некорректная стоимость выбранной услуги.');
  }
}
function validateLifecycle(patient) {
  const visits = new Map(patient.visits.map((v) => [v.id, v])),
    appointments = new Map(patient.appointments.map((a) => [a.id, a]));
  for (const a of patient.appointments) {
    validateServiceItems(a);
    if (
      a.status !== undefined &&
      !['scheduled', 'completed', 'cancelled', 'no_show'].includes(a.status)
    )
      invalid('Неизвестный статус записи.');
    if (a.outcomeAt !== undefined && (!Number.isSafeInteger(a.outcomeAt) || a.outcomeAt < 0))
      invalid('Некорректная дата закрытия записи.');
    if (
      a.outcomeBy !== undefined &&
      (typeof a.outcomeBy !== 'string' || !a.outcomeBy || a.outcomeBy.length > 120)
    )
      invalid('Некорректный автор закрытия записи.');
    if (!isClosedAppointment(a) && (a.outcomeAt !== undefined || a.outcomeBy !== undefined))
      invalid('Отметка закрытия допустима только для отмены или неявки.');
    if (a.status === 'completed') {
      const v = visits.get(a.completedVisitId);
      if (!v || v.appointmentId !== a.id)
        invalid('Проведённая запись должна быть связана с посещением этой карточки.');
      if (a.staffId && a.staffId !== v.staffId)
        invalid('Специалист записи и посещения должен совпадать.');
    } else if (a.completedVisitId !== undefined)
      invalid('У запланированной записи не может быть проведённого посещения.');
  }
  for (const v of patient.visits) {
    validateServiceItems(v);
    if (v.time !== undefined && v.time !== '' && !/^([01]\d|2[0-3]):[0-5][05]$/.test(v.time))
      invalid('Время посещения должно быть с шагом 5 минут.');
    if (
      v.duration !== undefined &&
      (!Number.isSafeInteger(v.duration) || v.duration > 1440 || v.duration < 5 || v.duration % 5)
    )
      invalid('Некорректная длительность посещения.');
    if (v.appointmentId !== undefined) {
      const a = appointments.get(v.appointmentId);
      if (!a || a.status !== 'completed' || a.completedVisitId !== v.id)
        invalid('Посещение должно быть связано с единственной проведённой записью этой карточки.');
    }
  }
}
// Only changed links are aligned: unrelated legacy history must not be rewritten.
function alignEarlierVisits(before, next) {
  const patients = new Map(before.patients.map((p) => [p.id, p]));
  for (const p of next.patients) {
    const prior = patients.get(p.id),
      oldAppointments = new Map((prior?.appointments || []).map((a) => [a.id, a])),
      oldVisits = new Map((prior?.visits || []).map((v) => [v.id, v]));
    const visits = new Map(p.visits.map((v) => [v.id, v]));
    for (const a of p.appointments) {
      const v = visits.get(a.completedVisitId);
      if (a.status !== 'completed' || !v || v.appointmentId !== a.id || v.date >= a.date) continue;
      if (same(a, oldAppointments.get(a.id)) && same(v, oldVisits.get(v.id))) continue;
      a.date = v.date;
      if (v.time) a.time = v.time;
    }
  }
}
function assertLifecycleChange(
  before,
  next,
  { actorId, timeZone = 'Europe/Moscow', now = Date.now() } = {},
) {
  const originals = new Map(
    before.patients.flatMap((p) => p.appointments.map((a) => [a.id, { a, patientId: p.id }])),
  );
  for (const p of next.patients)
    for (const a of p.appointments) {
      if (!isClosedAppointment(a)) continue;
      const original = originals.get(a.id),
        old = original?.a;
      if (!old || original.patientId !== p.id)
        invalid('Отменить или отметить неявку можно только для существующей записи.');
      if (isClosedAppointment(old)) {
        if (!same(old, a)) invalid('Закрытую запись нельзя изменять. Создайте новую запись.');
        continue;
      }
      if (!isActiveAppointment(old))
        invalid('Проведённое посещение нельзя отменить или отметить неявкой.');
      for (const field of [
        'date',
        'time',
        'service',
        'duration',
        'staffId',
        'roomId',
        'serviceItems',
        'notes',
      ])
        if (!same(old[field], a[field]))
          invalid('Сначала сохраните изменения записи, затем отметьте её статус.');
      if (a.status === 'no_show' && !(startsAt(old, timeZone) <= now))
        invalid('Неявку можно отметить только после времени начала записи.');
      a.outcomeAt = now;
      a.outcomeBy = actorId;
    }
  const appointments = new Map(
    next.patients.flatMap((p) => {
      const visits = new Map(p.visits.map((v) => [v.id, v]));
      return p.appointments.map((a) => [
        a.id,
        { a, patientId: p.id, visit: visits.get(a.completedVisitId) },
      ]);
    }),
  );
  for (const p of before.patients)
    for (const old of p.appointments) {
      const updated = appointments.get(old.id);
      if (!updated) continue;
      if (isClosedAppointment(old) && !same(old, updated.a))
        invalid('Закрытую запись нельзя изменять. Создайте новую запись.');
      if (old.status !== 'completed') continue;
      if (updated.patientId !== p.id)
        invalid('Нельзя переносить проведённую запись в другую карточку.');
      const v = updated.visit,
        aligned =
          v?.appointmentId === old.id &&
          v.id === old.completedVisitId &&
          v.date < old.date &&
          updated.a.date === v.date &&
          updated.a.time === (v.time || old.time);
      for (const field of [
        'date',
        'time',
        'service',
        'duration',
        'staffId',
        'roomId',
        'serviceItems',
        'status',
        'completedVisitId',
      ]) {
        if (aligned && ['date', 'time'].includes(field)) continue;
        if (JSON.stringify(old[field]) !== JSON.stringify(updated.a[field]))
          invalid('Параметры проведённой записи сохраняются. Изменяйте результаты посещения.');
      }
    }
}
module.exports = { validateLifecycle, alignEarlierVisits, assertLifecycleChange };
