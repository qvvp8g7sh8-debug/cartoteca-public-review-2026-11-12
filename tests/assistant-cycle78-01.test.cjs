const test = require('node:test');
const assert = require('node:assert/strict');
const {
  moveExecutionFixture,
  day,
  tomorrow,
} = require('./helpers/assistant-move-execution-fixture.cjs');
for (const phrase of ['другое время', 'подбери свободное время'])
  test('source reselection cannot restore an abandoned requested clock: ' + phrase, (t) => {
    const f = moveExecutionFixture(t, {
      closed: true,
      beforeStart(f) {
        f.addBooking({ date: day, time: '15:00' });
      },
    });
    f.answer({ choice: f.result.dialogue.options[0].id });
    f.answer({ text: 'в 16:00' });
    f.answer({ text: phrase });
    assert.equal(f.entry().data.management.targetTime, null);
    f.answer({ text: 'другую запись' });
    f.answer({ choice: f.result.dialogue.options[1].id });
    assert.equal(f.entry().data.management.targetTime, null);
    assert.equal(f.entry().data.management.targetDate, tomorrow);
    assert.equal(f.result.dialogue.step, 'time');
    assert.notEqual(f.result.dialogue.phase, 'closedDay');
    assert.equal(f.result.action, null);
    assert.equal(f.calls(), 0);
  });
