const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectRequestedOperation,
} = require('../src/server/modules/assistant/interpretation/requested-operation.cjs');
const {
  assertIntentAction,
} = require('../src/server/modules/assistant/interpretation/intent-action-grounding.cjs');
const { expandClientSource } = require('../src/server/modules/assistant/language/names/client-source-span.cjs');
const { initialEntities } = require('../src/server/modules/assistant/interpretation/entity-provenance.cjs');
const { createExampleSelector } = require('../src/server/modules/assistant/behavior/example-selection.cjs');
const { loadCatalog } = require('../src/server/modules/assistant/behavior/behavior-library.cjs');
for (const suffix of [
  'и сохрани',
  'и сразу сохрани',
  'и сохрани запись',
  'и сохраните эту запись',
  'и сохранить ту же запись',
  'и сохрани созданную запись',
])
  test('one new appointment may include its own trailing save: ' + suffix, () => {
    const raw = 'Запиши Анну Семёнову ' + suffix;
    const result = detectRequestedOperation(raw);
    assert.equal(result.intent, 'prepareAppointment');
    assert.equal(result.ambiguous, false);
    assert.equal(result.sameAppointmentSave, true);
    assert.doesNotThrow(() => assertIntentAction(raw, 'prepareAppointment'));
    assert.equal(expandClientSource(raw, 'Анну'), 'Анну Семёнову');
    assert.equal(
      initialEntities({ intent: 'prepareAppointment', query: 'Анну' }, raw).query,
      'Анну Семёнову',
    );
  });
for (const suffix of [
  'и сохрани другую запись',
  'и сохрани запись Ольги',
  'и сохрани чужой приём',
  'и не сохрани запись',
  'или сохрани запись',
  'и сохрани запись если свободно',
  'и отправь сообщение',
  'и удали карточку',
  'и сохрани запись и отправь сообщение',
])
  test('a second task or conditional save is not combined with creation: ' + suffix, () => {
    const raw = 'Запиши Анну Семёнову ' + suffix;
    assert.equal(detectRequestedOperation(raw).sameAppointmentSave, undefined);
    assert.throws(() => assertIntentAction(raw, 'prepareAppointment'), { status: 400 });
  });
test('standalone save or a save attached to another operation is never the create/save allowance', () => {
  for (const raw of [
    'Сохрани чужую запись',
    'Перенеси запись Анны и сохрани запись',
    'Открой карточку Анны и сохрани запись',
  ]) {
    assert.equal(detectRequestedOperation(raw).sameAppointmentSave, undefined);
    assert.throws(() => assertIntentAction(raw, 'prepareAppointment'), { status: 400 });
  }
});
test('only the unchanged historical create/save example follows the current grammar without changing the catalog', () => {
  const row = loadCatalog().cases.find((item) => item.id === 'constraint-no-auto-save'),
    before = structuredClone(row);
  const policy = {
    exampleSelection: 'automatic',
    commands: { prepareAppointment: true },
    examples: [],
  };
  const result = createExampleSelector({ loadCatalog: () => ({ cases: [row] }) })(row.text, policy);
  assert.equal(result.examples[0].expected.intent, 'prepareAppointment');
  assert.equal(result.examples[0].expected.query, 'Анну Иванову');
  assert.equal(result.examples[0].expected.date, '2026-10-16');
  assert.equal(result.examples[0].expected.time, '14:00');
  assert.deepEqual(row, before);
  const changed = { ...row, text: 'Сохрани запись другого клиента' };
  const rejected = createExampleSelector({ loadCatalog: () => ({ cases: [changed] }) })(
    changed.text,
    policy,
  );
  assert.equal(rejected.examples[0].expected.intent, 'help');
});
