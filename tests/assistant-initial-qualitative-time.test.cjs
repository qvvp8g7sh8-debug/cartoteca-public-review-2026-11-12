const test = require('node:test');
const assert = require('node:assert/strict');
const {
  initialTemporalConstraints,
} = require('../src/server/modules/assistant/language/time/initial-temporal-constraints.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const {
  bookingTemporalConstraints,
} = require('../src/server/modules/assistant/language/time/booking-temporal-constraints.cjs');
const clock = { date: '2026-10-15', hour: 10, minute: 30 };
const select = (text, intent = { intent: 'prepareAppointment', time: '11:00' }) =>
  initialTemporalConstraints(intent, text, clock);

test('before or after lunch without a clock retains tomorrow and asks for an exact time', () => {
  for (const phrase of ['после обеда', 'до обеда'])
    assert.deepEqual(
      select('Запиши Анну завтра ' + phrase + '.'),
      { date: '2026-10-16', time: null },
      phrase,
    );
});

test('plain day-part words retain the exact date without inventing a clock', () => {
  for (const phrase of ['утром', 'вечером', 'ночью', 'днём', 'на утро', 'на вечер', 'на ночь'])
    assert.deepEqual(
      select('Запиши Анну завтра ' + phrase + '.'),
      { date: '2026-10-16', time: null },
      phrase,
    );
});

test('a qualitative time alone never manufactures a date or adopts a model-selected clock', () => {
  for (const phrase of ['после обеда', 'до обеда', 'утром', 'на вечер'])
    assert.deepEqual(select('Запиши Анну ' + phrase + '.'), { time: null }, phrase);
});

test('an explicit valid clock keeps precedence over a qualitative phrase', () => {
  for (const [phrase, time] of [
    ['после обеда', '14:30'],
    ['до обеда', '10:00'],
    ['утром', '09:00'],
    ['вечером', '18:00'],
  ])
    assert.deepEqual(
      select('Запиши Анну завтра ' + phrase + ' в ' + time + '.'),
      { date: '2026-10-16', time },
      phrase,
    );
  assert.deepEqual(select('Запиши Анну завтра вечером в 14:70.'), {
    date: '2026-10-16',
    time: null,
  });
});

test('numeric and date bounds remain refused even beside a qualitative day part', () => {
  for (const text of [
    'Запиши Анну завтра после обеда после 15:00.',
    'Запиши Анну завтра до обеда до 11:00.',
    'Запиши Анну завтра утром не раньше 09:00.',
    'Запиши Анну завтра после 14:30.',
    'Запиши Анну завтра между 14:00 и 16:00.',
    'Запиши Анну после 18 октября вечером.',
  ])
    assert.throws(() => select(text), { status: 400 }, text);
});

test('negative or alternative qualitative answers keep conservative clarification', () => {
  for (const text of [
    'Запиши Анну завтра не утром.',
    'Запиши Анну завтра утром или вечером.',
    'Не переноси старую запись, подготовь новую Анне завтра после обеда.',
  ])
    assert.deepEqual(select(text), { date: null, time: null }, text);
});

test('a day-part noun in an explicit service name does not create a clock constraint', () => {
  for (const name of ['Утро', 'Вечер', 'Ночь'])
    assert.deepEqual(
      select('Запиши Анну на услугу ' + name + ' завтра.'),
      { date: '2026-10-16' },
      name,
    );
});

test('actual after-lunch preparation keeps client service and date with real whole-fit day-period slots', () => {
  const f = dialogueFixture();
  const text = 'Запиши Анну Семёнову на Чистку 5 января 2099 года после обеда.';
  const intent = {
    intent: 'prepareAppointment',
    query: 'Анна Семёнова',
    serviceQuery: 'Чистка',
    date: day,
    time: '11:00',
  };
  const constraints = bookingTemporalConstraints(intent, text, f.clock);
  assert.deepEqual(constraints, {
    date: day,
    time: null,
    timeWindow: {
      kind: 'day',
      from: '12:00',
      to: '17:00',
      fromInclusive: true,
      toInclusive: false,
    },
  });
  let result = f.flow.start(
    f.c,
    intent,
    f.state,
    f.member,
    f.clock,
    f.flow.beginCommand(f.c, f.member, f.state),
    constraints,
  );
  const field = (key) => result.dialogue?.fields.find((row) => row.key === key)?.value;
  const answer = (text) => {
    result = f.flow.continueDialogue(
      f.c,
      { dialogueId: result.dialogue.id, dialogueVersion: result.dialogue.version, text },
      f.state,
      f.member,
      f.clock,
    );
    return result;
  };
  const assertDaySlots = () => {
    assert.equal(result.dialogue.step, 'time');
    assert.equal(result.dialogue.phase, 'slots');
    assert.ok(result.dialogue.options.length >= 1 && result.dialogue.options.length <= 3);
    for (const option of result.dialogue.options) {
      const match = /(\d{2}:\d{2})–(\d{2}:\d{2})/u.exec(option.label);
      assert.ok(match);
      assert.ok(match[1] >= '12:00');
      assert.ok(match[2] <= '17:00');
      assert.equal(
        Number(match[2].slice(0, 2)) * 60 +
          Number(match[2].slice(3)) -
          (Number(match[1].slice(0, 2)) * 60 + Number(match[1].slice(3))),
        30,
      );
    }
    assert.equal(result.action, null);
  };
  assertDaySlots();
  assert.match(field('client'), /Анна Семёнова/);
  assert.equal(field('service'), 'Чистка');
  assert.equal(field('date'), day);
  assert.equal(field('time'), 'днём');
  answer('подбери свободное время');
  assertDaySlots();
  assert.equal(field('date'), day);
  answer('в 14:30');
  assert.equal(result.dialogue.step, 'review');
  assert.equal(field('time'), '14:30');
  assert.equal(field('service'), 'Чистка');
  const ready = answer('открой форму');
  assert.equal(ready.action.time, '14:30');
  assert.equal(ready.action.date, day);
  assert.equal(ready.action.duration, 30);
  assert.equal(f.patients[0].appointments.length, 0);
});
