const test = require('node:test');
const assert = require('node:assert/strict');
const {
  moveExecutionFixture,
  tomorrow,
} = require('./helpers/assistant-move-execution-fixture.cjs');
for (const phrase of ['поменяй время', 'другая дата', 'подбери свободное время'])
  test('a new target edit discards an obsolete relative shift error: ' + phrase, (t) => {
    const f = moveExecutionFixture(t, { targetTime: null });
    f.start({}, { time: null, relativeTarget: { kind: 'shiftTime', minutes: -700 } });
    assert.match(f.result.text, /сдвиг меняет день/u);
    f.answer({ text: phrase });
    assert.equal(f.entry().data.management.relativeHelp, undefined);
    if (phrase === 'другая дата') f.answer({ text: 'завтра' });
    assert.doesNotMatch(f.result.text, /сдвиг меняет день/u);
    assert.equal(f.result.action, null);
    if (phrase !== 'другая дата') assert.equal(f.entry().data.management.targetDate, tomorrow);
    assert.equal(f.calls(), 0);
  });
