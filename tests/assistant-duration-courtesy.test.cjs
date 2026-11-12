const test = require('node:test');
const assert = require('node:assert/strict');
const {
  readDurationMinutes,
  parseDuration,
} = require('../src/server/modules/assistant/language/time/spoken-duration.cjs');
const { repairOperation } = require('../src/server/modules/assistant/dialogue/dialogue-repair-parse.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
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

test('one leading or trailing polite marker preserves the whole exact duration including hour-twenty', () => {
  for (const [text, duration] of [
    ['сорок пять минут, пожалуйста', 45],
    ['пожалуйста, сорок пять минут', 45],
    ['час двадцать, пожалуйста.', 80],
    ['Пожалуйста, на час двадцать, пожалуйста!', 80],
  ]) {
    assert.equal(readDurationMinutes(text), duration, text);
    assert.equal(parseDuration(text), duration, text);
  }
});

test('the repair helper handles cleaned courtesy durations while plain answers retain the direct duration handler', () => {
  const entry = { step: 'duration', data: {}, options: new Map() };
  for (const text of ['сорок пять минут', 'два часа'])
    assert.equal(repairOperation(entry, text, { date: day }), null, text);
  for (const text of ['час двадцать, пожалуйста', 'пожалуйста, час двадцать'])
    assert.deepEqual(
      repairOperation(entry, text, { date: day }).edits,
      [{ field: 'duration', text: '80' }],
      text,
    );
});

test('a polite duration answer reaches the reviewed ordinary form without losing its length or saving', () => {
  for (const [text, duration] of [
    ['сорок пять минут, пожалуйста', 45],
    ['пожалуйста, сорок пять минут', 45],
    ['час двадцать, пожалуйста', 80],
    ['пожалуйста, час двадцать', 80],
    ['Пожалуйста, на час двадцать, пожалуйста!', 80],
  ]) {
    const d = clarification();
    const entry = d.f.flow.get(d.f.c, d.f.member, d.f.state, d.result.dialogue.id);
    const before = structuredClone(entry.data);
    d.reply(text);
    assert.equal(d.result.dialogue.step, 'review', text);
    assert.equal(entry.data.date, before.date, text);
    assert.equal(entry.data.time, before.time, text);
    assert.deepEqual(entry.data.patient, before.patient, text);
    assert.deepEqual(entry.data.staff, before.staff, text);
    assert.deepEqual(entry.data.service, before.service, text);
    assert.equal(entry.data.duration, duration, text);
    assert.equal(entry.data.durationSource, 'manual', text);
    assert.equal(
      d.result.dialogue.fields.find((row) => row.key === 'duration').value,
      duration + ' мин',
    );
    assert.equal(d.result.action, null);
    const ready = d.reply('открой форму');
    assert.equal(ready.action.type, 'prepareAppointment', text);
    assert.equal(ready.action.duration, duration, text);
    assert.equal(ready.action.date, before.date, text);
    assert.equal(ready.action.time, before.time, text);
    assert.equal(d.f.patients[0].appointments.length, 0);
  }
});

test('explicit starting-time corrections keep their field while an exact duration answer changes only length', () => {
  for (const text of ['время на 14:30', 'в 14:30']) {
    const d = clarification();
    const entry = d.f.flow.get(d.f.c, d.f.member, d.f.state, d.result.dialogue.id);
    const before = structuredClone(entry.data);
    assert.equal(parseDuration(text), null, text);
    d.reply(text);
    assert.equal(d.result.dialogue.step, 'duration', text);
    assert.equal(entry.data.time, '14:30', text);
    assert.equal(entry.data.duration, before.duration, text);
    assert.equal(entry.data.date, before.date, text);
    assert.deepEqual(entry.data.patient, before.patient, text);
    d.reply('час двадцать, пожалуйста');
    assert.equal(d.result.dialogue.step, 'review', text);
    assert.equal(entry.data.duration, 80, text);
    assert.equal(entry.data.time, '14:30', text);
    assert.equal(entry.data.date, before.date, text);
    assert.deepEqual(entry.data.patient, before.patient, text);
    assert.equal(d.result.action, null, text);
    assert.equal(d.f.patients[0].appointments.length, 0, text);
  }
});

test('politeness cannot hide a negation condition extra action or unsupported interior duration text', () => {
  for (const text of [
    'пожалуйста, не сорок пять минут',
    'сорок пять минут если можно, пожалуйста',
    'сорок пять минут, пожалуйста, и сохрани запись',
    'пожалуйста, час двадцать, потом отправь',
    'час, пожалуйста, двадцать',
    'сорок пять минутпожалуйста',
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
    assert.equal(d.f.patients[0].appointments.length, 0);
  }
});
