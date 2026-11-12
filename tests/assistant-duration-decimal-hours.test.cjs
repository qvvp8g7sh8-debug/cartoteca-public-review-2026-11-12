const test = require('node:test');
const assert = require('node:assert/strict');
const {
  readDurationMinutes,
  parseDuration,
} = require('../src/server/modules/assistant/language/time/spoken-duration.cjs');
const { repairOperation } = require('../src/server/modules/assistant/dialogue/dialogue-repair-parse.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const examples = [
  ['1,5 часа', 90],
  ['1.5 часа', 90],
  ['0,5 часа', 30],
  ['0.5 часа', 30],
  ['1,25 часа', 75],
  ['1.25 часа', 75],
];
function clarification() {
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
  return {
    f,
    get result() {
      return result;
    },
    reply(text) {
      return (result = f.flow.continueDialogue(
        f.c,
        { dialogueId: result.dialogue.id, dialogueVersion: result.dialogue.version, text },
        f.state,
        f.member,
        f.clock,
      ));
    },
  };
}
test('decimal hours with an explicit hour unit preserve exact whole minutes and the existing duration bounds', () => {
  for (const [text, minutes] of examples) {
    assert.equal(readDurationMinutes(text), minutes, text);
    assert.equal(parseDuration(text), minutes, text);
  }
  for (const text of [
    '1,5',
    '1.5',
    '1:30',
    '-1,5 часа',
    '1,5 минуты',
    '0,1 часа',
    '0,01 часа',
    '24,5 часа',
  ])
    assert.equal(parseDuration(text), null, text);
});
test('comma and dotted decimal-hour answers complete an actual duration clarification and ordinary form without saving', () => {
  for (const [text, minutes] of examples) {
    const d = clarification();
    assert.equal(d.result.dialogue.step, 'duration');
    d.reply(text);
    assert.equal(d.result.dialogue.step, 'review', text);
    assert.equal(
      d.result.dialogue.fields.find((row) => row.key === 'duration').value,
      minutes + ' мин',
      text,
    );
    assert.equal(d.result.dialogue.fields.find((row) => row.key === 'time').value, '10:00', text);
    assert.equal(d.result.action, null, text);
    const ready = d.reply('открой форму');
    assert.equal(ready.action.type, 'prepareAppointment', text);
    assert.equal(ready.action.duration, minutes, text);
    assert.equal(ready.action.time, '10:00', text);
    assert.equal(d.f.patients[0].appointments.length, 0, text);
  }
});
test('a decimal duration cannot discard negation conditions alternatives or extra actions', () => {
  for (const text of [
    'не 1,5 часа',
    '1.5 часа если можно',
    '1,25 часа или 2 часа',
    '1.25 часа и открой форму',
    '1,5 часа и сохрани',
  ]) {
    assert.equal(parseDuration(text), null, text);
    const d = clarification();
    const entry = d.f.flow.get(d.f.c, d.f.member, d.f.state, d.result.dialogue.id);
    const before = structuredClone(entry.data);
    try {
      d.reply(text);
    } catch (error) {
      assert.equal(error.status, 400, text);
    }
    assert.deepEqual(entry.data, before, text);
    assert.equal(d.result.action, null, text);
    assert.equal(d.f.patients[0].appointments.length, 0, text);
  }
});
test('duration precedence stays in its expected field while decimal shifts preserve the appointment length', () => {
  const entry = { step: 'time', data: {}, options: new Map() };
  assert.equal(repairOperation(entry, '1.25 часа', { date: day }).kind, 'localHelp');
  assert.deepEqual(repairOperation(entry, 'в 14:30', { date: day }).edits, [
    { field: 'time', text: '14:30' },
  ]);
  assert.deepEqual(repairOperation(entry, '6 января 2099 года', { date: day }).edits, [
    { field: 'date', text: '2099-01-06' },
  ]);
  const f = dialogueFixture();
  f.start({
    query: 'Анна Семёнова',
    serviceQuery: 'Чистка',
    date: day,
    time: '10:00',
    duration: 45,
  });
  f.answer({ text: 'на 1,5 часа позже' });
  assert.equal(f.result.dialogue.step, 'review');
  assert.equal(f.result.dialogue.fields.find((row) => row.key === 'time').value, '11:30');
  assert.equal(f.result.dialogue.fields.find((row) => row.key === 'duration').value, '45 мин');
  const ready = f.answer({ text: 'открой форму' }).result;
  assert.equal(ready.action.time, '11:30');
  assert.equal(ready.action.duration, 45);
  assert.equal(f.patients[0].appointments.length, 0);
});
