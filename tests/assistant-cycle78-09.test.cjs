const test = require('node:test');
const assert = require('node:assert/strict');
const {
  moveExecutionFixture,
  day,
  tomorrow,
} = require('./helpers/assistant-move-execution-fixture.cjs');
for (const duration of [60, 90])
  test(
    'a longer reselected source cannot fit into the former short service window: ' + duration,
    (t) => {
      const f = moveExecutionFixture(t, {
        targetTime: null,
        beforeStart(f) {
          f.addBooking({ date: day, time: '15:00', duration });
        },
      });
      const before = f.rows();
      f.answer({ choice: f.result.dialogue.options[0].id });
      f.answer({ text: 'с 9:00 до 9:30' });
      assert.ok(f.result.dialogue.options.length);
      f.answer({ text: 'другую запись' });
      f.answer({ choice: f.result.dialogue.options[1].id });
      assert.equal(f.entry().data.management.source.appointmentId, f.rows()[1].id);
      assert.equal(f.entry().data.management.targetDate, tomorrow);
      assert.equal(f.entry().data.management.targetWindow.from, '09:00');
      assert.equal(f.entry().data.management.targetWindow.to, '09:30');
      assert.equal(f.result.action, null);
      assert.equal(f.result.dialogue.options.length, 0);
      assert.equal(f.calls(), 0);
      assert.deepEqual(f.rows(), before);
    },
  );
