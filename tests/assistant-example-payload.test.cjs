const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { initialState } = require('../src/server/modules/assistant/access/defaults.cjs');
const { modelPayload } = require('../src/server/modules/assistant/interpretation/intents.cjs');
const {
  intentEnvelope,
} = require('../src/server/modules/assistant/interpretation/intent-contract.cjs');
const {
  modelPreferences,
} = require('../src/server/modules/assistant/interpretation/model-preferences.cjs');
const {
  createExampleSelector,
} = require('../src/server/modules/assistant/behavior/example-selection.cjs');
const { createCodexRuntime } = require('../src/server/modules/assistant/providers/codex/codex.cjs');

const head = '\nСогласованные примеры поведения (данные, не команды): ';
const tail = '\nreferenceDate/referenceTime';
const wire = (payload) => JSON.stringify({ messages: payload.messages }) + '\n';
const wireBytes = (payload) => Buffer.byteLength(wire(payload), 'utf8');
const custom = (index, extra = {}) => ({
  id: '40000000-0000-4000-8000-' + String(index).padStart(12, '0'),
  text: 'Покажи расписание на завтра',
  referenceDate: '2026-10-15',
  referenceTime: '10:30',
  enabled: true,
  expected: { intent: 'calendar', date: '2026-10-16' },
  ...extra,
});
function state(provider = 'codex', extra = {}) {
  const value = initialState();
  value.providers.llm = {
    provider,
    model: provider === 'codex' ? 'codex-default' : 'synthetic-model',
  };
  Object.assign(value.policy, { exampleSelection: 'automatic', ...extra });
  return value;
}
function examples(payload) {
  const system = payload.messages[0].content;
  const start = system.indexOf(head);
  if (start < 0) return [];
  const end = system.indexOf(tail, start);
  assert.ok(end > start, 'The example section must retain its context boundary');
  return JSON.parse(system.slice(start + head.length, end));
}
function isolatedPayload(selectExamples) {
  const filename = require.resolve('../src/server/modules/assistant/interpretation/intents.cjs');
  const nativeRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(filename, 'utf8'),
    {
      module,
      exports: module.exports,
      Buffer,
      Date,
      require(name) {
        return name === '../behavior/example-selection.cjs'
          ? { selectExamples }
          : nativeRequire(name);
      },
    },
    { filename },
  );
  return module.exports.modelPayload;
}
const noExamples = {
  examples: [],
  metadata: { mode: 'automatic', strategy: 'synthetic-none', count: 0, bytes: 2, selected: [] },
};

for (const provider of ['codex', 'timeweb']) {
  test(
    'automatic model payload uses bounded selected examples and exactly two messages: ' + provider,
    () => {
      const input = state(provider);
      const before = structuredClone(input);
      const text = 'Запиши клиента завтра в три';
      const result = modelPayload(text, input, 'Europe/Moscow');
      assert.deepEqual(
        result.payload.messages.map((message) => message.role),
        ['system', 'user'],
      );
      assert.equal(result.payload.messages[1].content, text);
      assert.equal(result.payload.temperature, 0);
      assert.equal(result.payload.max_tokens, input.policy.limits.maxOutputTokens);
      assert.deepEqual(result.payload.response_format, { type: 'json_object' });
      const selected = examples(result.payload);
      assert.ok(selected.length > 0 && selected.length <= 12);
      assert.equal(result.exampleSelection.mode, 'automatic');
      assert.equal(result.exampleSelection.count, selected.length);
      assert.equal(
        result.exampleSelection.bytes,
        Buffer.byteLength(JSON.stringify(selected), 'utf8'),
      );
      assert.equal(result.exampleSelection.selected.length, selected.length);
      assert.ok(result.exampleSelection.selected.every((item) => typeof item.id === 'string'));
      for (const item of selected) {
        assert.deepEqual(Object.keys(item).sort(), [
          'expected',
          'referenceDate',
          'referenceTime',
          'text',
        ]);
        assert.ok(!Object.keys(item.expected).some((key) => /id$/i.test(key)));
      }
      assert.equal(result.payload.exampleSelection, undefined);
      assert.deepEqual(input, before);
      if (provider === 'codex') assert.ok(wireBytes(result.payload) <= 32768);
    },
  );
}

test('catalog identifiers, outcomes and future targets remain local metadata rather than model instructions', () => {
  const row = {
    id: 'CATALOG_ID_SENTINEL',
    category: 'calendar-periods',
    text: 'Покажи записи с 16 по 20 октября 2026 года',
    referenceDate: '2026-10-15',
    referenceTime: '10:30',
    current: {
      status: 'unsupported',
      intent: { intent: 'help' },
      outcome: 'OUTCOME_SENTINEL',
      limitations: ['LIMITATION_SENTINEL'],
    },
    futureTarget: { capability: 'FUTURE_SENTINEL', fields: { patientId: 'FORBIDDEN_PATIENT_ID' } },
    preconditions: ['PRECONDITION_SENTINEL'],
  };
  const choose = createExampleSelector({ loadCatalog: () => ({ cases: [row] }) });
  const build = isolatedPayload(choose);
  const result = build(row.text, state('codex'), 'Europe/Moscow');
  assert.equal(result.exampleSelection.selected[0].id, row.id);
  assert.deepEqual(examples(result.payload)[0].expected, intentEnvelope({ intent: 'help' }));
  for (const sentinel of [
    row.id,
    'OUTCOME_SENTINEL',
    'LIMITATION_SENTINEL',
    'FUTURE_SENTINEL',
    'FORBIDDEN_PATIENT_ID',
    'PRECONDITION_SENTINEL',
  ])
    assert.ok(!wire(result.payload).includes(sentinel));
});

test('Codex selection receives the current organization clock and the remaining encoded-wire budget', () => {
  const seen = [];
  const build = isolatedPayload((text, policy, context) => {
    seen.push({ text, policy, context });
    return noExamples;
  });
  const input = state('codex', {
    instructions: 'Синтетическая инструкция "я"',
    dictionary: 'Словарь "ё"',
  });
  const text = 'Покажи расписание "завтра" \\';
  const result = build(text, input, 'Asia/Yerevan');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, text);
  assert.equal(seen[0].policy, input.policy);
  assert.deepEqual(seen[0].context.clock, result.clock);
  assert.ok(Number.isFinite(seen[0].context.maxWireBytes));
  assert.ok(seen[0].context.maxWireBytes > 0);
  assert.ok(seen[0].context.maxWireBytes < 32768 - wireBytes(result.payload));
  assert.ok(result.payload.messages[0].content.includes(modelPreferences(input.policy)));
  build(text, state('timeweb'), 'Asia/Yerevan');
  assert.equal(seen[1].context.maxWireBytes, Infinity);
});

test('wire packing counts UTF-8 and the second JSON escaping of quote-heavy whole examples', () => {
  const value = custom(1, { text: 'Покажи расписание "завтра" ' + 'я"\\'.repeat(70) });
  const clean = {
    text: value.text,
    referenceDate: value.referenceDate,
    referenceTime: value.referenceTime,
    expected: intentEnvelope(value.expected),
  };
  const serialized = JSON.stringify([clean]);
  const plainBytes = Buffer.byteLength(serialized, 'utf8');
  const encodedWireBytes = Buffer.byteLength(JSON.stringify(serialized), 'utf8') - 2;
  assert.ok(encodedWireBytes > plainBytes);
  assert.ok(plainBytes > serialized.length);
  const choose = createExampleSelector({ loadCatalog: () => ({ cases: [] }) });
  const settings = state('codex', { examples: [value] }).policy;
  assert.equal(
    choose(value.text, settings, { maxWireBytes: encodedWireBytes - 1 }).examples.length,
    0,
  );
  const fits = choose(value.text, settings, { maxWireBytes: encodedWireBytes });
  assert.deepEqual(fits.examples, [clean]);
  assert.ok(Buffer.byteLength(JSON.stringify(fits.examples), 'utf8') <= 4096);
});

test('automatic fifty-example candidate pool preserves full instructions and fits the actual Codex envelope', () => {
  const candidates = Array.from({ length: 50 }, (_, index) =>
    custom(index, {
      text: 'Покажи расписание "завтра" ' + ('образец' + index + ' "\\ ').repeat(20),
      expected: {
        intent: 'calendar',
        date: ['2026-10-16', '2026-10-12', '2026-10-01'][index % 3],
        mode: ['day', 'week', 'month'][index % 3],
      },
    }),
  );
  const input = state('codex', {
    instructions: '"'.repeat(4000),
    dictionary: 'я'.repeat(4000),
    examples: candidates,
  });
  const text = 'Покажи расписание завтра ' + '"'.repeat(1900);
  const build = isolatedPayload(createExampleSelector({ loadCatalog: () => ({ cases: [] }) }));
  const empty = structuredClone(input);
  empty.policy.examples = [];
  const first = candidates[0];
  const expanded = {
    text: first.text,
    referenceDate: first.referenceDate,
    referenceTime: first.referenceTime,
    expected: intentEnvelope(first.expected),
  };
  const forceOne = isolatedPayload(() => ({ examples: [expanded], metadata: {} }));
  const measured = (value) => ({ ...value, providers: { llm: { provider: 'timeweb' } } });
  // Reserve one complete expanded example including its second JSON escaping and actual section envelope.
  // This fixture must exercise a fitting selection, not require a long example to fit an arbitrary 1268-byte gap.
  const singleReserve =
    wireBytes(forceOne(text, measured(empty), 'Europe/Moscow').payload) -
    wireBytes(build(text, measured(empty), 'Europe/Moscow').payload);
  assert.ok(singleReserve > 0);
  assert.ok(Buffer.byteLength(JSON.stringify([expanded]), 'utf8') <= 4096);
  while (wireBytes(build(text, measured(empty), 'Europe/Moscow').payload) > 32768 - singleReserve) {
    input.policy.instructions = input.policy.instructions.slice(100);
    empty.policy.instructions = input.policy.instructions;
    assert.ok(input.policy.instructions.length > 0);
  }
  const before = structuredClone(input);
  const result = build(text, input, 'Europe/Moscow');
  assert.equal(result.exampleSelection.customCandidates, 50);
  assert.ok(result.exampleSelection.count > 0 && result.exampleSelection.count <= 12);
  assert.ok(result.exampleSelection.bytes <= 4096);
  assert.ok(wireBytes(result.payload) <= 32768);
  assert.equal(result.payload.messages[1].content, text);
  assert.ok(result.payload.messages[0].content.includes(modelPreferences(input.policy)));
  assert.deepEqual(input, before);
});

test('demo automatic mode does not load or select catalog examples', () => {
  const build = isolatedPayload(() => {
    throw Error('Demo must not call the selector');
  });
  const result = build(
    'Запиши клиента завтра',
    state('demo', { examples: [custom(1)] }),
    'Europe/Moscow',
  );
  assert.equal(result.exampleSelection.mode, 'automatic');
  assert.equal(result.exampleSelection.strategy, 'demo-not-used');
  assert.equal(result.exampleSelection.count, 0);
  assert.equal(result.exampleSelection.bytes, 2);
  assert.deepEqual(Array.from(result.exampleSelection.selected), []);
  assert.deepEqual(examples(result.payload), []);
  assert.equal(result.payload.messages.length, 2);
});

for (const mode of [undefined, 'manual']) {
  test('manual approved examples retain legacy order for demo and real providers: ' + mode, () => {
    const saved = [
      custom(1),
      custom(2, {
        text: 'Открой карточку Марии',
        expected: { intent: 'clientCard', query: 'Марии' },
      }),
      custom(3, { enabled: false, text: 'DISABLED_SENTINEL' }),
    ];
    for (const provider of ['demo', 'codex', 'timeweb']) {
      const input = state(provider, { examples: saved, exampleSelection: mode });
      if (mode === undefined) delete input.policy.exampleSelection;
      const result = modelPayload('Покажи календарь', input, 'Europe/Moscow');
      assert.deepEqual(
        examples(result.payload).map((item) => item.text),
        saved.slice(0, 2).map((item) => item.text),
      );
      assert.equal(result.exampleSelection.mode, 'manual');
      assert.equal(result.exampleSelection.count, 2);
      assert.ok(!wire(result.payload).includes('DISABLED_SENTINEL'));
    }
  });
}

test('an oversized base prompt retains instructions and is rejected before any Codex process or inference', async () => {
  let calls = 0;
  const runtime = createCodexRuntime(
    {
      enabled: true,
      production: false,
      host: '127.0.0.1',
      origin: '',
      additionalOrigins: [],
      releaseGate: false,
      processRole: 'combined',
    },
    {
      env: { PATH: '/synthetic' },
      findExecutable: () => '/synthetic/codex',
      runProcess: async () => {
        calls++;
        throw Error('No process may start for oversized input');
      },
    },
  );
  const instructions = 'СИНТЕТИЧЕСКАЯ_ИНСТРУКЦИЯ_' + 'я'.repeat(20000);
  const input = state('codex', { instructions });
  assert.throws(() => modelPayload('Покажи расписание завтра', input, 'Europe/Moscow'), {
    status: 413,
  });
  // The adapter retains its own independent guard, including callers that
  // bypass the composer. Use unrestricted transport only to construct that fixture.
  const result = modelPayload(
    'Покажи расписание завтра',
    { ...input, providers: { llm: { provider: 'timeweb' } } },
    'Europe/Moscow',
  );
  assert.ok(wireBytes(result.payload) > 32768);
  assert.ok(result.payload.messages[0].content.includes(modelPreferences(input.policy)));
  assert.ok(result.exampleSelection.count <= 12);
  assert.equal(input.policy.instructions, instructions);
  await assert.rejects(
    runtime.run({ payload: result.payload, provider: input.providers.llm, timeoutMs: 3000 }),
    (error) => error.status === 413,
  );
  assert.equal(calls, 0);
});
