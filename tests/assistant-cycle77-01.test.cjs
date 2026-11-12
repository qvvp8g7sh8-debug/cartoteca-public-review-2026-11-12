const test = require('node:test');
const assert = require('node:assert/strict');
const {
  moveExecutionFixture,
  day,
  tomorrow,
} = require('./helpers/assistant-move-execution-fixture.cjs');
for (const phrase of ['на час позже', 'в то же время'])
  test(
    'an explicit relative clock replaces unresolved period before source choice: ' + phrase,
    (t) => {
      const f = moveExecutionFixture(t, {
        targetTime: null,
        beforeStart(f) {
          f.addBooking({ date: day, time: '15:00' });
        },
      });
      f.start({}, { time: null, timeWindowRequired: true });
      f.answer({ text: 'Перенеси запись ' + phrase });
      f.answer({ choice: f.result.dialogue.options[0].id });
      assert.equal(f.result.action?.type, 'moveAppointment');
      assert.equal(f.entry().data.management.timeWindowRequired, false);
      assert.equal(f.entry().data.management.targetDate, tomorrow);
      assert.equal(
        f.entry().data.management.targetTime,
        phrase === 'на час позже' ? '11:00' : '10:00',
      );
      assert.equal(f.calls(), 0);
    },
  );
