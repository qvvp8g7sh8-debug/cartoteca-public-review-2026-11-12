const test = require('node:test');
const assert = require('node:assert/strict');
const { createExampleSelector } = require('../src/server/modules/assistant/behavior/example-selection.cjs');
const { validateCommandFields } = require('../src/server/modules/assistant/interpretation/intent-schema.cjs');
const { parseModelIntent } = require('../src/server/modules/assistant/interpretation/intents.cjs');
const { intentEnvelope } = require('../src/server/modules/assistant/interpretation/intent-contract.cjs');
const example = (expected, text = 'Покажи календарь завтра') => ({
  id: '10000000-0000-4000-8000-000000000001',
  enabled: true,
  text,
  referenceDate: '2026-10-16',
  referenceTime: '09:00',
  expected,
});
const built = (id, expected, text) => ({
  id,
  text,
  referenceDate: '2026-10-16',
  referenceTime: '09:00',
  category: 'calendar-dates',
  current: { status: 'supported', intent: expected },
});
const policy = (examples = [], mode = 'automatic') => ({
  exampleSelection: mode,
  commands: { calendar: true, clients: true, prepareAppointment: true },
  examples,
});
const selector = (cases = []) => createExampleSelector({ loadCatalog: () => ({ cases }) });
for (const mode of ['automatic', 'manual'])
  test(
    'runtime ' +
      mode +
      ' prompts exclude unsupported historical conditions without rewriting settings',
    () => {
      const row = example({ intent: 'calendar', query: 'Анны Семёновой', date: '2026-10-17' });
      const settings = policy([row], mode),
        before = structuredClone(settings);
      const result = selector()('Покажи календарь завтра', settings);
      assert.deepEqual(result.examples, []);
      assert.deepEqual(settings, before);
    },
  );
test('an invalid custom exact phrase cannot shadow a valid built-in parse', () => {
  const text = 'Покажи календарь завтра';
  const expected = { intent: 'calendar', date: '2026-10-17' };
  const choose = selector([built('valid-calendar', expected, text)]);
  const result = choose(text, policy([example({ ...expected, query: 'Анны Семёновой' }, text)]));
  assert.equal(result.examples.length, 1);
  assert.deepEqual(result.examples[0].expected, intentEnvelope(expected));
  assert.deepEqual(parseModelIntent(JSON.stringify(result.examples[0].expected)), expected);
  assert.equal(result.metadata.selected[0].source, 'catalog');
});
test('automatic built-in candidates obey the same executable field contract as model responses', () => {
  const text = 'Покажи календарь завтра';
  const choose = selector([
    built('invalid-calendar', { intent: 'calendar', query: 'Анна' }, text),
    built('valid-calendar', { intent: 'calendar', date: '2026-10-17' }, text),
  ]);
  const result = choose(text, policy());
  assert.equal(result.examples.length, 1);
  for (const row of result.examples) {
    assert.deepEqual(row.expected, intentEnvelope({ intent: 'calendar', date: '2026-10-17' }));
    const parsed = parseModelIntent(JSON.stringify(row.expected));
    assert.deepEqual(parsed, { intent: 'calendar', date: '2026-10-17' });
    assert.doesNotThrow(() => validateCommandFields(parsed));
  }
});
test('canonical built-in duplicates share one candidate while dated contexts remain distinct', () => {
  const expected = { intent: 'clients', query: 'Анну Семёнову' };
  const first = built('one', expected, 'Найди Анну Семёнову'),
    second = built('two', expected, 'найди  анну семенову');
  const third = { ...built('third', expected, 'Найди Анну Семёнову'), referenceDate: '2026-10-17' };
  const result = selector([first, second, third])('Найди Анну Семёнову', policy());
  assert.equal(result.metadata.catalogCandidates, 2);
  assert.ok(result.examples.every((row) => row.expected.intent === 'clients'));
});
