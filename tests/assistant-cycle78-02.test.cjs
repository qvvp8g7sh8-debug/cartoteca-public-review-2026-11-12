const test = require('node:test');
const assert = require('node:assert/strict');
const { moveExecutionFixture } = require('./helpers/assistant-move-execution-fixture.cjs');
for (const suffix of ['на час позже', 'в то же время'])
  test(
    'pending month and a proven relative clock replace unresolved period together: ' + suffix,
    (t) => {
      const f = moveExecutionFixture(t, {
        targetTime: null,
        beforeStart(f) {
          f.days['2099-01-29'] = { status: 'working', intervals: [['09:00', '18:00']] };
        },
      });
      f.start({}, { time: null, timeWindowRequired: true });
      f.answer({ text: 'на двадцать девятое ' + suffix });
      assert.equal(f.entry().data.management.dateProposal.day, 29);
      f.answer({ text: 'да' });
      assert.equal(f.result.action?.type, 'moveAppointment');
      assert.equal(f.entry().data.management.timeWindowRequired, false);
      assert.equal(f.entry().data.management.targetDate, '2099-01-29');
      assert.equal(
        f.entry().data.management.targetTime,
        suffix === 'на час позже' ? '11:00' : '10:00',
      );
      assert.equal(f.calls(), 0);
    },
  );
