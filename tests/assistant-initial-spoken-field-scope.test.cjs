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
const command = { intent: 'prepareAppointment' };
const select = (text) => initialTemporalConstraints(command, text, clock);

test('a fully spoken approximate clock preserves tomorrow and the exact independent compound duration', () => {
  for (const qualifier of ['примерно', 'около', 'приблизительно']) {
    const text = 'Запиши Анну завтра ' + qualifier + ' в шесть часов вечера на час двадцать.';
    assert.deepEqual(select(text), { date: '2026-10-16', time: null }, qualifier);
    assert.deepEqual(intentRequestConstraints(command, text), { duration: 80 });
  }
});

test('whole compound duration alternatives retain one exact date and clock without selecting a duration', () => {
  for (const variants of [
    'час двадцать или час тридцать',
    'один час двадцать минут либо один час тридцать минут',
    '1ч20мин или 1ч30мин',
  ]) {
    const text = 'Запиши Анну завтра в 15:00 на ' + variants + '.';
    assert.deepEqual(select(text), { date: '2026-10-16', time: '15:00' }, variants);
    assert.deepEqual(intentRequestConstraints(command, text), { requireDuration: true });
  }
});

test('clear field order changes preserve the same uncertainty scope', () => {
  assert.deepEqual(select('Запиши Анну примерно в шесть часов вечера завтра на час двадцать.'), {
    date: '2026-10-16',
    time: null,
  });
  assert.deepEqual(select('Запиши Анну на час двадцать или час тридцать в 15:00 завтра.'), {
    date: '2026-10-16',
    time: '15:00',
  });
});

test('negation and conditional clauses remain conservative around the newly recognized spoken fragments', () => {
  for (const text of [
    'Не записывай Анну завтра примерно в шесть часов вечера на час двадцать.',
    'Если можно, запиши Анну завтра примерно в шесть часов вечера на час двадцать.',
    'Запиши Анну завтра в 15:00 на час двадцать или час тридцать при условии согласия.',
  ])
    assert.deepEqual(select(text), { date: null, time: null }, text);
});

test('unknown alternatives are not converted into known duration or clock fragments', () => {
  for (const text of [
    'Запиши Анну завтра в 15:00 на час двадцать или чистку.',
    'Запиши Анну завтра в 15:00 на час двадцать или сорок процедур.',
    'Запиши Анну завтра примерно в шесть часов вечера или к Ирине.',
  ])
    assert.deepEqual(select(text), { date: null, time: null }, text);
});

test('an uncertain relative shift is not classified as an independent appointment duration', () => {
  for (const shift of ['позже', 'раньше'])
    assert.deepEqual(
      select('Запиши Анну завтра в 15:00 на час двадцать или час тридцать ' + shift + '.'),
      { date: null, time: null },
      shift,
    );
});

test('a spoken clock must be consumed fully without truncating an invalid hour or unsupported seconds', () => {
  for (const phrase of ['в двадцать четыре часа', 'в шесть часов пятнадцать секунд'])
    assert.deepEqual(
      select('Запиши Анну завтра примерно ' + phrase + ' на час двадцать.'),
      { date: null, time: null },
      phrase,
    );
});

test('numeric temporal bounds keep their refusal beside a spoken uncertainty fragment', () => {
  for (const text of [
    'Запиши Анну завтра примерно в шесть часов вечера после 14:30.',
    'Запиши Анну завтра в 15:00 на час двадцать или час тридцать не позже 16:00.',
  ])
    assert.throws(() => select(text), { status: 400 }, text);
});

function begin(text, extra = {}) {
  const f = dialogueFixture();
  f.c.platform.workSchedules.view = () => ({
    days: { [day]: { status: 'working', intervals: [['09:00', '21:00']] } },
    closures: {},
  });
  const intent = {
    intent: 'prepareAppointment',
    query: 'Анна Семёнова',
    serviceQuery: 'Чистка',
    date: day,
    time: '15:00',
    duration: 30,
    ...extra,
  };
  const constraints = {
    ...intentRequestConstraints(intent, text),
    ...initialTemporalConstraints(intent, text, f.clock),
  };
  let result = f.flow.start(
    f.c,
    intent,
    f.state,
    f.member,
    f.clock,
    f.flow.beginCommand(f.c, f.member, f.state),
    constraints,
  );
  return {
    f,
    constraints,
    get result() {
      return result;
    },
    field(key) {
      return result.dialogue?.fields.find((row) => row.key === key)?.value;
    },
    answer(text) {
      result = f.flow.continueDialogue(
        f.c,
        { dialogueId: result.dialogue.id, dialogueVersion: result.dialogue.version, text },
        f.state,
        f.member,
        f.clock,
      );
      return result;
    },
  };
}

test('actual spoken-clock clarification retains date service and80 minutes with a real free range until an exact answer', () => {
  const x = begin(
    'Запиши Анну Семёнову 5 января 2099 года примерно в шесть часов вечера на час двадцать.',
  );
  assert.deepEqual(x.constraints, { duration: 80, date: day, time: null });
  assert.equal(x.result.dialogue.step, 'time');
  assert.equal(x.result.dialogue.phase, 'period');
  assert.equal(x.result.dialogue.options.length, 1);
  assert.equal(x.result.dialogue.options[0].label, 'с 09:00 до 21:00');
  assert.equal(x.result.action, null);
  assert.equal(x.field('time'), undefined);
  assert.equal(x.field('date'), day);
  assert.equal(x.field('service'), 'Чистка');
  assert.equal(x.field('duration'), '80 мин');
  x.answer('в 18:00');
  assert.equal(x.result.dialogue.step, 'review');
  assert.equal(x.field('time'), '18:00');
  const ready = x.answer('открой форму');
  assert.equal(ready.action.duration, 80);
  assert.equal(ready.action.time, '18:00');
  assert.equal(x.f.patients[0].appointments.length, 0);
});

test('actual compound duration clarification retains the date service and15:00 until an explicit duration answer', () => {
  const x = begin(
    'Запиши Анну Семёнову 5 января 2099 года в 15:00 на час двадцать или час тридцать.',
  );
  assert.deepEqual(x.constraints, { requireDuration: true, date: day, time: '15:00' });
  assert.equal(x.result.dialogue.step, 'duration');
  assert.equal(x.field('date'), day);
  assert.equal(x.field('time'), '15:00');
  assert.equal(x.field('service'), 'Чистка');
  assert.equal(x.field('duration'), undefined);
  x.answer('80 минут');
  assert.equal(x.result.dialogue.step, 'review');
  const ready = x.answer('открой форму');
  assert.equal(ready.action.duration, 80);
  assert.equal(ready.action.time, '15:00');
  assert.equal(x.f.patients[0].appointments.length, 0);
});
