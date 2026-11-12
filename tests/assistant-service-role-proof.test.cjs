const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createPaidBookingFixture } = require('./helpers/assistant-paid-booking-fixture.cjs');
const {
  continuationExample,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-contract.cjs');
const { zonedClock } = require('../src/shared/time-zone.cjs');
const { nextDate } = require('../src/shared/work-schedule.cjs');
async function setup(t, title = 'Ботулинотоксин') {
  const f = await createPaidBookingFixture();
  t.after(() => f.close());
  f.synthetic.services[0].name = title;
  f.synthetic.patients.push({
    id: randomUUID(),
    firstName: 'Ольга',
    lastName: 'Новикова',
    name: 'Ольга Новикова',
    createdBy: f.context.current.accountId,
    appointments: [],
    phone: '',
  });
  f.synthetic.changed();
  const initial = await f.api.turn(f.context, {
    text: 'Запиши Диану Неволину',
    policyVersion: f.scope.policyVersion,
    taskRequestId: randomUUID(),
  });
  assert.equal(initial.dialogue.step, 'service');
  const client = initial.dialogue.fields.find((row) => row.key === 'client').value;
  async function answer(text, fields) {
    f.fixture.hooks.stt = async () => ({ text });
    f.fixture.hooks.llm = async () => ({
      text: JSON.stringify(continuationExample({ operation: 'patch', fields })),
    });
    const context = {
      policyVersion: initial.policyVersion,
      dialogueId: initial.dialogue.id,
      dialogueVersion: initial.dialogue.version,
      taskRequestId: initial.taskRequestId,
    };
    const stt = await f.api.transcribe(f.context, { ...f.fixture.wav(), ...context });
    const reply = await f.api.turn(f.context, { text: stt.text, ...context });
    assert.equal(reply.dialogue.id, initial.dialogue.id);
    assert.equal(f.packages.status(f.context.current.organizationId).usedTasks, 1);
    return reply;
  }
  return { ...f, initial, client, answer };
}
for (const [catalog, text, proposedClient] of [
  ['Ботулинотоксин', 'Ботулотоксин', 'Ботулотоксин'],
  ['Ботулинотерапия', 'Ботулотоксин', 'Ботулотоксин'],
  ['Чистка', 'Ботулотоксин', 'Ботулотоксин'],
  ['Ботулинотоксин', 'на Ботулотоксин', 'Ботулотоксин'],
  ['Ботулинотоксин', 'пожалуйста, Ботулотоксин', 'Ботулотоксин'],
  ['Ботулинотоксин', 'Ботулотоксин', 'Несказанное Имя'],
  ['Ботулинотоксин', 'для клиента Ботулотоксин', 'Ботулотоксин'],
])
  test(
    'pending service cannot replace known client from model role alone: ' +
      catalog +
      ' / ' +
      text +
      ' / source=' +
      (proposedClient === 'Несказанное Имя' ? 'absent' : 'literal'),
    async (t) => {
      const f = await setup(t, catalog);
      const reply = await f.answer(text, { client: proposedClient });
      assert.equal(reply.dialogue.step, 'service');
      assert.equal(
        reply.dialogue.fields.find((row) => row.key === 'client')?.value === f.client,
        true,
        'known client retained',
      );
      assert.match(reply.dialogue.prompt, /услуг/iu);
      assert.doesNotMatch(reply.text, /клиент|имя|телефон/iu);
      assert.equal(reply.action, null);
      assert.equal(f.fixture.calls.stt, 1);
      assert.equal(f.fixture.calls.llm, 1);
    },
  );
test('correct service proposal preserves existing approximate confirmation and known client', async (t) => {
  const f = await setup(t);
  const reply = await f.answer('Ботулотоксин', { service: 'Ботулотоксин' });
  assert.equal(reply.dialogue.step, 'service');
  assert.match(reply.dialogue.prompt, /Ботулинотоксин/u);
  assert.equal(
    reply.dialogue.fields.find((row) => row.key === 'client')?.value === f.client,
    true,
    'known client retained',
  );
  assert.equal(reply.action, null);
});
test('explicit local client correction at service step remains permitted', async (t) => {
  const f = await setup(t);
  const reply = await f.answer('Клиент Ольга Новикова', { service: 'Ботулотоксин' });
  assert.equal(reply.dialogue.step, 'service');
  assert.equal(
    reply.dialogue.fields.find((row) => row.key === 'client')?.value === 'Ольга Новикова',
    true,
    'explicit replacement selected',
  );
  assert.equal(f.fixture.calls.llm, 0);
});
test('explicit mixed model-owned client and service correction stays atomic', async (t) => {
  const f = await setup(t);
  const date = nextDate(zonedClock(new Date(), 'Europe/Moscow').date);
  const reply = await f.answer('Клиент Ольга Новикова завтра на Ботулотоксин', {
    client: 'Ольга Новикова',
    service: 'Ботулотоксин',
    date,
  });
  assert.equal(f.fixture.calls.llm, 1);
  assert.equal(reply.dialogue.step, 'service');
  assert.equal(
    reply.dialogue.fields.find((row) => row.key === 'client')?.value === 'Ольга Новикова',
    true,
    'explicit replacement selected',
  );
  assert.ok(reply.dialogue.fields.some((row) => row.key === 'date'));
  assert.match(reply.dialogue.prompt, /Ботулинотоксин/u);
  assert.equal(reply.action, null);
});
