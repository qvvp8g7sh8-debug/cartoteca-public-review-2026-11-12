const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectRequestedOperation,
} = require('../src/server/modules/assistant/interpretation/requested-operation.cjs');
const {
  assertIntentAction,
  assertEarlyNegativeAction,
} = require('../src/server/modules/assistant/interpretation/intent-action-grounding.cjs');
const {
  prepareManagementIntent,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-intent.cjs');
const { assistantBoundariesFixture } = require('./helpers/assistant-boundaries-fixture.cjs');
const clock = { date: '2026-11-10', hour: 12, minute: 0 };
const negatives = [
  ['Я не хочу отменить запись Синтетической Анны завтра.', 'cancelAppointment'],
  ['Не нужно перенести запись Синтетической Анны на завтра в 11:00.', 'moveAppointment'],
  ['Не надо передвинуть запись Синтетической Анны.', 'moveAppointment'],
  ['Не следует сдвинуть запись Синтетической Анны.', 'moveAppointment'],
];
for (const [raw, intent] of negatives) {
  test('modal denial grounds model action: ' + raw, () => {
    assert.equal(detectRequestedOperation(raw).negated, true);
    assert.throws(() => assertIntentAction(raw, intent), { status: 400 });
    assert.throws(
      () => prepareManagementIntent({ intent, query: 'Синтетическая Анна' }, raw, clock),
      { status: 400 },
    );
    assert.doesNotThrow(() => assertIntentAction(raw, 'help'));
    const positive = raw.replace('не ', '').replace('Не ', '');
    assert.equal(detectRequestedOperation(positive).negated, false);
    assert.doesNotThrow(() => assertIntentAction(positive, intent));
  });
}
test('early denial leaves uncovered framing and alternatives on late guards', () => {
  for (const raw of [
    'Если не хочу отменить запись Синтетической Анны, покажи календарь.',
    'Не хочу отменить запись Если завтра.',
    'Не отменить запись.',
    'Не отменяй запись, а перенеси на завтра.',
    'Я не хочу отменить запись Синтетической Анны, но хочу проверить время.',
    'Не отменяй запись если завтра выходной.',
    'Почему не надо перенести запись Синтетической Анны?',
  ])
    assert.doesNotThrow(() => assertEarlyNegativeAction(raw));
  for (const raw of [
    'Перенеси запись Синтетической Анны не раньше завтра.',
    'Перенеси запись Синтетической Анны не на понедельник, а на вторник.',
    'Перенеси запись Синтетической Анны, не меняй услугу.',
    'Я не хочу чай. Перенеси запись Синтетической Анны.',
  ]) {
    assert.equal(detectRequestedOperation(raw).negated, false);
    assert.doesNotThrow(() => assertEarlyNegativeAction(raw));
  }
});
test('initial unconditional denial rejects before provider, quotas and dialogue ownership', async (t) => {
  const f = await assistantBoundariesFixture(t);
  const before = f.readState(),
    stats = f.api.runtimeStats();
  for (const [text] of [
    ...negatives,
    ['Не отменяй запись Синтетической Анны.'],
    ['Пожалуйста, не переноси запись.'],
    ['Не записывай клиента Анну Семёнову завтра в 10:00.'],
  ])
    await assert.rejects(f.request('llm', 'owner', { text }), {
      status: 400,
      message: 'Действие не выполняю. Назовите нужную команду.',
    });
  assert.deepEqual(f.calls, { llm: 0, stt: 0, tts: 0 });
  assert.deepEqual(f.readState(), before);
  assert.deepEqual(f.api.runtimeStats(), stats);
  const result = await f.request('llm', 'owner', { text: 'Покажи календарь на завтра.' });
  assert.equal(result.action.type, 'calendar');
});
test('framed negative still calls model help rather than using initial shortcut', async (t) => {
  const f = await assistantBoundariesFixture(t);
  f.hooks.llm = async () => ({ text: JSON.stringify({ intent: 'help' }) });
  const result = await f.request('llm', 'owner', {
    text: 'Объясни, почему я не хочу отменить запись.',
  });
  assert.equal(f.calls.llm, 1);
  assert.equal(result.intent, 'help');
});
const { cancellationFixture } = require('./helpers/assistant-cancellation-fixture.cjs');
const {
  managementCommandTransition,
} = require('../src/server/modules/assistant/dialogue/dialogue-command-transition.cjs');
test('active cancellation does not treat modal denial as confirmation or a positive command transition', (t) => {
  const negative = cancellationFixture(t, { enabled: false });
  assert.equal(negative.result.dialogue.phase, 'cancelConfirmation');
  const before = negative.row();
  const text = 'Я не хочу отменить запись Анны Семёновой завтра.';
  const entry = negative.flow.get(
    negative.c,
    negative.member,
    negative.state,
    negative.result.dialogue.id,
  );
  assert.equal(managementCommandTransition(entry, text, negative.clock), false);
  negative.answer({ text });
  assert.equal(negative.result.action, null);
  assert.deepEqual(negative.row(), before);
  assert.equal(negative.calls(), 0);
  const positive = cancellationFixture(t, { enabled: false });
  positive.answer({ text: 'да' });
  assert.equal(positive.result.action.type, 'appointmentPreview');
  assert.equal(positive.result.action.operation, 'cancel');
  assert.equal(positive.calls(), 0);
});
