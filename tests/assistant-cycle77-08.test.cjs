const test = require('node:test');
const assert = require('node:assert/strict');
const { moveExecutionFixture } = require('./helpers/assistant-move-execution-fixture.cjs');
for (const direction of ['попозже', 'пораньше'])
  test('rejecting the time abandons the pending shift question: ' + direction, (t) => {
    const f = moveExecutionFixture(t, { targetTime: null });
    f.answer({ text: direction });
    assert.ok(f.entry().data.management.pendingShift);
    f.answer({ text: 'другое время' });
    assert.equal(f.entry().data.management.pendingShift, undefined);
    f.answer({ text: 'на час' });
    assert.equal(f.entry().data.management.targetTime, '13:00');
    assert.equal(f.result.action?.type, 'moveAppointment');
    assert.equal(f.calls(), 0);
  });
