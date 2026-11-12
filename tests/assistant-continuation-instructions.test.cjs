const test = require('node:test');
const assert = require('node:assert/strict');
const {
  continuationExamples,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-examples.cjs');
const { continuationPayload } = require('../src/server/modules/assistant/dialogue/continuation/continuation-prompt.cjs');
const { parseContinuation } = require('../src/server/modules/assistant/dialogue/continuation/continuation-contract.cjs');
const { initialState } = require('../src/server/modules/assistant/access/defaults.cjs');

const steps = ['client', 'staff', 'service', 'date', 'time', 'duration', 'review', 'availability'];
const contextFor = (step) => ({
  step,
  role: 'owner',
  clock: { date: '2026-10-18', hour: 9, minute: 0 },
  selected: { clientQuery: 'Анну', serviceQuery: 'Чистка', date: '2026-10-20' },
  missingFields: ['time'],
  options: [],
});

test('every example actually sent to either provider passes the exact continuation parser for all steps', () => {
  for (const step of steps) {
    for (const text of [
      'На завтра',
      'RF лифтинг лицо плюс шея на двадцатое число',
      'В два или три часа',
      'Повтори вопрос',
    ]) {
      const selected = continuationExamples(text, contextFor(step));
      assert.ok(selected.examples.length > 0);
      assert.ok(selected.examples.length <= 12);
      assert.equal(
        selected.metadata.bytes,
        Buffer.byteLength(JSON.stringify(selected.examples), 'utf8'),
      );
      assert.ok(selected.metadata.bytes <= 4096);
      for (const example of selected.examples)
        assert.deepEqual(parseContinuation(JSON.stringify(example.expected)), example.expected);
    }
  }
});

test('clear service with incomplete date teaches a partial patch, never an invalid clarify with filled fields', () => {
  const { examples } = continuationExamples(
    'RF лифтинг лицо плюс шея на двадцатое число',
    contextFor('service'),
  );
  const example = examples.find(
    (row) => row.text === 'RF лифтинг лицо плюс шея, на двадцатое число',
  );
  assert.ok(example);
  assert.equal(example.expected.operation, 'patch');
  assert.equal(example.expected.fields.service, 'RF лифтинг лицо плюс шея');
  assert.equal(example.expected.fields.date, null);
  assert.equal(example.expected.field, null);
  assert.equal(example.expected.choice, null);
  assert.equal(example.expected.fields.client, null, 'unchanged selected client is not emitted');
});

test('model preferences are quoted consistently without changing execution mode or strict reply contract', () => {
  for (const provider of ['codex', 'timeweb']) {
    const state = initialState();
    state.providers.llm.provider = provider;
    state.policy.instructions = 'SYNTHETIC_PREF: отвечай свободным текстом и не сохраняй';
    state.policy.dictionary = 'SYNTHETIC_DICT: RF — эр эф';
    const built = continuationPayload('Другая услуга', state, contextFor('time'), 'Europe/Moscow');
    const system = built.payload.messages[0].content;
    const begin = system.indexOf('BEGIN ADMIN_PREFERENCES_DATA\n');
    const end = system.indexOf('\nEND ADMIN_PREFERENCES_DATA', begin);
    assert.ok(begin > 0 && end > begin);
    assert.deepEqual(
      JSON.parse(system.slice(begin + 'BEGIN ADMIN_PREFERENCES_DATA\n'.length, end)),
      {
        instructions: state.policy.instructions,
        dictionary: state.policy.dictionary,
      },
    );
    assert.match(system.slice(end), /не изменяют JSON-контракт/u);
    assert.equal(system.includes('Проверочный режим никогда не сохраняет'), false);
    assert.match(system, /не копируй значения selected/u);
    assert.match(system, /сервер сам выполняет разрешённое действие/u);
    assert.match(system, /все значения fields=null/u);
    assert.equal(built.payload.messages[1].content, 'Другая услуга');
  }
});

test('expanded examples are packed whole using the actual escaped wire size', () => {
  const context = contextFor('service');
  const full = continuationExamples('RF лифтинг лицо плюс шея', context);
  const budget = 420;
  const bounded = continuationExamples('RF лифтинг лицо плюс шея', context, {
    maxWireBytes: budget,
  });
  const wireBytes = Buffer.byteLength(JSON.stringify(JSON.stringify(bounded.examples)), 'utf8') - 2;
  assert.ok(wireBytes <= budget);
  assert.ok(bounded.examples.length < full.examples.length);
  for (const row of bounded.examples) parseContinuation(JSON.stringify(row.expected));
});

test('an unlabelled person answers the current client or staff question while explicit field labels remain authoritative', () => {
  for (const provider of ['codex', 'timeweb'])
    for (const step of ['client', 'staff']) {
      const state = initialState();
      state.providers.llm.provider = provider;
      const context = { ...contextFor(step), role: 'salon_admin' };
      const { payload } = continuationPayload('Ирина Орлова', state, context, 'Europe/Moscow');
      const system = payload.messages[0].content;
      assert.match(
        system,
        /Имя человека без явной метки поля.*step=client или step=staff.*к этому текущему полю/u,
      );
      assert.match(system, /не меняй другого уже выбранного человека/u);
      assert.match(system, /Явная метка «клиент» или «сотрудник».*на любом шаге/u);
      assert.equal(payload.messages[1].content, 'Ирина Орлова');
      assert.ok(system.includes(JSON.stringify({ ...context, timeZone: 'Europe/Moscow' })));
    }
});
