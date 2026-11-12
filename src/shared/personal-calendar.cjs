const { validDate } = require('./work-schedule.cjs');
const { fail } = require('./errors.cjs');
const EVENT_LIMIT = 2000;
const eventFields = ['id', 'date', 'time', 'duration', 'staffId', 'notes'];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
function validatePersonalEvent(value) {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !eventFields.includes(key)) ||
    typeof value.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id) ||
    !validDate(value.date) ||
    typeof value.time !== 'string' ||
    !/^([01]\d|2[0-3]):[0-5][05]$/.test(value.time) ||
    !Number.isSafeInteger(value.duration) ||
    value.duration < 5 ||
    value.duration > 1440 ||
    value.duration % 5 ||
    typeof value.staffId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,120}$/.test(value.staffId) ||
    typeof value.notes !== 'string' ||
    value.notes.length > 2000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value.notes)
  )
    throw fail(
      400,
      'Проверьте дату, время, сотрудника и комментарий личного события. Длительность — от 5 до 1440 минут с шагом 5.',
    );
  const event = Object.fromEntries(eventFields.map((key) => [key, value[key]]));
  if (personalEnd(event) > Date.parse('9999-12-31T00:00:00Z') + 86400000)
    throw fail(400, 'Личное событие выходит за поддерживаемый диапазон дат.');
  event.notes = event.notes.trim();
  return event;
}
function personalCollection(value) {
  if (value === undefined) return { version: 1, revision: 0, events: [] };
  if (
    !object(value) ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.events) ||
    value.events.length > EVENT_LIMIT ||
    Object.keys(value).some((key) => !['version', 'revision', 'events'].includes(key))
  )
    throw fail(400, 'Некорректная коллекция личных событий.');
  const events = value.events.map(validatePersonalEvent);
  if (new Set(events.map((event) => event.id)).size !== events.length)
    throw fail(400, 'Идентификаторы личных событий должны отличаться.');
  return { version: 1, revision: value.revision, events };
}
const personalStart = (event) => Date.parse(event.date + 'T' + event.time + ':00Z');
const personalEnd = (event) => personalStart(event) + Number(event.duration ?? 60) * 60000;
const personalOverlap = (left, right) =>
  personalStart(left) < personalEnd(right) && personalStart(right) < personalEnd(left);
function personalInPeriod(events, from, to) {
  if (!from || !to) return events;
  const lower = Date.parse(from + 'T00:00:00Z'),
    upper = Date.parse(to + 'T00:00:00Z') + 86400000;
  return events.filter((event) => personalStart(event) < upper && personalEnd(event) > lower);
}
const personalOccupancy = (event) =>
  Object.fromEntries(['id', 'date', 'time', 'duration', 'staffId'].map((key) => [key, event[key]]));
module.exports = {
  EVENT_LIMIT,
  validatePersonalEvent,
  personalCollection,
  personalStart,
  personalEnd,
  personalOverlap,
  personalInPeriod,
  personalOccupancy,
};
