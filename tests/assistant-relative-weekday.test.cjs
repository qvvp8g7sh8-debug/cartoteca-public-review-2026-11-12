const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDateText } = require('../src/server/modules/assistant/language/time/temporal.cjs');
const {
  wholeDateAnswer,
} = require('../src/server/modules/assistant/language/time/whole-date-answer.cjs');
const {
  initialTemporalConstraints,
} = require('../src/server/modules/assistant/language/time/initial-temporal-constraints.cjs');
const {
  bookingTemporalConstraints,
} = require('../src/server/modules/assistant/language/time/booking-temporal-constraints.cjs');
const {
  initialEntities,
} = require('../src/server/modules/assistant/interpretation/entity-provenance.cjs');
const {
  continuationOperation,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-operation.cjs');
const {
  repairOperation,
} = require('../src/server/modules/assistant/dialogue/dialogue-repair-parse.cjs');
const {
  fastBookingOperation,
} = require('../src/server/modules/assistant/dialogue/dialogue-fast-booking.cjs');
const { zonedClock } = require('../src/shared/time-zone.cjs');
const { dialogueFixture } = require('./helpers/assistant-dialogue-fixture.cjs');
const saturday = { date: '2026-10-17', hour: 10, minute: 0 };
const saturdayInstant = Date.parse('2026-10-17T10:00:00+03:00');
// Availability and dialogue TTLs use the same instant as the civil test clock.
// TestContext automatically resets its mocked Date after each test.
test.beforeEach((t) => {
  t.mock.timers.enable({ apis: ['Date'], now: saturdayInstant });
});
const intent = { intent: 'prepareAppointment' };
const select = (raw, clock = saturday) => initialTemporalConstraints(intent, raw, clock);
const future = '2026-10-24';
const nextDays = [
  ['следующий понедельник', '2026-10-19'],
  ['следующий вторник', '2026-10-20'],
  ['следующую среду', '2026-10-21'],
  ['следующий четверг', '2026-10-22'],
  ['следующую пятницу', '2026-10-23'],
  ['следующую субботу', future],
  ['следующее воскресенье', '2026-10-18'],
];
function fixture() {
  const f = dialogueFixture();
  Object.assign(f.clock, saturday);
  f.c.platform.workSchedules.view = () => ({
    days: { [future]: { status: 'working', intervals: [['09:00', '20:00']] } },
    closures: {},
  });
  return f;
}
const entryOf = (f) => f.flow.get(f.c, f.member, f.state, f.result.dialogue.id);
const noSave = (f) => assert.equal(f.patients[0].appointments.length, 0);

test('next weekday is the closest strictly future day for all seven weekdays in the supplied civil clock', () => {
  for (const [phrase, expected] of nextDays) {
    assert.equal(parseDateText('на ' + phrase, saturday), expected, phrase);
    assert.deepEqual(select('Запиши на ' + phrase), { date: expected }, phrase);
    assert.equal(wholeDateAnswer('на ' + phrase, saturday), expected, phrase);
  }
  for (const [today, phrase, expected] of [
    ['2026-10-12', 'следующий понедельник', '2026-10-19'],
    ['2026-10-13', 'следующий вторник', '2026-10-20'],
    ['2026-10-14', 'следующую среду', '2026-10-21'],
    ['2026-10-15', 'следующий четверг', '2026-10-22'],
    ['2026-10-16', 'следующую пятницу', '2026-10-23'],
    ['2026-10-17', 'следующую субботу', future],
    ['2026-10-18', 'следующее воскресенье', '2026-10-25'],
  ])
    assert.equal(parseDateText(phrase, { date: today }), expected, phrase);
  assert.equal(parseDateText('в субботу', saturday), '2026-10-17');
  assert.equal(wholeDateAnswer('в эту субботу', saturday), '2026-10-17');
});

test('finite spoken forms include joined temporal words, inflections and reverse adjective order without fuzzy matching', () => {
  for (const text of [
    'на следующую субботу',
    'наследующую субботу',
    'наследующуюсубботу',
    'вследующуюсубботу',
    'следующая суббота',
    'к следующей субботе',
    'субботу следующую',
    'пожалуйста, на следующую субботу.',
  ]) {
    assert.equal(wholeDateAnswer(text, saturday), future, text);
    assert.deepEqual(select('Запиши ' + text), { date: future }, text);
  }
  for (const text of ['следующую суббот', 'следующую субботутест', 'наследующую консультацию'])
    assert.equal(parseDateText(text, saturday), null, text);
});

test('month year leap-year and upper-year boundaries remain civil calendar operations', () => {
  for (const [date, text, expected] of [
    ['2026-10-31', 'следующую субботу', '2026-11-07'],
    ['2026-12-26', 'следующую субботу', '2027-01-02'],
    ['2026-12-31', 'следующую пятницу', '2027-01-01'],
    ['2028-02-28', 'следующий вторник', '2028-02-29'],
    ['2028-02-29', 'следующий вторник', '2028-03-07'],
    ['9999-12-31', 'следующую пятницу', null],
  ])
    assert.equal(parseDateText(text, { date }), expected, date + ' ' + text);
});

test('organization timezone decides whether Saturday is today; device timezone and DST do not shift dates', () => {
  const instant = new Date('2026-10-16T22:30:00Z');
  const armenia = zonedClock(instant, 'Asia/Yerevan');
  const pacific = zonedClock(instant, 'America/Los_Angeles');
  assert.equal(armenia.date, '2026-10-17');
  assert.equal(pacific.date, '2026-10-16');
  assert.equal(parseDateText('следующую субботу', armenia), future);
  assert.equal(parseDateText('следующую субботу', pacific), '2026-10-17');
  const berlin = zonedClock(new Date('2026-10-24T23:30:00Z'), 'Europe/Berlin');
  assert.equal(berlin.date, '2026-10-25');
  assert.equal(parseDateText('следующее воскресенье', berlin), '2026-11-01');
});

test('explicit dates and conflicting weekdays cannot be replaced by an assumed next occurrence', () => {
  for (const text of [
    'следующую субботу 17 октября 2026',
    'следующую субботу 31 октября 2026',
    'следующую субботу 2026-10-25',
    'следующую субботу завтра',
    'следующую субботу сегодня',
    'следующую субботу или воскресенье',
    'примерно следующую субботу',
    'не следующую субботу',
    'следующую субботу и следующую пятницу',
    'следующую неделю в субботу',
    'в субботу следующей недели',
    'в прошлую субботу',
    'следующего месяца 20 числа',
  ])
    assert.equal(parseDateText(text, saturday), null, text);
  assert.equal(parseDateText('в следующую субботу 24 октября 2026', saturday), future);
  assert.equal(parseDateText('24 октября 2026', saturday), future);
  assert.deepEqual(select('Запиши на следующую субботу 17 октября 2026'), { date: null });
  assert.deepEqual(select('Запиши на следующую субботу 24 октября 2026'), { date: future });
});

test('full initial commands preserve any client/service/time order and override a conflicting model date only with local proof', () => {
  const source = [
    'Запиши Анну Семёнову на Чистку на следующую субботу в 17:00.',
    'На следующую субботу в 17:00 запиши Анну Семёнову на Чистку.',
    'В 17:00 на следующую субботу на Чистку запиши Анну Семёнову.',
  ];
  for (const raw of source) {
    const f = fixture();
    const proposed = {
      ...intent,
      query: 'Анну Семёнову',
      serviceQuery: 'Чистку',
      date: saturday.date,
      time: '09:00',
    };
    const constraints = bookingTemporalConstraints(proposed, raw, f.clock);
    assert.deepEqual(constraints, { date: future, time: '17:00' }, raw);
    const grounded = initialEntities(proposed, raw, constraints);
    const result = f.flow.start(
      f.c,
      grounded,
      f.state,
      f.member,
      f.clock,
      f.flow.beginCommand(f.c, f.member, f.state),
      constraints,
    );
    assert.equal(result.dialogue.step, 'review', raw);
    const fields = Object.fromEntries(result.dialogue.fields.map((row) => [row.key, row.value]));
    assert.equal(fields.date, future, raw);
    assert.equal(fields.time, '17:00', raw);
    assert.equal(fields.service, 'Чистка', raw);
    assert.equal(fields.duration, '30 мин', raw);
    noSave(f);
  }
});

test('a whole next-weekday answer is local, keeps resolved fields, and rechecks the new day before handoff', () => {
  const f = fixture();
  const initial = f.start({ query: 'Анну Семёнову', serviceQuery: 'Чистка' });
  assert.equal(initial.dialogue.step, 'date');
  const entry = entryOf(f);
  const known = structuredClone({
    patient: entry.data.patient,
    staff: entry.data.staff,
    service: entry.data.service,
    duration: entry.data.duration,
  });
  const raw = 'на следующую субботу';
  const body = {
    policyVersion: f.state.revision,
    dialogueId: initial.dialogue.id,
    dialogueVersion: initial.dialogue.version,
    text: raw,
  };
  assert.equal(f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock), null);
  assert.deepEqual(fastBookingOperation(entry, raw, f.clock), {
    kind: 'patch',
    edits: [{ field: 'date', text: future }],
  });
  const after = f.answer({ text: raw }).result;
  assert.equal(entry.data.date, future);
  assert.equal(after.dialogue.step, 'time');
  assert.notEqual(after.dialogue.phase, 'closedDay');
  assert.deepEqual(
    {
      patient: entry.data.patient,
      staff: entry.data.staff,
      service: entry.data.service,
      duration: entry.data.duration,
    },
    known,
  );
  f.answer({ text: '17:00' });
  const form = f.answer({ text: 'открой форму' }).result;
  assert.equal(form.action.type, 'prepareAppointment');
  assert.equal(form.action.date, future);
  assert.equal(form.action.time, '17:00');
  noSave(f);
});

test('mixed followup date/time answers keep their next modifier in both orders and remain locally actionable', () => {
  for (const raw of [
    'на следующую субботу в 17:00',
    'в 17:00 на следующую субботу',
    'в 17:00 наследующуюсубботу',
  ]) {
    const f = fixture();
    f.start({ query: 'Анну Семёнову', serviceQuery: 'Чистка' });
    const entry = entryOf(f);
    const parsed = repairOperation(entry, raw, f.clock);
    assert.equal(parsed.kind, 'patch', raw);
    assert.deepEqual(
      parsed.edits,
      [
        { field: 'date', text: future },
        { field: 'time', text: '17:00' },
      ],
      raw,
    );
    const reply = f.answer({ text: raw }).result;
    assert.equal(reply.dialogue.step, 'review', raw);
    assert.equal(entry.data.date, future, raw);
    assert.equal(entry.data.time, '17:00', raw);
    assert.equal(entry.data.service.id, 'clean', raw);
    noSave(f);
  }
});

test('model continuation needs the same proven weekday and cannot supply a different future Saturday', () => {
  const f = fixture();
  f.start({ query: 'Анну Семёнову', serviceQuery: 'Чистка' });
  const entry = entryOf(f);
  const raw = 'на следующую субботу';
  const proposal = (date) => ({
    operation: 'patch',
    fields: {
      client: null,
      staff: null,
      service: null,
      date,
      time: null,
      duration: null,
    },
    choice: null,
    field: null,
  });
  const parsed = continuationOperation(proposal(future), { text: raw }, entry, f.clock);
  assert.equal(parsed.kind, 'modelPatch');
  assert.deepEqual(parsed.edits, [{ field: 'date', text: future }]);
  assert.throws(
    () => continuationOperation(proposal('2026-10-31'), { text: raw }, entry, f.clock),
    { status: 400 },
  );
  noSave(f);
});
