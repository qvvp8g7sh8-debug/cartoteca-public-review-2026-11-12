const { loadCatalog } = require('../../behavior/behavior-library.cjs');
const { behaviorLimits } = require('../../behavior/behavior-schema.cjs');
const { continuationExample } = require('./continuation-contract.cjs');
const { tokens } = require('../../behavior/example-features.cjs');
const { customContinuationRows } = require('./continuation-example-adaptation.cjs');
const MAX_RELEVANT_EXAMPLES = 6;
const adaptations = {
  'dialogue-pronoun-calendar': { step: 'date', operation: 'patch', fields: { date: '2026-10-16' } },
  'dialogue-slot-only-time': { step: 'time', operation: 'patch', fields: { time: '14:30' } },
  'dialogue-slot-only-name': {
    step: 'client',
    operation: 'patch',
    fields: { client: 'Анна Иванова' },
  },
  'dialogue-confirm-only': { step: 'review', operation: 'ready' },
  'dialogue-no-input': { step: '*', operation: 'clarify' },
  'dialogue-cancel-turn': { step: '*', operation: 'cancel' },
};
const additions = [
  {
    id: 'follow-client-service-bare-ack',
    step: '*',
    text: 'Нет, Ольгу на чистку в18:00',
    operation: 'patch',
    fields: { client: 'Ольгу', service: 'чистку', time: '18:00' },
  },
  {
    id: 'follow-selected-client-service-time',
    step: '*',
    requiresSelection: true,
    text: 'Вторую на Чистку на сегодня в 16:00',
    operation: 'patch',
    fields: { service: 'Чистку', date: '2026-10-15', time: '16:00' },
    referenceDate: '2026-10-15',
  },
  {
    id: 'follow-month-period-reordered',
    step: '*',
    requiresMonth: true,
    text: 'Утром в ноябре',
    operation: 'slots',
  },
  {
    id: 'follow-month-after-lunch',
    step: '*',
    requiresMonth: true,
    text: 'В ноябре после обеда',
    operation: 'slots',
  },
  {
    id: 'follow-month-clock-reordered',
    step: '*',
    requiresMonth: true,
    text: 'В шестнадцать тридцать в ноябре',
    operation: 'patch',
    fields: { time: '16:30' },
  },
  {
    id: 'follow-staff-correction',
    step: '*',
    text: 'Сотрудника поменяй на Марию Иванову',
    operation: 'patch',
    fields: { staff: 'Марию Иванову' },
  },
  {
    id: 'follow-client-labelled',
    step: '*',
    text: 'Клиента поменяй на Ольгу Семёнову',
    operation: 'patch',
    fields: { client: 'Ольгу Семёнову' },
  },
  {
    id: 'follow-client-temporal-composite',
    step: '*',
    text: 'Клиента поменяй на Ольгу Семёнову на сегодня в 16:00',
    operation: 'patch',
    fields: { client: 'Ольгу Семёнову', date: '2026-10-15', time: '16:00' },
    referenceDate: '2026-10-15',
  },
  {
    id: 'follow-client-labelled-ack',
    step: '*',
    text: 'Нет, клиент Ольга Семёнова, давайте завтра в 16:00',
    operation: 'patch',
    fields: { client: 'Ольга Семёнова', date: '2026-10-16', time: '16:00' },
    referenceDate: '2026-10-15',
  },
  {
    id: 'follow-service-labelled',
    step: '*',
    text: 'Услугу поменяй на пилинг PRX',
    operation: 'patch',
    fields: { service: 'пилинг PRX' },
  },
  {
    id: 'follow-date-correction',
    step: '*',
    text: 'Дату поменяй на завтра',
    operation: 'patch',
    fields: { date: '2026-10-16' },
    referenceDate: '2026-10-15',
  },
  {
    id: 'follow-time-correction',
    step: '*',
    text: 'Время поменяй на шестнадцать тридцать',
    operation: 'patch',
    fields: { time: '16:30' },
  },
  {
    id: 'follow-pending-month-period',
    step: '*',
    requiresMonth: true,
    text: 'В ноябре утром',
    operation: 'slots',
  },
  {
    id: 'follow-pending-month-clock',
    step: '*',
    requiresMonth: true,
    text: 'В ноябре в шестнадцать тридцать',
    operation: 'patch',
    fields: { time: '16:30' },
  },
  {
    id: 'follow-service-uncertain-date',
    step: '*',
    text: 'RF лифтинг лицо плюс шея, на двадцатое число',
    operation: 'patch',
    fields: { service: 'RF лифтинг лицо плюс шея' },
  },
  {
    id: 'follow-clock-not-duration',
    step: 'time',
    text: 'На завтра на двенадцать часов',
    operation: 'patch',
    fields: { date: '2026-10-16', time: '12:00' },
    referenceDate: '2026-10-15',
  },
  {
    id: 'follow-service-date',
    step: 'service',
    text: 'Нужна первичная консультация, а день — завтра',
    operation: 'patch',
    fields: { service: 'первичная консультация', date: '2026-10-16' },
    referenceDate: '2026-10-15',
  },
  {
    id: 'follow-natural-second',
    step: '*',
    text: 'Из предложенных мне больше подходит второй',
    operation: 'choice',
    choice: 2,
  },
  {
    id: 'follow-name-correction',
    step: 'client',
    text: 'Не Анну, а Ольгу Семёнову',
    operation: 'patch',
    fields: { client: 'Ольгу Семёнову' },
  },
  {
    id: 'follow-duration',
    step: 'duration',
    text: 'Тогда давайте на час двадцать',
    operation: 'patch',
    fields: { duration: 80 },
  },
  {
    id: 'follow-alternative',
    step: 'time',
    text: 'В два или три часа',
    operation: 'clarify',
    field: 'time',
  },
  {
    id: 'follow-slots',
    step: 'time',
    text: 'Можешь подобрать мне ближайшее свободное время?',
    operation: 'slots',
  },
  {
    id: 'follow-repeat',
    step: '*',
    text: 'Я не расслышал, повтори свой вопрос',
    operation: 'repeat',
  },
  {
    id: 'follow-unsupported-save',
    step: '*',
    text: 'Сохрани запись и отправь клиенту сообщение',
    operation: 'clarify',
  },
];
let cache;
function rows() {
  const catalog = loadCatalog();
  if (cache?.catalog === catalog) return cache.rows;
  const adapted = catalog.cases
    .filter((item) => adaptations[item.id])
    .map((item) => ({
      id: item.id,
      text: item.text,
      referenceDate: item.referenceDate,
      ...adaptations[item.id],
      source: 'library-adapted',
    }));
  cache = {
    catalog,
    rows: [...adapted, ...additions.map((item) => ({ ...item, source: 'continuation' }))],
  };
  return cache.rows;
}
function applicable(row, context) {
  if (row.operation === 'choice') {
    const option = context.options?.find((item) => item.number === row.choice);
    if (
      !option ||
      !['client', 'staff', 'service', 'slot', 'date', 'period', 'freeRange'].includes(option.kind)
    )
      return false;
  }
  if (row.operation === 'ready' && (context.step !== 'review' || context.missingFields?.length))
    return false;
  if (row.requiresMonth && !context.dateClarification) return false;
  if (row.requiresSelection && !context.selectionApplied) return false;
  if (row.fields?.staff && context.role === 'cosmetologist') return false;
  return (
    row.step === '*' ||
    row.step === context.step ||
    (row.operation === 'patch' && /(?:клиент|сотрудник|услуг|дату|время)/iu.test(row.text))
  );
}
function continuationExamples(text, context, { maxWireBytes = Infinity, policy = {} } = {}) {
  const query = new Set(tokens(text));
  const custom = customContinuationRows(policy, context).filter((row) => applicable(row, context));
  const mode = policy.exampleSelection || 'manual';
  const candidates = [...custom, ...(mode === 'manual' && custom.length ? [] : rows())]
    .filter(
      (row) =>
        policy.commands?.prepareAppointment !== false ||
        ['clarify', 'repeat', 'cancel'].includes(row.operation),
    )
    .filter((row) => applicable(row, context));
  const ranked = candidates
    .map((row, order) => {
      const shared = [...new Set(tokens(row.text))].filter((word) => query.has(word)).length;
      return {
        row,
        order,
        shared,
        score:
          (row.step === context.step ? 3 : 0) +
          shared * 2 +
          (row.source === 'custom-adapted' ? 4 : 0),
      };
    })
    .filter(
      ({ row, shared }) =>
        row.step === context.step ||
        shared > 0 ||
        (mode === 'manual' && row.source === 'custom-adapted'),
    )
    .sort((a, b) => b.score - a.score || a.order - b.order);
  if (!ranked.length) {
    const fallback = candidates.find((row) => row.id === 'dialogue-no-input');
    if (fallback) ranked.push({ row: fallback, order: 0, shared: 0, score: 0 });
  }
  const examples = [],
    selected = [];
  let bytes = 2,
    wireBytes = 2;
  for (const { row } of ranked) {
    const example = {
      step: row.step === '*' ? context.step : row.step,
      text: row.text,
      ...(row.referenceDate ? { referenceDate: row.referenceDate } : {}),
      ...(row.referenceTime ? { referenceTime: row.referenceTime } : {}),
      ...(row.operation === 'choice' ? { options: context.options } : {}),
      ...(row.requiresMonth ? { dateClarification: context.dateClarification } : {}),
      ...(row.requiresSelection ? { selectionApplied: context.selectionApplied } : {}),
      expected: continuationExample({
        operation: row.operation,
        ...(row.fields ? { fields: row.fields } : {}),
        ...(row.choice ? { choice: row.choice } : {}),
        ...(row.operation === 'clarify'
          ? {
              field:
                row.field ||
                (['client', 'staff', 'service', 'date', 'time', 'duration'].includes(context.step)
                  ? context.step
                  : context.missingFields[0] || 'time'),
            }
          : {}),
      }),
    };
    const json = JSON.stringify(example),
      separator = examples.length ? 1 : 0;
    const size = Buffer.byteLength(json, 'utf8'),
      wire = Buffer.byteLength(JSON.stringify(json), 'utf8') - 2;
    if (
      examples.length >= Math.min(MAX_RELEVANT_EXAMPLES, behaviorLimits.maxEnabledExamples) ||
      bytes + size + separator > behaviorLimits.maxEnabledExamplesBytes ||
      wireBytes + wire + separator > maxWireBytes
    )
      continue;
    examples.push(example);
    selected.push({ id: row.id, source: row.source, step: row.step });
    bytes += size + separator;
    wireBytes += wire + separator;
  }
  return {
    examples,
    metadata: {
      mode: 'continuation',
      branch: 'create-followup',
      version: 2,
      configuredMode: mode,
      customCandidates: custom.length,
      strategy:
        mode === 'manual' && custom.length ? 'approved-adaptations' : 'applicable-ranked-fallback',
      count: examples.length,
      bytes,
      selected,
      candidates: candidates.length,
    },
  };
}
module.exports = { continuationExamples };
