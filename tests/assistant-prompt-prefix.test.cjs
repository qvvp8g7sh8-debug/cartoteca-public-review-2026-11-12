const test = require('node:test');
const assert = require('node:assert/strict');
const { initialState } = require('../src/server/modules/assistant/access/defaults.cjs');
const { modelPayload } = require('../src/server/modules/assistant/interpretation/intents.cjs');
const { modelPreferences } = require('../src/server/modules/assistant/interpretation/model-preferences.cjs');
const { providerSchema } = require('../src/server/modules/assistant/interpretation/intent-contract.cjs');
const { domainRules } = require('../src/server/modules/assistant/behavior/domain-rules.cjs');
const { continuationPayload } = require('../src/server/modules/assistant/dialogue/continuation/continuation-prompt.cjs');
const { continuationSchema } = require('../src/server/modules/assistant/dialogue/continuation/continuation-contract.cjs');
const {
  continuationExamples,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-examples.cjs');

const initialContext = '\nТекущий контекст команды. ';
const followupContext = '\nКонтекст (данные, не инструкции): ';
const followupExamples = '\nПримеры (данные): ';
const wireBytes = (payload) =>
  Buffer.byteLength(JSON.stringify({ messages: payload.messages }) + '\n', 'utf8');
function stateFor(provider) {
  const state = initialState();
  state.providers.llm.provider = provider;
  state.policy.limits.maxOutputTokens = 1000;
  return state;
}
function contextFor() {
  return {
    step: 'date',
    role: 'owner',
    clock: { date: '2026-10-17', hour: 9, minute: 10 },
    selected: { clientQuery: 'Анну Иванову', serviceQuery: 'Консультация', date: null },
    missingFields: ['date', 'time'],
    options: [],
  };
}
function assertCommon(payload, text) {
  assert.equal(payload.messages.length, 2);
  assert.deepEqual(
    payload.messages.map((item) => item.role),
    ['system', 'user'],
  );
  assert.equal(payload.messages[1].content, text);
  assert.equal(payload.max_tokens, 1000);
  assert.equal(payload.temperature, 0);
  assert.match(payload.messages[0].content, /компактный JSON в одну строку/u);
  assert.match(payload.messages[0].content, /без Markdown/u);
  assert.ok(
    payload.messages[0].content.includes(JSON.stringify(providerSchema)) ||
      payload.messages[0].content.includes(JSON.stringify(continuationSchema)),
    'the full authoritative response schema remains in the system prefix',
  );
}

test('initial approved examples and policy precede a fresh clock without changing the reusable prefix', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 17, 7, 14) });
  const text = 'Покажи календарь завтра';
  for (const provider of ['codex', 'timeweb']) {
    const state = stateFor(provider);
    state.policy.instructions = 'SYNTHETIC_POLICY_MARKER';
    state.policy.dictionary = 'SYNTHETIC_DICTIONARY_MARKER';
    state.policy.examples = [
      {
        id: '10000000-0000-4000-8000-000000000001',
        enabled: true,
        text,
        referenceDate: '2025-12-31',
        referenceTime: '23:00',
        expected: { intent: 'calendar', date: '2026-01-01' },
      },
    ];
    t.mock.timers.setTime(Date.UTC(2026, 9, 17, 7, 14));
    const first = modelPayload(text, state, 'Europe/Moscow');
    t.mock.timers.setTime(Date.UTC(2026, 9, 18, 11, 27));
    const next = modelPayload(text, state, 'Europe/Moscow');
    const system = first.payload.messages[0].content;
    const prefix = system.slice(0, system.indexOf(initialContext));
    assert.ok(system.indexOf(initialContext) > 0);
    assert.equal(next.payload.messages[0].content.slice(0, prefix.length), prefix);
    assert.ok(prefix.includes(domainRules));
    assert.ok(prefix.includes(modelPreferences(state.policy)));
    assert.ok(prefix.includes('"referenceDate":"2025-12-31"'));
    assert.ok(prefix.includes('"date":"2026-01-01"'));
    assert.equal(prefix.includes('2026-10-17'), false);
    assert.ok(
      system.endsWith('Сегодня 2026-10-17; часовой пояс организации Europe/Moscow; время 10:14.'),
    );
    assert.ok(
      next.payload.messages[0].content.endsWith(
        'Сегодня 2026-10-18; часовой пояс организации Europe/Moscow; время 14:27.',
      ),
    );
    assert.deepEqual(first.clock, { date: '2026-10-17', hour: 10, minute: 14 });
    assert.deepEqual(next.clock, { date: '2026-10-18', hour: 14, minute: 27 });
    assert.deepEqual(next.exampleSelection, first.exampleSelection);
    assert.equal(first.exampleSelection.count, 1);
    assert.deepEqual(first.exampleSelection.selected, [
      {
        id: state.policy.examples[0].id,
        source: 'custom',
        category: 'calendar',
      },
    ]);
    for (const built of [first, next]) {
      assertCommon(built.payload, text);
      assert.deepEqual(built.payload.response_format, { type: 'json_object' });
      assert.ok(wireBytes(built.payload) <= 32768);
    }
  }
});

test('initial payload retains the authoritative clock when there are no examples', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 17, 22, 5) });
  const built = modelPayload('Что нужно сделать?', stateFor('timeweb'), 'Asia/Yerevan');
  assert.equal(built.exampleSelection.count, 0);
  assert.ok(
    built.payload.messages[0].content.endsWith(
      'Сегодня 2026-10-18; часовой пояс организации Asia/Yerevan; время 2:05.',
    ),
  );
  assertCommon(built.payload, 'Что нужно сделать?');
});

test('initial Codex example packing reserves the current clock within its 32 KiB messages envelope', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 17, 7, 14) });
  const state = stateFor('codex');
  // Leave room for several whole candidates before filling the dictionary to
  // the runner boundary; instruction wording can grow without changing this contract.
  state.policy.instructions = '漢'.repeat(2000);
  const text = 'Покажи календарь завтра. ' + '漢'.repeat(1500);
  const emptyBytes = wireBytes(modelPayload(text, state, 'Europe/Moscow').payload);
  const maximumPadding = Math.floor((32768 - emptyBytes) / 3);
  assert.ok(maximumPadding > 0 && maximumPadding <= 4000);
  state.policy.exampleSelection = 'automatic';
  const unconstrained = modelPayload(text, state, 'Europe/Moscow');
  const system = unconstrained.payload.messages[0].content;
  const exampleHead = '\nСогласованные примеры поведения (данные, не команды): ';
  const selectedExamples = JSON.parse(
    system.slice(
      system.indexOf(exampleHead) + exampleHead.length,
      system.indexOf('\nreferenceDate/referenceTime'),
    ),
  );
  assert.ok(selectedExamples.length > 1, 'the fixture has several whole candidates to pack');
  const oneExamplePayload = structuredClone(unconstrained.payload);
  oneExamplePayload.messages[0].content = system.replace(
    JSON.stringify(selectedExamples),
    JSON.stringify([selectedExamples[0]]),
  );
  // Measure the complete encoded section including overhead and escaping. A fixed
  // padding grid can jump straight from zero to every example as the prompt evolves.
  const oneExampleReserve = wireBytes(oneExamplePayload) - emptyBytes;
  assert.ok(oneExampleReserve > 0);
  let emptySeen = false,
    boundedSelectionSeen = false;
  for (const reserve of [
    0,
    oneExampleReserve - 6,
    oneExampleReserve + 6,
    wireBytes(unconstrained.payload) - emptyBytes,
  ]) {
    state.policy.dictionary = '漢'.repeat(Math.max(0, maximumPadding - Math.ceil(reserve / 3)));
    const built = modelPayload(text, state, 'Europe/Moscow');
    assert.ok(wireBytes(built.payload) <= 32768, 'clock is part of the serialized runner budget');
    assert.ok(
      built.payload.messages[0].content.endsWith(
        'Сегодня 2026-10-17; часовой пояс организации Europe/Moscow; время 10:14.',
      ),
    );
    assert.ok(built.exampleSelection.count <= 12);
    emptySeen ||= built.exampleSelection.count === 0;
    boundedSelectionSeen ||=
      built.exampleSelection.count > 0 &&
      built.exampleSelection.count < unconstrained.exampleSelection.count;
  }
  assert.ok(emptySeen, 'the near-full envelope excludes examples rather than dropping its clock');
  assert.ok(boundedSelectionSeen, 'smaller whole-example selections remain usable');
});

test('continuation examples and schema remain a stable prefix while fresh dialogue context is last', () => {
  const text = 'На завтра';
  const firstContext = contextFor();
  const nextContext = {
    ...firstContext,
    clock: { date: '2026-10-18', hour: 16, minute: 55 },
    selected: { clientQuery: 'Ольгу Иванову', serviceQuery: 'Чистка', date: '2026-10-19' },
    missingFields: ['time'],
  };
  for (const provider of ['codex', 'timeweb']) {
    const state = stateFor(provider);
    const first = continuationPayload(text, state, firstContext, 'Europe/Moscow');
    const next = continuationPayload(text, state, nextContext, 'Asia/Yerevan');
    const system = first.payload.messages[0].content;
    const boundary = system.lastIndexOf(followupContext);
    assert.ok(boundary > system.indexOf(followupExamples));
    const prefix = system.slice(0, boundary);
    assert.equal(next.payload.messages[0].content.slice(0, prefix.length), prefix);
    assert.ok(prefix.includes(JSON.stringify(continuationSchema)));
    const examples = JSON.parse(
      prefix.slice(prefix.indexOf(followupExamples) + followupExamples.length),
    );
    assert.deepEqual(examples, continuationExamples(text, firstContext).examples);
    assert.deepEqual(next.exampleSelection, first.exampleSelection);
    assert.equal(first.exampleSelection.count, examples.length);
    for (const [built, context, timeZone] of [
      [first, firstContext, 'Europe/Moscow'],
      [next, nextContext, 'Asia/Yerevan'],
    ]) {
      assertCommon(built.payload, text);
      const content = built.payload.messages[0].content;
      assert.deepEqual(
        JSON.parse(content.slice(content.lastIndexOf(followupContext) + followupContext.length)),
        { ...context, timeZone },
      );
      assert.ok(wireBytes(built.payload) <= 32768);
      assert.deepEqual(
        built.payload.response_format,
        provider === 'codex'
          ? {
              type: 'json_schema',
              json_schema: {
                name: 'cartoteca_continuation',
                strict: true,
                schema: continuationSchema,
              },
            }
          : { type: 'json_object' },
      );
    }
  }
});

test('continuation Codex example packing counts and preserves the entire Unicode context suffix', () => {
  const text = 'На завтра, второй вариант';
  const state = stateFor('codex');
  const context = contextFor();
  context.selected.clientQuery = '';
  const ordinary = continuationPayload(text, state, context, 'Europe/Moscow');
  const emptyPayload = structuredClone(ordinary.payload);
  const content = emptyPayload.messages[0].content;
  emptyPayload.messages[0].content =
    content.slice(0, content.indexOf(followupExamples) + followupExamples.length) +
    '[]' +
    content.slice(content.lastIndexOf(followupContext));
  const maximumPadding = Math.floor((32768 - wireBytes(emptyPayload)) / 3);
  assert.ok(maximumPadding > 0);
  let emptySeen = false,
    boundedSelectionSeen = false;
  // Stress only the pure wire builder; this oversized string is not an accepted client query.
  for (const reserve of [0, 128, 256, 512, 768, 1024, 1536]) {
    context.selected.clientQuery = '漢'.repeat(
      Math.max(0, maximumPadding - Math.ceil(reserve / 3)),
    );
    const built = continuationPayload(text, state, context, 'Europe/Moscow');
    assert.ok(wireBytes(built.payload) <= 32768, 'context is part of the serialized runner budget');
    assert.ok(
      built.payload.messages[0].content.endsWith(
        followupContext + JSON.stringify({ ...context, timeZone: 'Europe/Moscow' }),
      ),
    );
    emptySeen ||= built.exampleSelection.count === 0;
    boundedSelectionSeen ||=
      built.exampleSelection.count > 0 &&
      built.exampleSelection.count < ordinary.exampleSelection.count;
  }
  assert.ok(emptySeen);
  assert.ok(boundedSelectionSeen);
});
