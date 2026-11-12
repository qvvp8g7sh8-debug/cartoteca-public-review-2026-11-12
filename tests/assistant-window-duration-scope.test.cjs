const test = require('node:test');
const assert = require('node:assert/strict');
const {
  bookingTemporalConstraints,
} = require('../src/server/modules/assistant/language/time/booking-temporal-constraints.cjs');
const {
  continuationOperation,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-operation.cjs');
const {
  intentRequestConstraints,
} = require('../src/server/modules/assistant/interpretation/intent-request-duration.cjs');
const {
  parseBookingTimeWindow,
} = require('../src/server/modules/assistant/language/time/booking-time-window.cjs');

const intent = { intent: 'prepareAppointment' },
  clock = { date: '2026-10-16', hour: 10, minute: 0 };
const fields = (values) => ({
  client: null,
  staff: null,
  service: null,
  date: null,
  time: null,
  duration: null,
  ...values,
});
function patch(raw, values) {
  return continuationOperation(
    { operation: 'patch', fields: fields(values), choice: null, field: null },
    { text: raw },
    {
      step: 'time',
      data: { date: '2026-10-17', time: null, duration: 80 },
      options: new Map(),
      response: { dialogue: { prompt: 'Во сколько?' } },
    },
    clock,
  );
}

test('a proven numeric window keeps an independently stated complete hour-minute length and date', () => {
  for (const raw of [
    'Запиши Анну завтра с 14:00 до 17:00 на один час двадцать минут',
    'Запиши Анну на один час двадцать минут завтра с 14:00 до 17:00',
    'Запиши Анну завтра не раньше 14:00 на один час и двадцать минут',
    'Запиши Анну завтра до 17:00 на один час двадцать минут',
  ]) {
    const proof = parseBookingTimeWindow(raw);
    assert.equal(proof.status, 'valid', raw);
    assert.deepEqual(
      intentRequestConstraints(intent, proof.maskedText, { provenTimeWindow: true }),
      { duration: 80 },
      raw,
    );
    const result = bookingTemporalConstraints(intent, raw, clock);
    assert.equal(result.duration, 80, raw);
    assert.equal(result.date, '2026-10-17', raw);
    assert.equal(result.time, null, raw);
    assert.equal(result.requireDuration, undefined, raw);
    assert.ok(result.timeWindow, raw);
  }
});

test('a simple whole hour remains a clock and an explicit meridiem keeps a compound clock inside the window', () => {
  for (const [raw, time] of [
    ['Запиши Анну завтра на двенадцать часов', '12:00'],
    ['Запиши Анну завтра с 09:00 до 13:00 на двенадцать часов', '12:00'],
    ['Запиши Анну завтра на два часа тридцать минут', '14:30'],
    ['Запиши Анну завтра с 09:00 до 13:00 на десять часов тридцать минут утра', '10:30'],
    ['Запиши Анну завтра с 13:00 до 17:00 на два часа тридцать минут дня', '14:30'],
  ]) {
    const result = bookingTemporalConstraints(intent, raw, clock);
    assert.equal(result.time, time, raw);
    assert.equal(result.duration, undefined, raw);
  }
});

test('a valid window cannot turn a malformed compound length into its hour prefix or a ready start', () => {
  for (const length of ['один час шестьдесят минут', 'один час и шестьдесят минут']) {
    const result = bookingTemporalConstraints(
      intent,
      'Запиши Анну завтра с 14:00 до 17:00 на ' + length,
      clock,
    );
    assert.equal(result.requireDuration, true, length);
    assert.equal(result.duration, undefined, length);
    assert.equal(result.time, null, length);
    assert.equal(result.date, '2026-10-17', length);
    assert.ok(result.timeWindow, length);
  }
});

test('unproven alternative or conditional ranges cannot authorize a completed temporal interpretation', () => {
  for (const raw of [
    'Запиши Анну завтра если с 14:00 до 17:00 на один час двадцать минут',
    'Запиши Анну завтра с 14:00 до 17:00 или вечером на один час двадцать минут',
    'Запиши Анну завтра с 17:00 до 14:00 на один час двадцать минут',
  ]) {
    const proof = parseBookingTimeWindow(raw);
    assert.notEqual(proof.status, 'valid', raw);
    const result = bookingTemporalConstraints(intent, raw, clock);
    assert.equal(result.timeWindowRequired, true, raw);
    assert.equal(result.timeWindow, null, raw);
    assert.equal(result.time, null, raw);
  }
});

test('a proven negative time bound does not negate a separately grounded client or service', () => {
  for (const [raw, values, field] of [
    ['Запиши Анну завтра не раньше 14:00', { client: 'Анну', date: '2026-10-17' }, 'client'],
    ['Запиши Анну завтра не позже 17:00', { client: 'Анну', date: '2026-10-17' }, 'client'],
    ['Нужна Чистка завтра не раньше 14:00', { service: 'Чистка', date: '2026-10-17' }, 'service'],
  ]) {
    const result = patch(raw, values);
    assert.equal(result.kind, 'modelPatch', raw);
    assert.ok(
      result.edits.some((edit) => edit.field === field),
      raw,
    );
    assert.equal(result.constraints.date, '2026-10-17', raw);
    assert.equal(result.constraints.time, null, raw);
    assert.ok(result.constraints.timeWindow, raw);
  }
});

test('a client negation condition or additional command stays guarded beside a time bound', () => {
  for (const [raw, values] of [
    ['Не Анну завтра не раньше 14:00', { client: 'Анну', date: '2026-10-17' }],
    ['Нет Анну завтра не раньше 14:00', { client: 'Анну', date: '2026-10-17' }],
    ['Не нужна Чистка завтра не позже 17:00', { service: 'Чистка', date: '2026-10-17' }],
    ['Запиши Анну если можно завтра не раньше 14:00', { client: 'Анну', date: '2026-10-17' }],
    ['Запиши Анну завтра не раньше 14:00 и удали записи', { client: 'Анну', date: '2026-10-17' }],
    [
      'Клиента не меняй. Запиши Анну завтра не раньше 14:00',
      { client: 'Анну', date: '2026-10-17' },
    ],
  ]) {
    try {
      const result = patch(raw, values);
      assert.equal(result.kind, 'modelClarify', raw);
    } catch (error) {
      assert.equal(error.status, 400, raw);
    }
  }
});
