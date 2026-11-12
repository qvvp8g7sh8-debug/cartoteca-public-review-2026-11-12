const test = require('node:test');
const assert = require('node:assert/strict');
const {
  initialState,
  patchSettings,
} = require('../src/server/modules/assistant/access/defaults.cjs');
const { normalizeRules } = require('../src/server/modules/assistant/behavior/behavior-schema.cjs');
const {
  behaviorPromptBudget,
} = require('../src/server/modules/assistant/behavior/behavior-prompt-budget.cjs');
const { promptBytes } = require('../src/server/modules/assistant/interpretation/prompt-budget.cjs');
const { modelPayload } = require('../src/server/modules/assistant/interpretation/intents.cjs');
const {
  continuationPayload,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-prompt.cjs');
const { adminFixture } = require('./helpers/admin-fixture.cjs');
const hugeRules = () =>
  normalizeRules({
    instructions: 'я'.repeat(4000),
    dictionary: 'я'.repeat(4000),
    examples: [],
    exampleSelection: 'automatic',
  });
const context = {
  step: 'date',
  role: 'owner',
  clock: { date: '2099-01-05', hour: 8, minute: 0 },
  selected: {},
  options: [],
  missingFields: ['date', 'time'],
};
test('Codex checks the full initial and continuation messages before provider invocation without truncation', () => {
  const s = initialState();
  s.providers.llm.provider = 'codex';
  Object.assign(s.policy, hugeRules());
  const text = 'я'.repeat(2000);
  assert.throws(
    () => modelPayload(text, s, 'Europe/Moscow'),
    (error) => error.status === 413 && /Реплика не обрезана/u.test(error.message),
  );
  s.policy.instructions = '漢'.repeat(4000);
  s.policy.dictionary = '漢'.repeat(4000);
  for (const compose of [
    () => modelPayload(text, s, 'Europe/Moscow'),
    () => continuationPayload(text, s, context, 'Europe/Moscow'),
  ])
    assert.throws(
      compose,
      (error) => error.status === 413 && /Реплика не обрезана/u.test(error.message),
    );
  assert.equal(s.policy.instructions.length, 4000);
});
test('Timeweb retains all preferences and user text without an invented Codex transport limit', () => {
  const s = initialState();
  s.providers.llm.provider = 'timeweb';
  Object.assign(s.policy, hugeRules());
  const text = 'я'.repeat(2000);
  for (const built of [
    modelPayload(text, s, 'Europe/Moscow'),
    continuationPayload(text, s, context, 'Europe/Moscow'),
  ]) {
    assert.equal(built.payload.messages[1].content, text);
    assert.ok(built.payload.messages[0].content.includes(s.policy.dictionary));
    assert.equal(built.promptBudget.limit, null);
  }
});
test('Codex settings reserve the maximum text and context; valid compositions report exact bytes', () => {
  const s = initialState();
  s.providers.llm.provider = 'codex';
  assert.throws(() => behaviorPromptBudget(s, hugeRules()), { status: 400 });
  const budget = behaviorPromptBudget(s);
  assert.equal(budget.reservedTextChars, 2000);
  assert.ok(budget.continuation.remaining > 0);
  const built = modelPayload('Запиши Анну', s, 'Europe/Moscow');
  assert.equal(built.promptBudget.bytes, promptBytes(built.payload.messages));
  assert.equal(built.promptBudget.remaining, 32768 - built.promptBudget.bytes);
});
test('provider or text-limit settings cannot make the configured rules incompatible', () => {
  const s = initialState();
  Object.assign(s.policy, hugeRules());
  assert.throws(
    () => patchSettings(s, { providers: { llm: { provider: 'codex', model: 'codex-default' } } }),
    { status: 400 },
  );
});
test('administrative preview rejects oversized Codex settings before approval or storage', async (t) => {
  const f = await adminFixture(t);
  const api = f.store.assistant.admin.behavior;
  // Configure only the temporary synthetic store, never live settings.
  const fs = require('node:fs'),
    path = require('node:path');
  const file = path.join(f.platformDirectory, 'assistant-state.enc');
  const s = initialState();
  s.providers.llm.provider = 'codex';
  s.providers.llm.model = 'codex-default';
  fs.writeFileSync(file, f.database.seal(s));
  const before = fs.readFileSync(file);
  assert.throws(
    () => api.preview(f.admin.accountId, { expectedRevision: s.revision, rules: hugeRules() }),
    { status: 400 },
  );
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(api.view(f.admin.accountId).exampleScopes.continuation.version, 2);
});
