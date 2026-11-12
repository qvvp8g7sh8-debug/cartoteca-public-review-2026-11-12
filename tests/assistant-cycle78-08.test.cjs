const test = require('node:test');
const assert = require('node:assert/strict');
const { moveExecutionFixture, day } = require('./helpers/assistant-move-execution-fixture.cjs');
function fixture(t) {
  const f = moveExecutionFixture(t, {
    closed: true,
    beforeStart(f) {
      f.addBooking({ date: day, time: '15:00' });
    },
  });
  f.answer({ choice: f.result.dialogue.options[0].id });
  return f;
}
test('revoked access cannot confirm a move after source reselection', (t) => {
  const f = fixture(t);
  f.answer({ text: 'нет, вторую' });
  const before = f.rows();
  f.revoke();
  assert.throws(() => f.answer({ text: 'да' }), { status: 403 });
  assert.deepEqual(f.rows(), before);
  assert.equal(f.calls(), 0);
});
test('a changed alternative source rejects its old ordinal and can be selected afresh', (t) => {
  const f = fixture(t);
  const initial = f.entry().data.management.source.appointmentId;
  f.mutate((next) => {
    next.patients[0].appointments[1].time = '15:30';
  });
  assert.throws(() => f.answer({ text: 'нет, вторую' }), { status: 409 });
  assert.equal(f.entry().data.management.source.appointmentId, initial);
  assert.equal(f.calls(), 0);
  f.answer({ text: 'другую запись' });
  f.answer({ choice: f.result.dialogue.options[1].id });
  assert.equal(f.entry().data.management.source.appointmentId, f.rows()[1].id);
  assert.equal(f.result.dialogue.phase, 'closedDay');
  assert.equal(f.result.action, null);
  assert.equal(f.calls(), 0);
});
