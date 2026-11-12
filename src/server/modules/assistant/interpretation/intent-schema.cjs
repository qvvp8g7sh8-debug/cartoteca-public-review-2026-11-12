const { fail } = require('../../../../shared/errors.cjs');
const { intentNames, intentFields, commandFields } = require('./intent-contract.cjs');
function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key)))
    throw fail(400, 'Некорректные настройки помощника.');
}
function boundedText(value, max, label) {
  if (typeof value !== 'string' || value.length > max || /\u0000/.test(value))
    throw fail(400, 'Некорректное поле: ' + label + '.');
  return value;
}
function validDate(value) {
  return (
    typeof value === 'string' &&
    value >= '0001-01-01' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + 'T00:00:00Z')) &&
    new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value
  );
}
function commandCategory(intent) {
  if (intent === 'calendar' || intent === 'availability') return 'calendar';
  if (intent === 'clients' || intent === 'clientCard') return 'clients';
  return ['prepareAppointment', 'moveAppointment', 'cancelAppointment', 'editAppointment'].includes(
    intent,
  )
    ? 'prepareAppointment'
    : null;
}
function normalizeIntent(value) {
  keys(value, intentFields);
  if (!intentNames.includes(value.intent))
    throw fail(502, 'Помощник предложил неподдерживаемое действие.');
  const result = { intent: value.intent };
  for (const key of ['query', 'staffQuery', 'serviceQuery'])
    if (value[key] !== undefined && value[key] !== null)
      result[key] = boundedText(value[key], 160, key).trim();
  for (const key of ['date', 'endDate']) {
    if (value[key] === undefined || value[key] === null) continue;
    if (!validDate(value[key])) throw fail(502, 'Помощник не смог определить дату.');
    if (key === 'endDate' && value.intent !== 'availability')
      throw fail(502, 'Период допустим только для поиска окон.');
    result[key] = value[key];
  }
  if (value.mode !== undefined && value.mode !== null) {
    if (value.intent !== 'calendar' || !['day', 'week', 'month'].includes(value.mode))
      throw fail(502, 'Уточните вид календаря: день, неделя или месяц.');
    result.mode = value.mode;
  }
  if (result.date && result.endDate && result.endDate < result.date)
    throw fail(502, 'Конец периода должен быть не раньше начала.');
  for (const key of ['time', 'endTime']) {
    if (value[key] === undefined || value[key] === null) continue;
    if (typeof value[key] !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value[key]))
      throw fail(502, 'Помощник не смог определить время.');
    if (key === 'endTime' && value.intent !== 'availability')
      throw fail(502, 'Граница времени допустима только для поиска окон.');
    result[key] = value[key];
  }
  if (value.duration !== undefined && value.duration !== null) {
    if (
      !Number.isInteger(value.duration) ||
      value.duration < 5 ||
      value.duration > 1440 ||
      value.duration % 5
    )
      throw fail(502, 'Уточните длительность записи с шагом 5 минут.');
    result.duration = value.duration;
  }
  return result;
}
// Enforce executable semantics only at the model boundary. Historical saved examples
// still use normalizeIntent so stricter command execution cannot invalidate stored policy.
function validateCommandFields(value) {
  const labels = {
    query: 'клиент',
    date: 'дата',
    endDate: 'период',
    time: 'время',
    endTime: 'граница времени',
    mode: 'вид календаря',
    staffQuery: 'специалист',
    serviceQuery: 'услуга',
    duration: 'длительность',
  };
  for (const [key, field] of Object.entries(value))
    if (key !== 'intent' && field !== '' && !commandFields[value.intent]?.includes(key))
      throw fail(
        502,
        'Условие «' +
          (labels[key] || key) +
          '» для этой команды пока не поддерживается. Уточните запрос.',
      );
  return value;
}
module.exports = {
  object,
  keys,
  boundedText,
  validDate,
  normalizeIntent,
  validateCommandFields,
  intentNames,
  commandCategory,
};
