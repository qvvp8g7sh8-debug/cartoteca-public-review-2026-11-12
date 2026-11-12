const test = require('node:test');
const assert = require('node:assert/strict');
const {
  intentRequestConstraints,
} = require('../src/server/modules/assistant/interpretation/intent-request-duration.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const intent = { intent: 'prepareAppointment', duration: 75 };

test('an invalid complete compound length cannot become its earlier valid prefix', () => {
  for (const expression of ['один час шестьдесят минут', '1 час 60 минут', '30 минут 45 минут'])
    assert.deepEqual(
      intentRequestConstraints(intent, 'Запиши Анну на ' + expression + '.'),
      { requireDuration: true },
      expression,
    );
});

test('unsupported seconds or milliseconds cannot disappear from an explicitly stated length', () => {
  for (const expression of [
    '30 минут 30 секунд',
    '30 минут тридцать секунд',
    '30 минут 500 миллисекунд',
  ]) {
    const text = 'Запиши Анну на ' + expression + '.';
    assert.deepEqual(intentRequestConstraints(intent, text), { requireDuration: true }, expression);
    assert.throws(
      () => intentRequestConstraints({ intent: 'availability', duration: 75 }, text),
      { status: 400 },
      expression,
    );
  }
});

test('a whole valid duration remains exact when followed by a separate calendar date or clock clause', () => {
  for (const [text, duration] of [
    ['Запиши Анну на один час тридцать минут.', 90],
    ['Запиши Анну на 1 час 30 минут.', 90],
    ['Запиши Анну на 30 минут завтра.', 30],
    ['Запиши Анну на 30 минут в 14:30.', 30],
    ['Запиши Анну на 30 минут в шесть часов вечера.', 30],
    ['Запиши Анну на один час тридцать минут завтра в 14:30.', 90],
    ['Запиши Анну на 30 минут 18 октября в 14:30.', 30],
    ['Запиши Анну на 30 минут 17 октября в шесть часов вечера.', 30],
  ])
    assert.deepEqual(intentRequestConstraints(intent, text), { duration }, text);
});

test('a catalog or model duration cannot mask an invalid full expression before manual clarification', () => {
  const f = dialogueFixture();
  f.services[0].duration = 60;
  const command = {
    intent: 'prepareAppointment',
    query: 'Анна Семёнова',
    serviceQuery: 'Чистка',
    date: day,
    time: '10:00',
    duration: 75,
  };
  const constraints = intentRequestConstraints(
    command,
    'Запиши Анну на Чистку на 30 минут 30 секунд.',
  );
  let result = f.flow.start(
    f.c,
    command,
    f.state,
    f.member,
    f.clock,
    f.flow.beginCommand(f.c, f.member, f.state),
    constraints,
  );
  assert.equal(result.dialogue.step, 'duration');
  assert.equal(
    result.dialogue.fields.find((row) => row.key === 'duration'),
    undefined,
  );
  assert.equal(result.action, null);
  const reply = (text) =>
    (result = f.flow.continueDialogue(
      f.c,
      { dialogueId: result.dialogue.id, dialogueVersion: result.dialogue.version, text },
      f.state,
      f.member,
      f.clock,
    ));
  reply('45 минут');
  assert.equal(result.dialogue.step, 'review');
  assert.equal(reply('открой форму').action.duration, 45);
  assert.equal(f.patients[0].appointments.length, 0);
});
