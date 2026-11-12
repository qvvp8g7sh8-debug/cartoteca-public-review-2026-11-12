const test = require('node:test');
const assert = require('node:assert/strict');
const { taskOf } = require('../src/server/modules/assistant/behavior/example-routing.cjs');
const {
  appointmentSlotClause,
} = require('../src/server/modules/assistant/language/time/appointment-slot-clause.cjs');
const {
  normalizeManagementRequest,
  prepareManagementIntent,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-intent.cjs');
const { moveExecutionFixture } = require('./helpers/assistant-move-execution-fixture.cjs');
for (const tail of ['И НАЙДИ СВОБОДНОЕ ВРЕМЯ', 'И покажи ближайшее свободное окно'])
  test(
    'model example routing and server normalization agree on capitalized linked search: ' + tail,
    (t) => {
      const raw = 'Перенеси запись Анны Семёновой на завтра ' + tail;
      assert.equal(taskOf(raw).boundaryOnly, false);
      assert.ok(appointmentSlotClause(raw));
      const f = moveExecutionFixture(t, { targetTime: null });
      const parsed = normalizeManagementRequest({ intent: 'help' }, raw, f.clock);
      assert.equal(parsed.intent, 'moveAppointment');
      const { intent, constraints } = prepareManagementIntent(parsed, raw, f.clock);
      assert.equal(constraints.seekSlots, true);
      f.start(intent, constraints);
      assert.ok(f.result.dialogue.options.length);
      assert.equal(f.result.action, null);
      assert.equal(f.calls(), 0);
    },
  );
test('upper-case conjunction cannot merge a different client or independent action', () => {
  for (const raw of [
    'Перенеси запись Анны И найди свободное время для Ольги',
    'Перенеси запись Анны И отмени запись Ольги',
  ]) {
    assert.equal(appointmentSlotClause(raw), null);
    assert.equal(taskOf(raw).boundaryOnly, true);
  }
});
