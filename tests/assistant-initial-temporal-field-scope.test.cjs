const test = require('node:test');
const assert = require('node:assert/strict');
const {
  initialTemporalConstraints,
} = require('../src/server/modules/assistant/language/time/initial-temporal-constraints.cjs');
const {
  intentRequestConstraints,
} = require('../src/server/modules/assistant/interpretation/intent-request-duration.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const clock = { date: '2026-10-15', hour: 10, minute: 30 };
const select = (text) => initialTemporalConstraints({ intent: 'prepareAppointment' }, text, clock);

test('an approximate numeric clock retains a separately exact date while requiring the clock', () => {
  for (const qualifier of ['примерно', 'около', 'приблизительно'])
    assert.deepEqual(
      select('Запиши Анну завтра ' + qualifier + ' в 15:00.'),
      {
        date: '2026-10-16',
        time: null,
      },
      qualifier,
    );
  assert.deepEqual(select('Запиши Анну 18 октября 2026 года примерно в 15:00.'), {
    date: '2026-10-18',
    time: null,
  });
});

test('exact clock alternatives retain tomorrow without choosing an endpoint', () => {
  for (const tail of [
    'в 14:00 или в 16:00',
    'в 14:00 либо 16:00',
    '14:00 или 16:00',
    'в 14:00 или в 16:00 или в 18:00',
  ])
    assert.deepEqual(
      select('Запиши Анну завтра ' + tail + '.'),
      {
        date: '2026-10-16',
        time: null,
      },
      tail,
    );
});

test('an approximate date cannot erase one separately exact clock', () => {
  for (const date of ['примерно завтра', 'около 18 октября 2026 года', 'приблизительно 2026-10-18'])
    assert.deepEqual(
      select('Запиши Анну ' + date + ' в 14:00.'),
      {
        date: null,
        time: '14:00',
      },
      date,
    );
});

test('date alternatives retain one exact clock without choosing a date', () => {
  for (const date of [
    'завтра или послезавтра',
    '16 или 17 октября 2026 года',
    '16 октября или 17 октября',
    '2026-10-16 либо 2026-10-17',
  ])
    assert.deepEqual(
      select('Запиши Анну ' + date + ' в 14:00.'),
      {
        date: null,
        time: '14:00',
      },
      date,
    );
});

test('minute duration alternatives retain exact date and clock in either clause order', () => {
  for (const text of [
    'Запиши Анну завтра в 14:00 на тридцать или сорок минут.',
    'Запиши Анну на 30 либо 40 минут завтра в 14:00.',
    'Запиши Анну завтра длительностью тридцать или сорок минут в 14:00.',
  ])
    assert.deepEqual(select(text), { date: '2026-10-16', time: '14:00' }, text);
});

test('an explicitly approximate minute duration retains the unrelated exact temporal fields', () => {
  for (const duration of ['примерно 30 минут', 'приблизительно тридцать минут']) {
    const text = 'Запиши Анну завтра в 14:00 на ' + duration + '.';
    assert.deepEqual(select(text), { date: '2026-10-16', time: '14:00' }, duration);
  }
});

test('two clearly scoped uncertainties clear only their respective date and clock', () => {
  assert.deepEqual(select('Запиши Анну примерно завтра примерно в 14:00.'), {
    date: null,
    time: null,
  });
  assert.deepEqual(select('Запиши Анну завтра или послезавтра в 14:00 либо в 16:00.'), {
    date: null,
    time: null,
  });
});

test('unscoped preference or service alternatives preserve the conservative fallback', () => {
  for (const text of [
    'Примерно запиши Анну завтра в 14:00.',
    'Запиши Анну завтра в 14:00 на чистку или массаж.',
    'Запиши Анну завтра примерно в 14:00 или к Ирине.',
    'Запиши Анну завтра в 14:00 на тридцать или услугу сорок минут.',
    'Запиши Анну завтра в 14:00 на около тридцати минут.',
    'Запиши Анну завтра в 14:00 на тридцать или сорок минут позже.',
  ])
    assert.deepEqual(select(text), { date: null, time: null }, text);
});

test('negation of an old action or temporal field is not reinterpreted as an isolated qualifier', () => {
  for (const text of [
    'Не переноси старую запись, подготовь новую для Анны завтра в 14:00.',
    'Не записывай Анну завтра примерно в 14:00.',
    'Запиши Анну не завтра в 14:00.',
  ])
    assert.deepEqual(select(text), { date: null, time: null }, text);
});

test('conditional ambiguity is not newly accepted by recognizing an inner clock fragment', () => {
  for (const text of [
    'Если можно, запиши Анну завтра примерно в 14:00.',
    'Запиши Анну завтра примерно в 14:00 при условии согласия.',
  ])
    assert.deepEqual(select(text), { date: null, time: null }, text);
});

test('hard numeric temporal bounds keep the existing refusal', () => {
  for (const text of [
    'Запиши Анну завтра после 14:00.',
    'Запиши Анну завтра между 14:00 и 16:00.',
    'Запиши Анну после 18 октября в 14:00.',
  ])
    assert.throws(() => select(text), { status: 400 }, text);
});

test('scoping uncertainty does not manufacture a future or valid date from an invalid one', () => {
  for (const date of ['14 октября', '31 ноября 2026'])
    assert.deepEqual(
      select('Запиши Анну ' + date + ' примерно в 14:00.'),
      {
        date: null,
        time: null,
      },
      date,
    );
});

test('scoped uncertainty composes with an existing final correction without reviving a retracted value', () => {
  assert.deepEqual(select('Запиши Анну завтра в 14:00, точнее примерно в 15:00.'), {
    date: '2026-10-16',
    time: null,
  });
  assert.deepEqual(select('Запиши Анну завтра в 14:00, точнее 18 или 19 октября.'), {
    date: null,
    time: '14:00',
  });
});

test('a real initial duration clarification retains the exact date and clock without a Save', () => {
  const f = dialogueFixture();
  const text = 'Запиши Анну Семёнову 5 января 2099 года в 10:00 на тридцать или сорок минут.';
  const intent = {
    intent: 'prepareAppointment',
    query: 'Анна Семёнова',
    serviceQuery: 'Чистка',
    date: day,
    time: '10:00',
    duration: 30,
  };
  const constraints = {
    ...intentRequestConstraints(intent, text),
    ...initialTemporalConstraints(intent, text, f.clock),
  };
  assert.deepEqual(constraints, { requireDuration: true, date: day, time: '10:00' });
  const result = f.flow.start(
    f.c,
    intent,
    f.state,
    f.member,
    f.clock,
    f.flow.beginCommand(f.c, f.member, f.state),
    constraints,
  );
  const field = (key) => result.dialogue.fields.find((row) => row.key === key)?.value;
  assert.equal(result.dialogue.step, 'duration');
  assert.equal(field('date'), day);
  assert.equal(field('time'), '10:00');
  assert.equal(field('duration'), undefined);
  assert.equal(result.action, null);
  assert.equal(f.patients[0].appointments.length, 0);
});
