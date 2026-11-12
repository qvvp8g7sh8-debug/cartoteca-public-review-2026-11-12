const test = require('node:test');
const assert = require('node:assert/strict');
const {
  moveExecutionFixture,
  day,
  tomorrow,
} = require('./helpers/assistant-move-execution-fixture.cjs');
const {
  cancellationSourceCorrection,
} = require('../src/server/modules/assistant/actions/appointments/appointment-cancellation-correction.cjs');
test('a source month correction replaces the month of a previously exact source date', (t) => {
  const f = moveExecutionFixture(t, {
    targetTime: null,
    beforeStart(f) {
      f.addBooking({ date: day, time: '15:00' });
      f.addBooking({ date: '2099-02-05', time: '10:00' });
    },
  });
  f.answer({ text: '5 января 2099' });
  assert.equal(f.result.dialogue.options.length, 2);
  f.answer({ text: 'в феврале' });
  assert.equal(f.entry().data.management.source?.appointmentId, f.rows()[2].id);
  assert.equal(f.entry().data.management.sourceDay, 5);
  assert.equal(f.entry().data.management.sourceDate, undefined);
  assert.equal(f.entry().data.management.targetDate, tomorrow);
  assert.equal(f.result.dialogue.step, 'time');
});
test('the same source month correction is available at cancellation consent', () => {
  const entry = {
    step: 'appointment',
    data: { management: { operation: 'cancel', sourceDate: day } },
    options: new Map(),
  };
  assert.deepEqual(cancellationSourceCorrection(entry, 'Нет, в феврале', { date: day }), {
    kind: 'sourceMonth',
    month: 2,
    year: null,
  });
});
