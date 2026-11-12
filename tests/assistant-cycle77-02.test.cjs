const test = require('node:test');
const assert = require('node:assert/strict');
const { moveExecutionFixture } = require('./helpers/assistant-move-execution-fixture.cjs');
for (const phrase of ['подбери свободное время', 'найди ближайшее окно'])
  test('an explicit window search replaces an unresolved period: ' + phrase, (t) => {
    const f = moveExecutionFixture(t, { targetTime: null });
    f.start({}, { time: null, timeWindowRequired: true });
    f.answer({ text: phrase });
    assert.equal(f.entry().data.management.timeWindowRequired, false);
    assert.ok(f.result.dialogue.options.length > 0);
    assert.doesNotMatch(f.result.text, /В какой период/u);
    assert.equal(f.result.action, null);
    assert.equal(f.calls(), 0);
  });
