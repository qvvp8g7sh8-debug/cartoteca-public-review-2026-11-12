const test = require('node:test');
const assert = require('node:assert/strict');
const {
  moveExecutionFixture,
  day,
  tomorrow,
} = require('./helpers/assistant-move-execution-fixture.cjs');
function fixture(t, proposal) {
  const f = moveExecutionFixture(t, {
    targetTime: null,
    beforeStart(f) {
      f.addBooking({ date: day, time: '15:00' });
    },
  });
  f.start(
    { date: null, time: null },
    {
      date: null,
      time: null,
      ...(proposal ? { dateProposal: { day: 29, date: '2099-01-29' } } : {}),
    },
  );
  return f;
}
for (const earlier of [false, true])
  for (const proposal of [false, true])
    test(
      'absolute date with relative clock clears only obsolete date uncertainty: ' +
        earlier +
        '/' +
        proposal,
      (t) => {
        const f = fixture(t, proposal),
          id = f.result.dialogue.id;
        f.answer({ text: 'Перенеси запись на завтра на час ' + (earlier ? 'раньше' : 'позже') });
        assert.equal(f.entry().data.management.dateRequired, false);
        assert.equal(f.entry().data.management.dateProposal, undefined);
        assert.equal(f.entry().data.management.initialDate, tomorrow);
        f.answer({ choice: f.result.dialogue.options[0].id });
        assert.equal(f.result.action.executionId, id);
        assert.equal(f.entry().data.management.targetDate, tomorrow);
        assert.equal(f.entry().data.management.targetTime, earlier ? '09:00' : '11:00');
        assert.equal(f.calls(), 0);
      },
    );
test('relative clock alone cannot fill an independently unknown date', (t) => {
  const f = fixture(t);
  f.answer({ text: 'Перенеси запись на час позже' });
  f.answer({ choice: f.result.dialogue.options[0].id });
  assert.equal(f.result.dialogue.step, 'date');
  assert.equal(f.entry().data.management.targetDate, null);
  assert.equal(f.result.action, null);
});
