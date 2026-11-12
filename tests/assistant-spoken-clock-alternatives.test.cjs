const test = require('node:test');
const assert = require('node:assert/strict');
const {
  initialTemporalConstraints,
} = require('../src/server/modules/assistant/language/time/initial-temporal-constraints.cjs');
const {
  intentRequestConstraints,
} = require('../src/server/modules/assistant/interpretation/intent-request-duration.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const clock = { date: '2026-10-16', hour: 8, minute: 0 };
const select = (text) => initialTemporalConstraints({ intent: 'prepareAppointment' }, text, clock);

test('spoken clock alternatives retain the independent exact date without selecting an endpoint', () => {
  for (const tail of [
    'в три или в четыре',
    'на три либо на четыре',
    'на час либо на два',
    'на два либо на три',
    'в три или четыре',
    'в три или в четыре или в пять',
  ]) {
    for (const text of ['Запиши Анну завтра ' + tail + '.', 'Запиши Анну ' + tail + ' завтра.'])
      assert.deepEqual(select(text), { date: '2026-10-17', time: null }, text);
  }
  assert.deepEqual(select('Запиши Анну 20 октября 2026 года в три или в четыре.'), {
    date: '2026-10-20',
    time: null,
  });
});

test('mixed exact numeric and spoken clocks share one clock uncertainty scope', () => {
  for (const tail of [
    'в 14:00 или в четыре',
    'в три либо в 16:00',
    'в три часа дня или в четыре часа дня',
    'в 2,30 или в 3,30',
  ])
    assert.deepEqual(
      select('Запиши Анну завтра ' + tail + '.'),
      { date: '2026-10-17', time: null },
      tail,
    );
});

test('date alternatives preserve one exact spoken clock in the inverse field order', () => {
  for (const text of [
    'Запиши Анну завтра или послезавтра в три.',
    'Запиши Анну в три завтра или послезавтра.',
    'Запиши Анну 20 или 21 октября в три.',
  ])
    assert.deepEqual(select(text), { date: null, time: '15:00' }, text);
});

test('unknown mixed negated conditional and invalid alternatives keep the conservative fallback', () => {
  for (const tail of [
    'в три или на чистку',
    'в три или завтра',
    'в три или к Ирине',
    'не в три или в четыре',
    'в три или в двадцать четыре часа',
    'в два три либо в четыре',
    'в три или в четыре при условии согласия',
  ])
    assert.deepEqual(select('Запиши Анну завтра ' + tail + '.'), { date: null, time: null }, tail);
});

test('the initial model clock alternative asks only for time while retaining client service date and catalog duration', () => {
  const f = dialogueFixture();
  const text = 'Запиши Анну Семёнову на Чистка 5 января 2099 года в три или в четыре.';
  const intent = {
    intent: 'prepareAppointment',
    query: 'Анна Семёнова',
    serviceQuery: 'Чистка',
    date: day,
    time: '14:30',
  };
  const constraints = {
    ...intentRequestConstraints(intent, text),
    ...initialTemporalConstraints(intent, text, f.clock),
  };
  assert.deepEqual(constraints, { date: day, time: null });
  let result = f.flow.start(
    f.c,
    intent,
    f.state,
    f.member,
    f.clock,
    f.flow.beginCommand(f.c, f.member, f.state),
    constraints,
  );
  assert.equal(result.dialogue.step, 'time');
  const entry = f.flow.get(f.c, f.member, f.state, result.dialogue.id);
  assert.equal(entry.data.date, day);
  assert.equal(entry.data.patient.id, f.patients[0].id);
  assert.equal(entry.data.service.id, 'clean');
  assert.equal(entry.data.duration, 30);
  assert.equal(entry.data.time, null);
  assert.equal(result.action, null);
  result = f.flow.continueDialogue(
    f.c,
    { dialogueId: result.dialogue.id, dialogueVersion: result.dialogue.version, text: 'в четыре' },
    f.state,
    f.member,
    f.clock,
  );
  assert.equal(result.dialogue.step, 'review');
  result = f.flow.continueDialogue(
    f.c,
    {
      dialogueId: result.dialogue.id,
      dialogueVersion: result.dialogue.version,
      text: 'открой форму',
    },
    f.state,
    f.member,
    f.clock,
  );
  assert.equal(result.action.time, '16:00');
  assert.equal(result.action.date, day);
  assert.equal(result.action.duration, 30);
  assert.ok(f.patients.every((row) => row.appointments.length === 0));
});
