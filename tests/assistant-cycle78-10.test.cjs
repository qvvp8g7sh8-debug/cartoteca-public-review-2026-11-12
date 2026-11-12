const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const {
  continuationExample,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-contract.cjs');
function prepare(f, text) {
  const body = {
    dialogueId: f.result.dialogue.id,
    dialogueVersion: f.result.dialogue.version,
    text,
  };
  const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
  assert.ok(snapshot);
  return { body, snapshot };
}
function apply(f, p, proposal) {
  return f.flow.applyModelTurn(f.c, p.body, f.state, f.member, f.clock, proposal, p.snapshot);
}
const data = (f, id) => f.flow.get(f.c, f.member, f.state, id).data;
test('a grounded free followup retains the client and reaches the form without saving', () => {
  const f = dialogueFixture();
  f.start({ query: 'Анна Семёнова' });
  const p = prepare(f, 'Тогда мне нужна Чистка, давайте сегодня в шестнадцать тридцать');
  const r = apply(
    f,
    p,
    continuationExample({
      operation: 'patch',
      fields: { service: 'Чистка', date: day, time: '16:30' },
    }),
  );
  assert.equal(r.dialogue.step, 'review');
  assert.equal(data(f, p.body.dialogueId).patient.id, f.patients[0].id);
  const result = f.flow.continueDialogue(
    f.c,
    { dialogueId: r.dialogue.id, dialogueVersion: r.dialogue.version, text: 'открой форму' },
    f.state,
    f.member,
    f.clock,
  );
  assert.equal(result.action?.type, 'prepareAppointment');
  assert.equal(result.action.time, '16:30');
  assert.equal(f.patients[0].appointments.length, 0);
});
test('an unspoken client from the model cannot replace a known client', () => {
  const f = dialogueFixture();
  f.start({ query: 'Анна Семёнова', serviceQuery: 'Чистка', date: day });
  const p = prepare(f, 'Тогда время давайте в шестнадцать тридцать');
  const before = structuredClone(data(f, p.body.dialogueId));
  const r = apply(
    f,
    p,
    continuationExample({ operation: 'patch', fields: { client: 'Ольга', time: '16:30' } }),
  );
  assert.equal(r.action, null);
  assert.equal(data(f, p.body.dialogueId).patient.id, before.patient.id);
  assert.equal(data(f, p.body.dialogueId).date, before.date);
  assert.equal(data(f, p.body.dialogueId).time, before.time);
  assert.equal(f.patients[0].appointments.length, 0);
});
test('the model cannot complete a missing product code from memory', () => {
  const f = dialogueFixture();
  f.start({ query: 'Анна Семёнова', serviceQuery: 'Чистка', date: day });
  const p = prepare(f, 'Лучше мне пилинг PRX пожалуйста');
  const before = structuredClone(data(f, p.body.dialogueId));
  const r = apply(
    f,
    p,
    continuationExample({ operation: 'patch', fields: { service: 'Пилинг PRX-T133' } }),
  );
  assert.equal(r.action, null);
  assert.deepEqual(data(f, p.body.dialogueId).service, before.service);
  assert.equal(f.patients[0].appointments.length, 0);
});
test('a malformed model operation cannot mutate the draft', () => {
  const f = dialogueFixture();
  f.start({ query: 'Анна Семёнова', serviceQuery: 'Чистка', date: day });
  const p = prepare(f, 'Тогда время давайте в шестнадцать тридцать');
  const before = structuredClone(data(f, p.body.dialogueId));
  assert.throws(() => apply(f, p, { operation: 'save', fields: { time: '16:30' } }), {
    status: 502,
  });
  assert.deepEqual(data(f, p.body.dialogueId), before);
  assert.equal(f.patients[0].appointments.length, 0);
});
