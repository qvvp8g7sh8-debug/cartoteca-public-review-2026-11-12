const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { initialState, validateState } = require('../src/server/modules/assistant/access/defaults.cjs');
const {
  normalizeRules,
  rulesFromPolicy,
  applyRules,
  compiledExamples,
  behaviorLimits,
} = require('../src/server/modules/assistant/behavior/behavior-schema.cjs');
const { normalizeBehavior } = require('../src/server/modules/assistant/behavior/behavior-history.cjs');
const { compareRules, reviewHash } = require('../src/server/modules/assistant/behavior/behavior-review.cjs');
const example = (values = {}) => ({
  id: randomUUID(),
  text: 'Покажи расписание завтра',
  referenceDate: '2026-10-15',
  referenceTime: '10:00',
  enabled: true,
  expected: { intent: 'calendar', date: '2026-10-16' },
  ...values,
});
const rules = (values = {}) => ({ instructions: '', dictionary: '', examples: [], ...values });

test('automatic permits fifty enabled custom candidates while manual retains the twelve and 4096-byte limits', () => {
  const examples = Array.from({ length: 50 }, () => example());
  const automatic = normalizeRules(rules({ exampleSelection: 'automatic', examples }));
  assert.equal(automatic.examples.filter((row) => row.enabled).length, 50);
  assert.ok(Buffer.byteLength(compiledExamples(automatic.examples)) > 4096);
  assert.throws(() => normalizeRules({ ...automatic, exampleSelection: 'manual' }), {
    status: 400,
  });
  assert.throws(() => normalizeRules(rules({ examples: examples.slice(0, 13) })), { status: 400 });
  assert.throws(
    () =>
      normalizeRules(
        rules({ examples: Array.from({ length: 12 }, () => example({ text: 'Я'.repeat(500) })) }),
      ),
    { status: 400 },
  );
  assert.throws(
    () =>
      normalizeRules(rules({ exampleSelection: 'automatic', examples: [...examples, example()] })),
    { status: 400 },
  );
  assert.equal(behaviorLimits.maxCandidateExamples, 50);
  assert.equal(behaviorLimits.maxEnabledExamples, 12);
  assert.equal(behaviorLimits.maxEnabledExamplesBytes, 4096);
  const state = initialState();
  applyRules(state, automatic);
  assert.deepEqual(rulesFromPolicy(state.policy), automatic);
});

test('missing legacy selection stays manual in policy and both kinds of history without silently enabling retrieval', () => {
  const state = initialState();
  assert.equal(state.policy.exampleSelection, 'manual');
  delete state.policy.exampleSelection;
  delete state.policy.examples;
  state.history = [
    {
      revision: 0,
      time: 1,
      policy: structuredClone(state.policy),
      providers: structuredClone(state.providers),
      rates: { ...state.rates },
    },
  ];
  state.behavior = {
    version: 1,
    current: { time: 2, actorId: 'synthetic-admin', reason: 'Legacy version' },
    history: [
      {
        version: 0,
        time: null,
        actorId: null,
        reason: 'Legacy initial rules',
        rules: { instructions: '', dictionary: '' },
      },
    ],
  };
  validateState(state);
  assert.equal(state.policy.exampleSelection, 'manual');
  assert.equal(state.history[0].policy.exampleSelection, 'manual');
  assert.equal(normalizeBehavior(state.behavior).history[0].rules.exampleSelection, 'manual');
  assert.equal(state.policy.mode, 'off');
  assert.deepEqual(state.grants, []);
});

test('mode is canonical review content and automatic pool still obeys enum and total rules byte limit', () => {
  const legacy = rules();
  const manual = normalizeRules(legacy),
    automatic = normalizeRules({ ...legacy, exampleSelection: 'automatic' });
  assert.equal(reviewHash('synthetic-admin', 7, legacy), reviewHash('synthetic-admin', 7, manual));
  assert.notEqual(
    reviewHash('synthetic-admin', 7, manual),
    reviewHash('synthetic-admin', 7, automatic),
  );
  assert.deepEqual(compareRules(legacy, automatic).exampleSelection, {
    changed: true,
    before: 'manual',
    after: 'automatic',
  });
  for (const mode of ['auto', '', null, true])
    assert.throws(() => normalizeRules(rules({ exampleSelection: mode })), { status: 400 });
  assert.throws(
    () =>
      normalizeRules(
        rules({
          exampleSelection: 'automatic',
          instructions: 'Я'.repeat(4000),
          dictionary: 'Я'.repeat(4000),
          examples: Array.from({ length: 50 }, () => example({ text: 'Я'.repeat(500) })),
        }),
      ),
    { status: 400 },
  );
});
