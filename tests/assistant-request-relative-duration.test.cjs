const test = require('node:test');
const assert = require('node:assert/strict');
const {
  intentRequestConstraints,
} = require('../src/server/modules/assistant/interpretation/intent-request-duration.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const command = {
  intent: 'prepareAppointment',
  query: 'Анна Семёнова',
  serviceQuery: 'Чистка',
  date: day,
  time: '10:00',
  duration: 75,
};

test('an initial relative length is not an exact duration without a trusted original length', () => {
  for (const modifier of ['дольше', 'меньше', 'больше', 'короче', 'длиннее'])
    assert.deepEqual(
      intentRequestConstraints(command, 'Запиши Анну на 30 минут ' + modifier + ', чем обычно.'),
      { requireDuration: true },
      modifier,
    );
});

test('relative length cannot truncate a sixty-minute catalog service or a guessed seventy-five-minute model result to fifteen', () => {
  const f = dialogueFixture();
  f.services[0].duration = 60;
  const constraints = intentRequestConstraints(
    command,
    'Запиши Анну на Чистку на 15 минут дольше, чем обычно.',
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
  reply('75 минут');
  assert.equal(result.dialogue.step, 'review');
  assert.equal(reply('открой форму').action.duration, 75);
  assert.equal(f.patients[0].appointments.length, 0);
});

test('a relative-length correction needs an exact length while a clock offset preserves the already stated length', () => {
  assert.deepEqual(
    intentRequestConstraints(command, 'Запиши Анну на 60 минут, точнее на 15 минут больше.'),
    { requireDuration: true },
  );
  for (const offset of ['позже', 'раньше', 'позднее', 'ранее'])
    assert.deepEqual(
      intentRequestConstraints(
        command,
        'Запиши Анну на 60 минут, точнее на 15 минут ' + offset + '.',
      ),
      { duration: 60 },
      offset,
    );
});

test('readonly windows require an exact length while an ordinary explicit duration stays authoritative', () => {
  assert.throws(
    () =>
      intentRequestConstraints(
        { intent: 'availability', duration: 75 },
        'Найди окно на 15 минут дольше, чем обычно.',
      ),
    { status: 400 },
  );
  assert.deepEqual(intentRequestConstraints(command, 'Запиши Анну на 75 минут.'), { duration: 75 });
});
