const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCatalog } = require('../src/server/modules/assistant/behavior/behavior-library.cjs');
const {
  createExampleSelector,
  selectExamples,
} = require('../src/server/modules/assistant/behavior/example-selection.cjs');
const { parseModelIntent } = require('../src/server/modules/assistant/interpretation/intents.cjs');
const { intentEnvelope } = require('../src/server/modules/assistant/interpretation/intent-contract.cjs');
const {
  assertIntentAction,
} = require('../src/server/modules/assistant/interpretation/intent-action-grounding.cjs');
const policy = (
  examples = [],
  commands = { calendar: true, clients: true, prepareAppointment: true },
) => ({
  exampleSelection: 'automatic',
  commands,
  examples,
});
const clock = { date: '2026-10-18', hour: 9, minute: 0 };
const cases = [
  ['name-instrumental-female', 'Найди карточку с Анной Ивановой', 'Анной Ивановой'],
  ['name-genitive-male', 'Найди карточку Сергея Иванова', 'Сергея Иванова'],
  ['name-prepositional-male', 'Найди карточку о Сергее Иванове', 'Сергее Иванове'],
];
for (const [id, text, query] of cases)
  test('current card retrieval preserves literal case and agrees with dispatch: ' + id, () => {
    const catalog = loadCatalog();
    const before = JSON.stringify(catalog);
    const original = catalog.cases.find((row) => row.id === id);
    assert.equal(original.text, text);
    assert.deepEqual(original.current.intent, { intent: 'clients', query });
    const result = selectExamples(text, policy(), { clock });
    assert.equal(result.metadata.selected[0].id, id);
    assert.equal(result.metadata.selected[0].source, 'catalog');
    const expected = { intent: 'clientCard', query };
    assert.deepEqual(result.examples[0].expected, intentEnvelope(expected));
    assert.deepEqual(parseModelIntent(JSON.stringify(result.examples[0].expected)), expected);
    assert.ok(text.includes(query));
    assert.doesNotThrow(() => assertIntentAction(text, expected.intent));
    assert.ok(result.examples.length <= 12);
    assert.ok(result.metadata.bytes <= 4096);
    assert.equal(JSON.stringify(catalog), before, 'projection never rewrites research history');
  });

test('card projection is limited to each exact legacy id, text, intent and condition-free query', () => {
  const original = loadCatalog().cases.find((row) => row.id === cases[0][0]);
  const variants = [
    { ...structuredClone(original), id: 'unreviewed-card-case' },
    { ...structuredClone(original), text: original.text + ', если она согласна' },
    {
      ...structuredClone(original),
      current: { ...original.current, intent: { intent: 'clients', query: 'Анна Иванова' } },
    },
    {
      ...structuredClone(original),
      current: { ...original.current, intent: { intent: 'help' } },
    },
  ];
  for (const row of variants) {
    const choose = createExampleSelector({ loadCatalog: () => ({ cases: [row] }) });
    const result = choose(row.text, policy(), { clock });
    if (row.current.intent.intent === 'help') {
      assert.equal(result.examples.length, 1);
      assert.deepEqual(result.examples[0].expected, intentEnvelope(row.current.intent));
    } else {
      assert.deepEqual(
        result.examples,
        [],
        'unreviewed mismatched/conditional parses cannot teach a different task',
      );
    }
  }
  const conditional = {
    ...structuredClone(original),
    current: {
      ...original.current,
      intent: { ...original.current.intent, date: '2026-10-20' },
    },
  };
  const choose = createExampleSelector({ loadCatalog: () => ({ cases: [conditional] }) });
  assert.deepEqual(choose(original.text, policy(), { clock }).examples, []);
});

test('invalid-schema custom examples cannot shadow the projection while approved exact custom choices retain their existing scope', () => {
  const row = loadCatalog().cases.find((item) => item.id === cases[0][0]);
  const choose = createExampleSelector({ loadCatalog: () => ({ cases: [row] }) });
  const custom = {
    id: '10000000-0000-4000-8000-000000000001',
    text: row.text,
    referenceDate: row.referenceDate,
    referenceTime: row.referenceTime,
    enabled: true,
    expected: { intent: 'calendar', query: 'Анной Ивановой' },
  };
  const invalid = choose(row.text, policy([custom]), { clock });
  assert.equal(invalid.metadata.selected[0].id, row.id);
  assert.equal(invalid.examples[0].expected.intent, 'clientCard');
  const approved = { ...custom, expected: { intent: 'clients', query: 'Анной Ивановой' } };
  const result = choose(row.text, policy([approved]), { clock });
  assert.equal(result.metadata.selected[0].id, custom.id);
  assert.equal(result.metadata.selected[0].source, 'custom');
  assert.equal(result.examples[0].expected.intent, 'clients');
  assert.ok(!result.metadata.selected.some((item) => item.id === row.id));
  assert.deepEqual(approved.expected, { intent: 'clients', query: 'Анной Ивановой' });
});

test('projected client-card examples still require the clients command grant', () => {
  for (const [, text] of cases) {
    const result = selectExamples(
      text,
      policy([], { calendar: true, clients: false, prepareAppointment: true }),
      { clock },
    );
    assert.ok(
      result.examples.every((row) => !['clients', 'clientCard'].includes(row.expected.intent)),
    );
  }
});
