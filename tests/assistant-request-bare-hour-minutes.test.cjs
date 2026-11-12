const test = require('node:test');
const assert = require('node:assert/strict');
const {
  readDurationMinutes,
  parseDuration,
} = require('../src/server/modules/assistant/language/time/spoken-duration.cjs');
const {
  intentRequestConstraints,
} = require('../src/server/modules/assistant/interpretation/intent-request-duration.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const command = { intent: 'prepareAppointment', duration: 60 };

test('the actual corpus hour-twenty example and whole bare-minute forms retain their complete length', () => {
  const example =
    require('../src/server/modules/assistant/behavior/scenarios/appointment-fields-4.json').find(
      (row) => row.id === 'appt-duration-composite',
    );
  assert.equal(example.current.intent.duration, 80);
  assert.deepEqual(intentRequestConstraints(example.current.intent, example.text), {
    duration: 80,
  });
  for (const [expression, duration] of [
    ['час двадцать', 80],
    ['один час тридцать', 90],
    ['два часа пятнадцать', 135],
    ['час двадцать пять', 85],
    ['два часа двадцать пять', 145],
  ]) {
    assert.equal(readDurationMinutes(expression), duration, expression);
    assert.equal(parseDuration(expression), duration, expression);
    assert.deepEqual(
      intentRequestConstraints(command, 'Запиши Анну на ' + expression + '.'),
      { duration },
      expression,
    );
  }
});

test('an active duration clarification accepts hour-twenty and opens an eighty-minute ordinary form only after review', () => {
  const f = dialogueFixture();
  let result = f.flow.start(
    f.c,
    {
      intent: 'prepareAppointment',
      query: 'Анна Семёнова',
      serviceQuery: 'Чистка',
      date: day,
      time: '10:00',
    },
    f.state,
    f.member,
    f.clock,
    f.flow.beginCommand(f.c, f.member, f.state),
    { requireDuration: true },
  );
  assert.equal(result.dialogue.step, 'duration');
  const reply = (text) =>
    (result = f.flow.continueDialogue(
      f.c,
      { dialogueId: result.dialogue.id, dialogueVersion: result.dialogue.version, text },
      f.state,
      f.member,
      f.clock,
    ));
  reply('час двадцать');
  assert.equal(result.dialogue.step, 'review');
  assert.equal(result.dialogue.fields.find((row) => row.key === 'duration').value, '80 мин');
  assert.equal(result.action, null);
  assert.equal(reply('открой форму').action.duration, 80);
  assert.equal(f.patients[0].appointments.length, 0);
});

test('invalid minute bounds and non-step bare-minute totals require clarification instead of falling back to sixty', () => {
  for (const [expression, raw] of [
    ['час 60', null],
    ['час шестьдесят', null],
    ['час двадцать семь', 87],
    ['час двадцать три', 83],
    ['час 20.5', null],
  ]) {
    assert.equal(readDurationMinutes(expression), raw, expression);
    assert.equal(parseDuration(expression), null, expression);
    assert.deepEqual(
      intentRequestConstraints(command, 'Запиши Анну на ' + expression + '.'),
      { requireDuration: true },
      expression,
    );
  }
});

test('separate dates and clocks are never consumed as bare duration minutes', () => {
  for (const [text, duration] of [
    ['Запиши Анну на час 17 октября в шесть часов вечера.', 60],
    ['Запиши Анну на час 14:30.', 60],
    ['Запиши Анну на час, завтра в 15:00.', 60],
    ['Запиши Анну на час двадцать 17 октября в шесть часов вечера.', 80],
    ['Запиши Анну на один час тридцать в 14:30.', 90],
  ])
    assert.deepEqual(intentRequestConstraints(command, text), { duration }, text);
});

test('bare-minute clock offsets do not replace the explicit length while relative-length modifiers remain inexact', () => {
  assert.deepEqual(
    intentRequestConstraints(command, 'Запиши Анну на 60 минут, точнее на час двадцать позже.'),
    { duration: 60 },
  );
  assert.deepEqual(intentRequestConstraints(command, 'Запиши Анну на час двадцать дольше.'), {
    requireDuration: true,
  });
});
