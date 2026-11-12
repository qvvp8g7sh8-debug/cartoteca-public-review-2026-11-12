const test = require('node:test');
const assert = require('node:assert/strict');
const { assistantBoundariesFixture } = require('./helpers/assistant-boundaries-fixture.cjs');
const { dialogueFixture } = require('./helpers/assistant-dialogue-fixture.cjs');

test('proven weekday request uses the actual service local route; conditional tail still asks the model', async (t) => {
  const f = await assistantBoundariesFixture(t);
  const synthetic = dialogueFixture();
  const before = structuredClone(synthetic.patients);
  const c = { ...f.context('owner'), tenantStore: synthetic.c.tenantStore };
  const request = (text) => f.api.turn(c, { policyVersion: f.revision(), text });
  f.hooks.llm = async () => ({ text: JSON.stringify({ intent: 'help' }) });
  for (const weekday of ['пятницу', 'следующий понедельник']) {
    const result = await request('Запиши клиента Анну Семёнову на ' + weekday + ' в 11:00');
    assert.equal(result.intent, 'prepareAppointment');
    assert.equal(f.calls.llm, 0, 'a fully proved weekday must not wait for the model');
    assert.equal(f.calls.stt, 0);
    assert.equal(f.calls.tts, 0);
  }
  const result = await request(
    'Запиши клиента Анну Семёнову на пятницу в 11:00, если она согласна',
  );
  assert.equal(result.intent, 'help');
  assert.equal(f.calls.llm, 1, 'an uncovered condition cannot use the local route');
  assert.deepEqual(
    synthetic.patients,
    before,
    'the local route and abstention never save clinical data',
  );
});

test('on Wednesday a new booking asks today or next Wednesday and accepts either explicit answer', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-11T07:00:00Z') });
  const f = await assistantBoundariesFixture(t);
  const synthetic = dialogueFixture();
  const c = { ...f.context('owner'), tenantStore: synthetic.c.tenantStore };
  const send = (text, dialogue) =>
    f.api.turn(c, {
      policyVersion: f.revision(),
      text,
      ...(dialogue ? { dialogueId: dialogue.id, dialogueVersion: dialogue.version } : {}),
    });
  for (const [answer, date] of [
    ['на сегодня', '2026-11-11'],
    ['на следующую среду', '2026-11-18'],
  ]) {
    const initial = await send('Запиши на среду в 11:00');
    assert.equal(initial.intent, 'prepareAppointment');
    assert.equal(initial.action, null);
    assert.equal(initial.dialogue.step, 'date');
    assert.equal(initial.dialogue.prompt, 'На сегодня или на следующую среду?');
    assert.equal(
      initial.dialogue.fields.some((row) => row.key === 'date'),
      false,
    );
    assert.deepEqual(
      initial.dialogue.options.map((row) => row.label),
      ['На сегодня', 'На следующую среду'],
    );
    const repeated = await send('да', initial.dialogue);
    assert.equal(repeated.dialogue.prompt, initial.dialogue.prompt);
    assert.equal(
      repeated.dialogue.fields.some((row) => row.key === 'date'),
      false,
    );
    const selected = await send(answer, repeated.dialogue);
    assert.equal(selected.dialogue.fields.find((row) => row.key === 'date').value, date);
    assert.equal(selected.dialogue.fields.find((row) => row.key === 'time').value, '11:00');
    assert.equal(selected.action, null);
  }
  assert.equal(f.calls.llm, 0);
  assert.equal(synthetic.patients[0].appointments.length, 0);
});
