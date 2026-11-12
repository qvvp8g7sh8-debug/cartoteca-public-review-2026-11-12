const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const { continuationPayload } = require('../src/server/modules/assistant/dialogue/continuation/continuation-prompt.cjs');
const {
  continuationExamples,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-examples.cjs');
const { continuationSchema } = require('../src/server/modules/assistant/dialogue/continuation/continuation-contract.cjs');
test('continuation payload contains only user queries and numbered option kinds without canonical labels ids or catalogs', () => {
  const f = dialogueFixture();
  f.c.current.accountId = 'SYNTHETIC_PRIVATE_STAFF_ID';
  f.members[0].accountId = f.c.current.accountId;
  f.services[0].staffId = f.c.current.accountId;
  f.changed();
  const result = f.start({
    query: 'Анна',
    serviceQuery: 'Чистка',
    date: day,
    time: '10:00',
    duration: 45,
  });
  const entry = f.flow.get(f.c, f.member, f.state, result.dialogue.id);
  entry.data.patient.label = 'CANONICAL_PRIVATE_CLIENT';
  entry.data.staff.label = 'CANONICAL_PRIVATE_STAFF';
  entry.data.service.label = 'PRIVATE_CATALOG_NAME';
  const body = {
    dialogueId: result.dialogue.id,
    dialogueVersion: result.dialogue.version,
    text: 'Давайте завтра утром',
  };
  const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
  const state = {
    ...f.state,
    providers: { llm: { provider: 'codex' } },
    policy: { ...f.state.policy, limits: { maxOutputTokens: 500 } },
  };
  const built = continuationPayload(body.text, state, snapshot.context, 'Europe/Moscow');
  const wire = JSON.stringify(built.payload);
  for (const secret of [
    entry.data.patient.id,
    entry.data.staff.id,
    snapshot.token,
    entry.id,
    'CANONICAL_PRIVATE_CLIENT',
    'CANONICAL_PRIVATE_STAFF',
    'PRIVATE_CATALOG_NAME',
  ])
    assert.equal(wire.includes(secret), false, secret);
  assert.deepEqual(built.payload.response_format.json_schema.schema, continuationSchema);
  assert.equal(built.payload.response_format.json_schema.name, 'cartoteca_continuation');
  assert.ok(
    Buffer.byteLength(JSON.stringify({ messages: built.payload.messages }) + '\n', 'utf8') <= 32768,
  );
  assert.equal(snapshot.context.selected.clientQuery, 'Анна');
});
test('continuation examples adapt only approved dialogue library phrases and stay within step count and byte budgets', () => {
  for (const step of [
    'client',
    'staff',
    'service',
    'date',
    'time',
    'duration',
    'review',
    'availability',
  ]) {
    const context = { step, missingFields: ['client'] };
    const result = continuationExamples('Давай второй вариант завтра', context);
    assert.ok(result.examples.length <= 12);
    assert.ok(result.metadata.bytes <= 4096);
    assert.ok(result.examples.every((row) => row.step === step));
    assert.ok(result.examples.every((row) => row.expected.operation !== 'help'));
    assert.ok(
      result.metadata.selected.every(
        (row) => row.source === 'continuation' || row.id.startsWith('dialogue-'),
      ),
    );
  }
});
test('non-Codex continuation preserves the provider independent strict server contract without assuming remote JSON-schema support', () => {
  const state = {
    providers: { llm: { provider: 'timeweb' } },
    policy: { limits: { maxOutputTokens: 500 } },
  };
  const context = {
    step: 'service',
    role: 'salon_admin',
    clock: { date: day, hour: 9, minute: 0 },
    selected: {},
    missingFields: ['service'],
    options: [],
  };
  assert.deepEqual(
    continuationPayload('Чистка', state, context, 'Europe/Moscow').payload.response_format,
    { type: 'json_object' },
  );
});
