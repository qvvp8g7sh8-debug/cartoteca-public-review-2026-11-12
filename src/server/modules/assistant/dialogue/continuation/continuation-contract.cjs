const { fail } = require('../../../../../shared/errors.cjs');
const { validDate } = require('../../interpretation/intent-schema.cjs');
const { validProposal } = require('../bare-day-proposal.cjs');
const fieldNames = ['client', 'staff', 'service', 'date', 'time', 'duration'];
const operations = ['patch', 'choice', 'slots', 'ready', 'clarify', 'repeat', 'cancel'];
const nullable = (type, extra = {}) => ({ type: [type, 'null'], ...extra });
const fieldProperties = Object.fromEntries(
  fieldNames.map((field) => [
    field,
    field === 'duration'
      ? nullable('integer', { minimum: 5, maximum: 1440, multipleOf: 5 })
      : nullable('string', {
          minLength: 1,
          maxLength: field === 'date' ? 10 : field === 'time' ? 5 : 160,
          ...(field === 'date' ? { pattern: '^\\d{4}-\\d{2}-\\d{2}$' } : {}),
          ...(field === 'time' ? { pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' } : {}),
        }),
  ]),
);
const continuationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['operation', 'fields', 'choice', 'field'],
  properties: {
    operation: { type: 'string', enum: operations },
    fields: {
      type: 'object',
      additionalProperties: false,
      required: fieldNames,
      properties: fieldProperties,
    },
    choice: nullable('integer', { minimum: 1, maximum: 12 }),
    field: { type: ['string', 'null'], enum: [...fieldNames, null] },
  },
};
const emptyContinuationFields = () => Object.fromEntries(fieldNames.map((field) => [field, null]));
// Shared by the prompt and its wire examples. Stored author examples may stay compact.
function continuationExample({ operation, fields = {}, choice = null, field = null }) {
  return parseContinuation({
    operation,
    fields: { ...emptyContinuationFields(), ...fields },
    choice,
    field,
  });
}
const continuationInstructions = [
  'Всегда верни только operation,fields,choice,field. fields — объект ровно с ключами ' +
    fieldNames.join(',') +
    '; у отсутствующих или не изменённых текущей репликой значений null.',
  'patch: хотя бы одно ненулевое значение fields, choice=null,field=null. Если часть данных ясна, а часть требует уточнения, верни patch с ясными значениями; остальные null.',
  'choice: все значения fields=null, field=null, choice — явно названный номер текущего варианта1..12. clarify: все значения fields=null,choice=null,field — одно поле для уточнения.',
  'slots,ready,repeat,cancel: все значения fields=null,choice=null,field=null. Никогда не возвращай fields={} или patch со всеми значениями null. Не добавляй intent,question,text,message,action или missingFields.',
].join('\n');
function record(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function parseContinuation(text) {
  let value;
  try {
    value = typeof text === 'string' ? JSON.parse(text) : structuredClone(text);
  } catch {
    throw fail(502, 'Помощник не вернул понятное уточнение. Повторите ответ.');
  }
  const invalid = () => {
    throw fail(502, 'Ответ помощника не соответствует формату уточнения.');
  };
  if (
    !record(value, ['operation', 'fields', 'choice', 'field']) ||
    !operations.includes(value.operation) ||
    !record(value.fields, fieldNames)
  )
    invalid();
  for (const field of fieldNames) {
    const item = value.fields[field];
    if (item === null) continue;
    if (field === 'duration') {
      if (!Number.isSafeInteger(item) || item < 5 || item > 1440 || item % 5) invalid();
    } else if (
      typeof item !== 'string' ||
      !item.trim() ||
      item.length > 160 ||
      /\u0000/u.test(item)
    )
      invalid();
  }
  if (value.fields.date !== null && !validDate(value.fields.date)) invalid();
  if (value.fields.time !== null && !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value.fields.time))
    invalid();
  if (
    value.choice !== null &&
    (!Number.isSafeInteger(value.choice) || value.choice < 1 || value.choice > 12)
  )
    invalid();
  if (value.field !== null && !fieldNames.includes(value.field)) invalid();
  const populated = fieldNames.filter((field) => value.fields[field] !== null);
  if (
    (value.operation === 'patch') !== populated.length > 0 ||
    (value.operation === 'choice') !== (value.choice !== null) ||
    (value.operation === 'clarify') !== (value.field !== null)
  )
    invalid();
  return value;
}
function continuationQuestion(field) {
  return (
    {
      client: 'Назовите имя или телефон клиента.',
      staff: 'Назовите специалиста или выберите текущий вариант.',
      service: 'Назовите услугу или выберите текущий вариант.',
      date: 'На какую точную дату нужна запись?',
      time: 'Назовите точное время с частью суток или попросите подобрать окно.',
      duration: 'Сколько минут должен длиться приём? От 5 до 1440, с шагом 5.',
    }[field] || 'Уточните, что нужно изменить в этой записи.'
  );
}
function safeContinuationContext(entry, role, clock) {
  const data = entry.data;
  const selected = {
    clientQuery: data.clientQuery || '',
    staffQuery: data.staffQuery || '',
    serviceQuery: data.serviceQuery || '',
    date: data.date || null,
    time: data.time || null,
    duration: data.duration || null,
  };
  const resolved = {
    client: !!data.patient,
    staff: !!data.staff,
    service: !!data.serviceChosen,
    date: !!data.date,
    time: !!data.time,
    duration: !!data.duration,
  };
  return {
    step: entry.step,
    ...(validProposal(data.dateProposal)
      ? {
          dateClarification: {
            day: data.dateProposal.day,
            proposedDate: data.dateProposal.date,
            confirmedMonth: /^\d{4}-\d{2}$/u.test(data.dateMonthContext || '')
              ? data.dateMonthContext
              : null,
            stage: data.dateProposal.date ? 'monthConfirmation' : 'monthRequired',
          },
        }
      : {}),
    ...(entry.data.timeSelectionStage ? { timeSelectionStage: entry.data.timeSelectionStage } : {}),
    ...(entry.data.timeWindow ? { timeWindow: structuredClone(entry.data.timeWindow) } : {}),
    role,
    clock: { date: clock.date, hour: clock.hour, minute: clock.minute },
    selected,
    missingFields: fieldNames.filter((field) => !resolved[field]),
    options: [...entry.options.values()].map((row, index) => ({
      number: index + 1,
      kind: row.kind,
      ...(row.kind === 'slot'
        ? { date: row.value.date, time: row.value.time, endTime: row.value.endTime }
        : {}),
      ...(['date', 'period', 'freeRange'].includes(row.kind) ? { label: row.label } : {}),
    })),
  };
}
module.exports = {
  continuationSchema,
  continuationInstructions,
  continuationExample,
  parseContinuation,
  continuationQuestion,
  safeContinuationContext,
};
