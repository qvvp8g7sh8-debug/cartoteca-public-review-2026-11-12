const test = require('node:test');
const assert = require('node:assert/strict');
const {
  initialTemporalConstraints,
} = require('../src/server/modules/assistant/language/time/initial-temporal-constraints.cjs');
const {
  bookingTemporalConstraints,
} = require('../src/server/modules/assistant/language/time/booking-temporal-constraints.cjs');
const {
  parseBookingTimeWindow,
} = require('../src/server/modules/assistant/language/time/booking-time-window.cjs');
const {
  continuationOperation,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-operation.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const { nextDate } = require('../src/shared/work-schedule.cjs');
const intent = { intent: 'prepareAppointment' },
  clock = { date: '2026-10-16', hour: 10, minute: 0 };
const select = (raw) => initialTemporalConstraints(intent, raw, clock);
const booking = (raw) => bookingTemporalConstraints(intent, raw, clock);
const fields = (value) => ({
  client: null,
  staff: null,
  service: null,
  date: null,
  time: null,
  duration: null,
  ...value,
});
const proposal = (value) => ({
  operation: 'patch',
  fields: fields(value),
  choice: null,
  field: null,
});
const operation = (raw, value, step = 'date') =>
  continuationOperation(
    proposal(value),
    { text: raw },
    { step, data: { date: '2026-10-17', time: '12:30', duration: 30 }, options: new Map() },
    clock,
  );
const range = {
  kind: 'range',
  from: '14:00',
  to: '16:00',
  fromInclusive: true,
  toInclusive: false,
};

test('a service replacement cannot retract positive date and time in either compact or spaced speech', () => {
  for (const raw of [
    'Завтра в14:30, не консультацию, а молочный пилинг, на сорок пять минут.',
    'Завтра в 14:30, не консультацию, а молочный пилинг, на сорок пять минут.',
    'Не консультацию, а молочный пилинг завтра в 14:30 на сорок пять минут.',
  ])
    assert.deepEqual(booking(raw), { duration: 45, date: '2026-10-17', time: '14:30' }, raw);
});
test('explicit positive clock replacement changes only the clock for numeric and spoken values', () => {
  for (const raw of [
    'Не в12:30, а в14:00, на миндальный пилинг.',
    'Не в 12:30, а в 14:00, на миндальный пилинг.',
    'Не в двенадцать тридцать, а в два часа дня, на миндальный пилинг.',
  ])
    assert.deepEqual(select(raw), { time: '14:00' }, raw);
  assert.deepEqual(select('Завтра не в 12:30, а в 14:00.'), { date: '2026-10-17', time: '14:00' });
});
test('explicit date replacement retains its independent exact clock', () => {
  assert.deepEqual(select('Завтра в 14:30, не завтра, а послезавтра.'), {
    date: '2026-10-18',
    time: '14:30',
  });
  assert.deepEqual(select('Не 31 ноября, а 18 октября в 14:30.'), {
    date: '2026-10-18',
    time: '14:30',
  });
});
test('a retracted date without a positive date replacement stays null even if previously named', () => {
  assert.deepEqual(select('Завтра в 14:30, не завтра, а консультация.'), {
    date: null,
    time: '14:30',
  });
  assert.deepEqual(select('Не сегодня, а массаж.'), { date: null });
});
test('replacement alternatives and bare negation remain unresolved instead of trusting one model answer', () => {
  for (const raw of [
    'Не в 12:30, а в 14:00 или в 15:00.',
    'Не завтра, а послезавтра или 20 октября.',
    'Не завтра в 14:30.',
    'Завтра в 12:30, а может быть в 14:00.',
  ]) {
    const value = booking(raw);
    assert.ok(value.date === null || value.time === null || value.time === undefined, raw);
    assert.notEqual(value.time, '14:00', raw);
  }
});
test('conditional and cancellation language cannot be removed to manufacture positive execution', () => {
  for (const raw of [
    'Если не в 12:30, а в 14:00, на миндальный пилинг.',
    'Не надо завтра в 12:30, а в 14:00 на миндальный пилинг.',
    'Не записывай завтра в 12:30, а в 14:00 на миндальный пилинг.',
  ]) {
    const value = operation(raw, { service: 'миндальный пилинг', time: '14:00' });
    assert.ok(
      value.kind === 'modelClarify' || !value.edits?.some((edit) => edit.field === 'time'),
      raw,
    );
  }
});
test('model temporal values still require heard evidence and exact positive raw service provenance', () => {
  const raw = 'Завтра в14:30, не консультацию, а МОЛОЧНЫЙ пилинг, на сорок пять минут.';
  const result = operation(raw, {
    service: 'молочный пилинг',
    date: '2026-10-17',
    time: '14:30',
    duration: 45,
  });
  assert.equal(result.kind, 'modelPatch');
  assert.deepEqual(result.edits, [
    { field: 'service', text: 'МОЛОЧНЫЙ пилинг' },
    { field: 'date', text: '2026-10-17' },
    { field: 'time', text: '14:30' },
    { field: 'duration', text: '45' },
  ]);
  assert.throws(() => operation(raw, { service: 'молочный пилинг', time: '15:30' }), {
    status: 400,
  });
  assert.throws(() => operation(raw, { service: 'неизвестный пилинг', time: '14:30' }), {
    status: 400,
  });
});
test('both real correction continuations produce all proven fields without trusting missing model temporal values', () => {
  const first = operation(
    'Завтра в14:30, не консультацию, а молочный пилинг, на сорок пять минут.',
    { service: 'молочный пилинг' },
  );
  assert.deepEqual(first.edits, [
    { field: 'service', text: 'молочный пилинг' },
    { field: 'date', text: '2026-10-17' },
    { field: 'time', text: '14:30' },
    { field: 'duration', text: '45' },
  ]);
  const second = operation(
    'Не в12:30, а в14:00, на миндальный пилинг.',
    { service: 'миндальный пилинг' },
    'service',
  );
  assert.deepEqual(second.edits, [
    { field: 'service', text: 'миндальный пилинг' },
    { field: 'time', text: '14:00' },
  ]);
});
test('complete numeric ranges accept bounded missing whitespace in general range constructions', () => {
  for (const token of ['с14до16', 'с14 до16', 'с 14до16', 'с 14 до 16', 'от14по16', 'между14и16']) {
    const proof = parseBookingTimeWindow('Завтра ' + token + ' запиши Анну на консультацию.');
    assert.equal(proof.status, 'valid', token);
    assert.deepEqual(
      proof.window,
      { ...range, fromInclusive: !token.startsWith('между'), toInclusive: token.includes('по') },
      token,
    );
  }
});
test('compact numeric ranges do not accept embedded identifiers, invalid endpoints, units or unresolved alternatives', () => {
  for (const token of [
    'услугас14до16',
    'телефонс14до16',
    'с14:300до16',
    'с14до99',
    'с16до14',
    'с14до16 минут',
    'с14до16 октября',
    'с14до16 или с17до18',
    'если с14до16',
  ])
    assert.notEqual(parseBookingTimeWindow(token).status, 'valid', token);
});
test('compact range proof retains the actual date and duration and cannot become a boundary start', () => {
  assert.deepEqual(booking('Завтра с14до16 запиши Анну на консультацию на сорок пять минут.'), {
    date: '2026-10-17',
    duration: 45,
    time: null,
    timeWindow: range,
  });
  assert.deepEqual(booking('Запиши Анну на консультацию с14до16 завтра.'), {
    date: '2026-10-17',
    time: null,
    timeWindow: range,
  });
});
function fixture(t) {
  const f = dialogueFixture();
  f.services.push(
    { id: 'milk', name: 'Молочный пилинг', duration: 45, staffId: 'owner' },
    { id: 'almond', name: 'Миндальный пилинг', duration: 30, staffId: 'owner' },
  );
  f.c.platform.workSchedules.view = () => ({
    days: {
      [day]: { status: 'working', intervals: [['09:00', '18:00']] },
      [nextDate(day)]: { status: 'working', intervals: [['09:00', '18:00']] },
    },
    closures: {},
  });
  let writes = 0;
  for (const key of ['save', 'write'])
    f.c.tenantStore('org')[key] = () => {
      writes++;
      throw Error('Forbidden save');
    };
  t.after(() => {
    assert.equal(writes, 0);
    assert.ok(f.patients.every((row) => row.appointments.length === 0));
  });
  return f;
}
test('both model continuations reach the ordinary prepared action with all identities retained and no save', (t) => {
  for (const kind of ['date', 'service']) {
    const f = fixture(t);
    const first = kind === 'date';
    let reply = f.flow.start(
      f.c,
      {
        intent: 'prepareAppointment',
        query: 'Анна Семёнова',
        ...(first ? { serviceQuery: 'Чистка' } : { date: nextDate(day), time: '12:30' }),
      },
      f.state,
      f.member,
      f.clock,
      f.flow.beginCommand(f.c, f.member, f.state),
      { openWhenComplete: true },
    );
    assert.equal(reply.dialogue.step, kind);
    const raw = first
      ? 'Завтра в14:30, не консультацию, а молочный пилинг, на сорок пять минут.'
      : 'Не в12:30, а в14:00, на миндальный пилинг.';
    const body = {
      dialogueId: reply.dialogue.id,
      dialogueVersion: reply.dialogue.version,
      text: raw,
    };
    const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
    assert.ok(snapshot);
    reply = f.flow.applyModelTurn(
      f.c,
      body,
      f.state,
      f.member,
      f.clock,
      proposal({
        service: first ? 'молочный пилинг' : 'миндальный пилинг',
        date: first ? nextDate(day) : null,
        time: first ? '14:30' : '14:00',
        duration: first ? 45 : null,
      }),
      snapshot,
    );
    assert.equal(reply.dialogue, null);
    assert.equal(reply.action.type, 'prepareAppointment');
    assert.equal(reply.action.patientId, f.patients[0].id);
    assert.equal(reply.action.staffId, 'owner');
    assert.equal(reply.action.date, nextDate(day));
    assert.equal(reply.action.time, first ? '14:30' : '14:00');
    assert.equal(reply.action.duration, first ? 45 : 30);
    assert.deepEqual(reply.action.serviceIds, [first ? 'milk' : 'almond']);
  }
});

test('whole duration alternatives retain independent date and clock while duration remains unresolved', () => {
  for (const raw of [
    'Завтра в 15:00 на один час двадцать минут либо один час тридцать минут.',
    'На один час двадцать минут либо один час тридцать минут, завтра в 15:00.',
    'Завтра в 15:00 на час двадцать или час тридцать.',
    'Завтра в 15:00 на 1ч20мин или 1ч30мин.',
  ])
    assert.deepEqual(
      booking(raw),
      { requireDuration: true, date: '2026-10-17', time: '15:00' },
      raw,
    );
  for (const raw of [
    'Завтра в 15:00 на час двадцать или как обычно.',
    'Завтра в 15:00 на один час либо непонятно сколько.',
  ]) {
    assert.equal(booking(raw).requireDuration, true, raw);
    assert.equal(booking(raw).time, null, raw);
  }
});
test('a questioned replacement is not accepted as one definite corrected time', () => {
  assert.deepEqual(select('Не в 12:30, а в 14:00?'), { time: null });
});
test('an actual compact range starts with real fitting slots and an explicit clock opens the same unsaved form', (t) => {
  const f = fixture(t),
    raw = 'Завтра с14до16 запиши Анну Семёнову на Чистку.';
  const constraints = bookingTemporalConstraints(intent, raw, f.clock);
  let reply = f.flow.start(
    f.c,
    { intent: 'prepareAppointment', query: 'Анна Семёнова', serviceQuery: 'Чистка' },
    f.state,
    f.member,
    f.clock,
    f.flow.beginCommand(f.c, f.member, f.state),
    { ...constraints, openWhenComplete: true },
  );
  assert.equal(reply.action, null);
  assert.equal(reply.dialogue.phase, 'slots');
  assert.ok(reply.dialogue.options.length >= 1 && reply.dialogue.options.length <= 3);
  for (const option of reply.dialogue.options) {
    const values = option.label.match(/(\d{2}:\d{2})–(\d{2}:\d{2})/u);
    assert.ok(values);
    assert.ok(values[1] >= '14:00');
    assert.ok(values[2] <= '16:00');
  }
  reply = f.flow.continueDialogue(
    f.c,
    { dialogueId: reply.dialogue.id, dialogueVersion: reply.dialogue.version, text: 'в 14:30' },
    f.state,
    f.member,
    f.clock,
  );
  assert.equal(reply.dialogue, null);
  assert.equal(reply.action.type, 'prepareAppointment');
  assert.equal(reply.action.patientId, f.patients[0].id);
  assert.equal(reply.action.date, nextDate(day));
  assert.equal(reply.action.time, '14:30');
  assert.equal(reply.action.duration, 30);
});
