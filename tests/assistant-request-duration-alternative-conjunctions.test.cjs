const test = require('node:test');
const assert = require('node:assert/strict');
const {
  intentRequestConstraints,
} = require('../src/server/modules/assistant/interpretation/intent-request-duration.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');

test('either alternative conjunction keeps both whole explicit lengths instead of selecting the first', () => {
  for (const conjunction of ['или', 'либо'])
    for (const [first, second] of [
      ['один час двадцать минут', 'один час тридцать минут'],
      ['30 минут', '45 минут'],
    ]) {
      const text =
        'Запиши Анну завтра в 15:00 на ' + first + ' ' + conjunction + ' ' + second + '.';
      assert.deepEqual(
        intentRequestConstraints({ intent: 'prepareAppointment', duration: 80 }, text),
        { requireDuration: true },
        text,
      );
    }
  assert.deepEqual(
    intentRequestConstraints(
      { intent: 'prepareAppointment' },
      'Запиши Анну на один час двадцать минут.',
    ),
    { duration: 80 },
  );
});

test('a model or catalog cannot mask a whole-length either alternative before an exact manual answer', () => {
  const f = dialogueFixture();
  f.services[0].duration = 60;
  const intent = {
    intent: 'prepareAppointment',
    query: 'Анна Семёнова',
    serviceQuery: 'Чистка',
    date: day,
    time: '10:00',
    duration: 80,
  };
  const constraints = intentRequestConstraints(
    intent,
    'Запиши Анну на один час двадцать минут либо один час тридцать минут.',
  );
  let result = f.flow.start(
    f.c,
    intent,
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
  reply('85 минут');
  assert.equal(result.dialogue.step, 'review');
  assert.equal(reply('открой форму').action.duration, 85);
  assert.equal(f.patients[0].appointments.length, 0);
});

test('readonly availability refuses either whole-length alternative instead of searching for the first', () => {
  for (const conjunction of ['или', 'либо'])
    assert.throws(
      () =>
        intentRequestConstraints(
          { intent: 'availability', duration: 80 },
          'Найди окно на один час двадцать минут ' + conjunction + ' один час тридцать минут.',
        ),
      { status: 400 },
      conjunction,
    );
});
