const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseBookingTimeWindow: parse,
  windowBounds,
  windowLabel,
} = require('../src/server/modules/assistant/language/time/booking-time-window.cjs');
const {
  bookingTemporalConstraints: constraints,
} = require('../src/server/modules/assistant/language/time/booking-temporal-constraints.cjs');
const {
  continuationOperation,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-operation.cjs');
const clock = { date: '2026-10-16', hour: 10, minute: 0 },
  intent = { intent: 'prepareAppointment' };
const shape = (kind, from, to, fromInclusive = true, toInclusive = false) => ({
  kind,
  from,
  to,
  fromInclusive,
  toInclusive,
});
const empty = { client: null, staff: null, service: null, date: null, time: null, duration: null };
const proposal = (operation, fields = {}, extra = {}) => ({
  operation,
  fields: { ...empty, ...fields },
  choice: null,
  field: null,
  ...extra,
});
const entry = (step = 'time') => ({
  step,
  data: { date: '2026-10-17', time: null, duration: 80 },
  options: new Map([
    ['one', { kind: 'slot', value: { time: '09:00' } }],
    ['two', { kind: 'slot', value: { time: '11:00' } }],
  ]),
  response: { dialogue: { prompt: 'Когда?' } },
});
const operation = (raw, value, e = entry()) =>
  continuationOperation(value, { text: raw }, e, clock);

test('named preferences have explicit server bounds and never invent an exact appointment start', () => {
  for (const [raw, window] of [
    ['утром', shape('morning', '06:00', '12:00')],
    ['днём', shape('day', '12:00', '17:00')],
    ['вечером', shape('evening', '17:00', '24:00')],
    ['ночью', shape('night', '00:00', '06:00')],
    ['в любое время', shape('any', '00:00', '24:00')],
    ['после обеда', shape('day', '12:00', '17:00')],
  ]) {
    const result = constraints(
      { ...intent, time: '06:00' },
      'Запиши Анну завтра ' + raw + '.',
      clock,
    );
    assert.deepEqual(result.timeWindow, window, raw);
    assert.equal(result.time, null, raw);
    assert.equal(result.date, '2026-10-17');
    assert.ok(windowLabel(window));
  }
});

test('one clock range or bound retains endpoint inclusivity and the full visit upper boundary', () => {
  for (const [raw, window, bounds] of [
    ['с 14:00 до 17:00', shape('range', '14:00', '17:00'), { time: '14:00', endTime: '17:00' }],
    ['между 14 и 17', shape('range', '14:00', '17:00', false), { time: '14:01', endTime: '17:00' }],
    ['после трёх', shape('range', '15:00', '24:00', false), { time: '15:01', endTime: '24:00' }],
    ['не раньше 14:00', shape('range', '14:00', '24:00'), { time: '14:00', endTime: '24:00' }],
    [
      'не позже 17:00',
      shape('range', '00:00', '17:00', true, true),
      { time: '00:00', endTime: '17:00' },
    ],
    ['с 9 утра до 12 дня', shape('range', '09:00', '12:00'), { time: '09:00', endTime: '12:00' }],
    [
      'с 17 по 20',
      shape('range', '17:00', '20:00', true, true),
      { time: '17:00', endTime: '20:00' },
    ],
  ]) {
    const result = parse(raw);
    assert.equal(result.status, 'valid', raw);
    assert.deepEqual(result.window, window);
    assert.deepEqual(windowBounds(window), bounds);
  }
});

test('masking a proven window protects both date and explicit duration from boundary clocks', () => {
  for (const raw of [
    'Запиши Анну завтра с 14:00 до 17:00 на один час двадцать минут',
    'Запиши Анну на 80 минут завтра между 14 и 17',
  ]) {
    const result = constraints({ ...intent, duration: 30, time: '14:00' }, raw, clock);
    assert.equal(result.date, '2026-10-17');
    assert.equal(result.duration, 80);
    assert.equal(result.requireDuration, undefined);
    assert.equal(result.time, null);
    assert.equal(result.timeWindow.from, '14:00');
  }
});

test('invalid reversed overnight impossible negated or alternative windows clarify only time and retain the explicit date and duration', () => {
  for (const raw of [
    'с 17:00 до 14:00',
    'с 23:00 до 02:00',
    'с 14:70 до 17:00',
    'не утром',
    'утром или вечером',
    'утром или в 15:00',
    'в 15:00 либо утром',
  ]) {
    const result = constraints(intent, 'Запиши Анну завтра ' + raw + ' на 80 минут', clock);
    assert.equal(result.timeWindowRequired, true, raw);
    assert.equal(result.timeWindow, null, raw);
    assert.equal(result.time, null, raw);
    assert.equal(result.date, '2026-10-17', raw);
    assert.equal(result.duration, 80, raw);
  }
});

test('an explicit point is retained inside its preference and a contradictory point requires clarification', () => {
  assert.equal(constraints(intent, 'завтра утром в 10:00', clock).time, '10:00');
  assert.equal(constraints(intent, 'завтра утром в 15:00', clock).timeWindowRequired, true);
  for (const raw of ['завтра в девять утром на 80 минут', 'завтра в 9:30 утром на 80 минут']) {
    const result = constraints(intent, raw, clock);
    assert.equal(result.timeWindow, undefined);
    assert.equal(result.time, raw.includes('9:30') ? '09:30' : '09:00');
    assert.equal(result.duration, 80);
  }
});

test('final temporal corrections replace only the preference field and unrelated service corrections keep it', () => {
  const exact = constraints(intent, 'завтра утром, нет, в 15:00', clock);
  assert.equal(constraints(intent, 'завтра утром, точнее 15:00', clock).timeWindow, null);
  assert.equal(exact.time, '15:00');
  assert.equal(exact.timeWindow, null);
  assert.equal(exact.date, '2026-10-17');
  const later = constraints(intent, 'завтра утром, нет, лучше вечером', clock);
  assert.equal(later.timeWindow.kind, 'evening');
  assert.equal(later.date, '2026-10-17');
  assert.equal(
    constraints(intent, 'завтра после 14:00, точнее услуга Чистка', clock).timeWindow.from,
    '14:00',
  );
});

test('calendar and length ranges remain outside booking-clock preference parsing and ordinary availability stays strict', () => {
  for (const raw of [
    'с 17 по 20 октября',
    'длительностью от 1 до 2 часов',
    'на 30 до 60 минут',
    'на час двадцать',
  ])
    assert.equal(parse(raw).status, 'none', raw);
  assert.throws(() => constraints(intent, 'с 17 по 20 октября', clock), { status: 400 });
  assert.equal(constraints(intent, 'на час двадцать', clock).duration, 80);
  assert.throws(() => constraints({ intent: 'availability' }, 'на 30 или 45 минут', clock), {
    status: 400,
  });
  const e = entry();
  e.availabilitySearch = true;
  assert.equal(operation('между 14 и 17', proposal('slots'), e).kind, 'modelClarify');
});

test('window helpers reject forged policy bounds unknown fields impossible endpoints and the 24:00 start', () => {
  const good = shape('morning', '06:00', '12:00');
  for (const bad of [
    { ...good, from: '05:00' },
    { ...good, extra: true },
    { ...good, to: '25:00' },
    shape('range', '24:00', '24:00'),
    shape('range', '23:59', '24:00', false),
    shape('range', '12:00', '12:00'),
  ]) {
    assert.equal(windowBounds(bad), null);
    assert.equal(windowLabel(bad), '');
  }
});

test('free model continuations use the proven preference without choosing an invented boundary and preserve other grounded fields', () => {
  for (const raw of ['утром', 'между 14 и 17', 'после трёх']) {
    const result = operation(raw, proposal('slots'));
    assert.equal(result.kind, 'modelPatch', raw);
    assert.equal(result.seekSlots, true);
    assert.equal(result.constraints.time, null);
    assert.ok(result.constraints.timeWindow);
    assert.deepEqual(result.edits, []);
  }
  const lower = operation(
    'Запиши Анну завтра не раньше 14:00',
    proposal('patch', { client: 'Анну', date: '2026-10-17' }),
  );
  assert.equal(lower.kind, 'modelPatch');
  assert.ok(lower.edits.some((row) => row.field === 'client'));
  const result = operation(
    'Мне нужна Чистка завтра вечером',
    proposal('patch', { service: 'Чистка', date: '2026-10-17', time: '17:00' }),
  );
  assert.equal(result.kind, 'modelPatch');
  assert.deepEqual(result.edits, [
    { field: 'service', text: 'Чистка' },
    { field: 'date', text: '2026-10-17' },
  ]);
  assert.equal(result.constraints.timeWindow.kind, 'evening');
});

test('invalid model window continuations ask about time without erasing the independently explicit date', () => {
  const result = operation(
    'завтра утром или вечером',
    proposal('patch', { date: '2026-10-17', time: '06:00' }),
  );
  assert.equal(result.kind, 'modelClarify');
  assert.equal(result.field, 'time');
  assert.equal(result.constraints.date, '2026-10-17');
  assert.equal(result.constraints.timeWindowRequired, true);
  assert.notEqual(operation('не записывай утром', proposal('slots')).kind, 'modelPatch');
});

test('a current explicit numeric option prefix is proven as a whole before the clock-like token fallback', () => {
  assert.deepEqual(operation('номер 2', proposal('choice', {}, { choice: 2 })), {
    kind: 'choice',
    choice: 'two',
  });
  for (const raw of ['не номер 2', 'номер 2 или номер 1', 'если номер 2'])
    assert.notEqual(operation(raw, proposal('choice', {}, { choice: 2 })).kind, 'choice', raw);
});

test('an unsupported whole spoken clock endpoint cannot degrade to its hour prefix or its other upper bound', () => {
  for (const phrase of [
    'после двух тридцати',
    'до двух тридцати',
    'с двух тридцати до четырёх',
    'между двумя тридцатью и четырьмя',
  ]) {
    const value = constraints(intent, 'Запиши Анну завтра ' + phrase + ' на 80 минут', clock);
    assert.equal(value.timeWindowRequired, true, phrase);
    assert.equal(value.timeWindow, null, phrase);
    assert.equal(value.time, null, phrase);
    assert.equal(value.date, '2026-10-17', phrase);
    assert.equal(value.duration, 80, phrase);
  }
});

test('an explicit date immediately after a preference stays separate from unsupported clock continuation digits', () => {
  for (const [date, expected] of [
    ['17 октября', '2026-10-17'],
    ['2099-01-05', '2099-01-05'],
    ['05.01.2099', '2099-01-05'],
  ]) {
    const result = constraints(intent, 'Запиши Анну утром ' + date + ' на 80 минут', clock);
    assert.equal(result.timeWindow?.kind, 'morning', date);
    assert.equal(result.date, expected, date);
    assert.equal(result.duration, 80, date);
    assert.equal(result.time, null, date);
  }
  const dayOnly = constraints(intent, 'Запиши Анну утром 17 числа на 80 минут', clock);
  assert.equal(dayOnly.date, null);
  assert.deepEqual(dayOnly.dateProposal, { day: 17, date: '2026-10-17' });
  assert.equal(dayOnly.timeWindow.kind, 'morning');
  assert.equal(dayOnly.duration, 80);
  assert.equal(
    constraints(intent, 'Запиши Анну завтра после двух тридцати на80минут', clock)
      .timeWindowRequired,
    true,
  );
});

test('a duration answer carrying a period proves the whole length from the same masked source and preserves it through actual slot preparation', () => {
  const raw = 'сорок пять минут утром',
    result = operation(raw, proposal('patch', { duration: 45 }), entry('duration'));
  assert.equal(result.kind, 'modelPatch');
  assert.ok(result.edits.some((row) => row.field === 'duration' && row.text === '45'));
  assert.equal(result.constraints.timeWindow.kind, 'morning');
  const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
  const f = dialogueFixture();
  const started = f.flow.start(
    f.c,
    { intent: 'prepareAppointment', query: 'Анна', serviceQuery: 'Чистка', date: day },
    f.state,
    f.member,
    f.clock,
    f.flow.beginCommand(f.c, f.member, f.state),
    { requireDuration: true, time: null },
  );
  assert.equal(started.dialogue.step, 'duration');
  const body = {
    dialogueId: started.dialogue.id,
    dialogueVersion: started.dialogue.version,
    text: raw,
  };
  const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
  assert.ok(snapshot);
  const next = f.flow.applyModelTurn(
    f.c,
    body,
    f.state,
    f.member,
    f.clock,
    proposal('patch', { duration: 45 }),
    snapshot,
  );
  const data = f.flow.get(f.c, f.member, f.state, next.dialogue.id).data;
  assert.equal(data.duration, 45);
  assert.equal(data.durationSource, 'manual');
  assert.equal(data.timeWindow.kind, 'morning');
  assert.equal(data.time, null);
  assert.equal(next.dialogue.phase, 'slots');
  assert.ok(next.dialogue.options.length > 0 && next.dialogue.options.length <= 3);
  assert.equal(next.action, null);
  assert.ok(f.patients.every((row) => row.appointments.length === 0));
});
