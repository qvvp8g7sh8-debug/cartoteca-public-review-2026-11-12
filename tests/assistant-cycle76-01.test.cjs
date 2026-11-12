const test = require('node:test');
const assert = require('node:assert/strict');
const {
  moveExecutionFixture,
  tomorrow,
} = require('./helpers/assistant-move-execution-fixture.cjs');
for (const text of ['в 16:00', 'завтра в 16:00'])
  test('an exact clock replaces an unresolved initial period: ' + text, (t) => {
    const f = moveExecutionFixture(t, { targetTime: null });
    f.start({}, { time: null, timeWindowRequired: true });
    assert.match(f.result.text, /В какой период/u);
    const source = structuredClone(f.entry().data.management.source);
    f.answer({ text });
    assert.equal(f.result.action.type, 'moveAppointment');
    assert.equal(f.entry().data.management.timeWindowRequired, false);
    assert.equal(f.entry().data.management.targetDate, tomorrow);
    assert.deepEqual(f.entry().data.management.source, source);
    assert.equal(f.calls(), 0);
  });
test('a date-only correction cannot silently discard an unresolved time period', (t) => {
  const f = moveExecutionFixture(t, { targetTime: null });
  f.start({}, { time: null, timeWindowRequired: true });
  f.answer({ text: 'завтра' });
  assert.equal(f.result.action, null);
  assert.equal(f.entry().data.management.timeWindowRequired, true);
});
test('a named period is also a valid repair and still asks an exact start', (t) => {
  const f = moveExecutionFixture(t, { targetTime: null });
  f.start({}, { time: null, timeWindowRequired: true });
  f.answer({ text: 'утром' });
  assert.equal(f.result.action, null);
  assert.equal(f.entry().data.management.timeWindowRequired, false);
  assert.equal(f.entry().data.management.targetWindow.kind, 'morning');
});
