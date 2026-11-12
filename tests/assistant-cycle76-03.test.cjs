const test = require('node:test');
const assert = require('node:assert/strict');
const {
  moveExecutionFixture,
  day,
  tomorrow,
} = require('./helpers/assistant-move-execution-fixture.cjs');
const { cancellationFixture } = require('./helpers/assistant-cancellation-fixture.cjs');
for (const phrase of ['другая дата', 'поменяй дату', 'другой день'])
  test(
    'date editing from a closed-day gate preserves source and independent exact clock: ' + phrase,
    (t) => {
      const f = moveExecutionFixture(t, { closed: true }),
        source = structuredClone(f.entry().data.management.source);
      f.answer({ text: phrase });
      assert.equal(f.result.dialogue.step, 'date');
      assert.equal(f.entry().data.management.dateProposal, undefined);
      assert.equal(f.entry().data.management.targetTime, '12:30');
      assert.deepEqual(f.entry().data.management.source, source);
      f.answer({ text: day });
      assert.equal(f.result.action.type, 'moveAppointment');
      assert.equal(f.entry().data.management.targetTime, '12:30');
      assert.equal(f.calls(), 0);
    },
  );
test('a pending month can be abandoned without losing its stated clock', (t) => {
  const f = moveExecutionFixture(t, { targetDate: null, targetTime: '16:00' });
  f.start({ date: null, time: '16:00' }, { date: null });
  f.answer({ text: 'на двадцать девятое' });
  f.answer({ text: 'другая дата' });
  assert.equal(f.result.dialogue.step, 'date');
  assert.equal(f.entry().data.management.dateProposal, undefined);
  f.answer({ text: tomorrow });
  assert.equal(f.result.action.type, 'moveAppointment');
  assert.equal(f.entry().data.management.targetTime, '16:00');
});
test('date editing cannot turn a cancellation confirmation into a target move', (t) => {
  const f = cancellationFixture(t),
    before = f.result.dialogue;
  f.answer({ text: 'поменяй дату' });
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  assert.equal(f.result.dialogue.id, before.id);
  assert.equal(f.result.action, null);
});
