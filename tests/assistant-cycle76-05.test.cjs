const test = require('node:test');
const assert = require('node:assert/strict');
const { taskOf } = require('../src/server/modules/assistant/behavior/example-routing.cjs');
const {
  selectExamples,
} = require('../src/server/modules/assistant/behavior/example-selection.cjs');
const {
  prepareManagementIntent,
  normalizeManagementRequest,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-intent.cjs');
const { moveExecutionFixture } = require('./helpers/assistant-move-execution-fixture.cjs');
const { modelPayload } = require('../src/server/modules/assistant/interpretation/intents.cjs');
const { initialState } = require('../src/server/modules/assistant/access/defaults.cjs');
const policy = {
  exampleSelection: 'automatic',
  examples: [],
  commands: { calendar: true, clients: true, prepareAppointment: true },
};
for (const raw of [
  'Перенеси запись Анны Семёновой на завтра. Найди свободное время',
  'Перенеси запись Анны Семёновой на завтра и покажи ближайшее свободное окно',
])
  test(
    'a move and its whole window request share routing, prompt and real availability: ' + raw,
    (t) => {
      assert.equal(taskOf(raw).boundaryOnly, false);
      const selected = selectExamples(raw, policy);
      assert.ok(selected.examples.some((row) => row.expected.intent === 'moveAppointment'));
      const f = moveExecutionFixture(t, { targetTime: null });
      const parsed = normalizeManagementRequest({ intent: 'help' }, raw, f.clock);
      const { intent, constraints } = prepareManagementIntent(parsed, raw, f.clock);
      f.start(intent, constraints);
      assert.equal(f.result.action, null);
      assert.ok(f.result.dialogue.options.length);
      assert.equal(f.entry().data.management.targetTime, null);
      const state = initialState();
      state.policy = { ...state.policy, ...policy };
      assert.match(
        modelPayload(raw, state, 'Europe/Moscow').payload.messages[0].content,
        /одна задача moveAppointment/u,
      );
    },
  );
for (const raw of [
  'Перенеси запись Анны. Найди карточку Ольги',
  'Перенеси запись Анны. Найди свободное время для Ольги',
  'Перенеси запись Анны и отмени запись Ольги',
])
  test('independent lookup or another person remains a boundary: ' + raw, () => {
    assert.equal(taskOf(raw).boundaryOnly, true);
  });
