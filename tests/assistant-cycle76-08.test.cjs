const test = require('node:test');
const assert = require('node:assert/strict');
const { moveExecutionFixture } = require('./helpers/assistant-move-execution-fixture.cjs');
function fixture(t) {
  return moveExecutionFixture(t, {
    targetTime: null,
    beforeStart(f) {
      f.days['2099-01-29'] = { status: 'working', intervals: [['09:00', '18:00']] };
    },
  });
}
for (const direction of ['попозже', 'пораньше'])
  test(
    'changing the date abandons a pending shift amount before the next clock answer: ' + direction,
    (t) => {
      const f = fixture(t);
      f.answer({ text: direction });
      assert.ok(f.entry().data.management.pendingShift);
      f.answer({ text: 'на двадцать девятое' });
      assert.equal(f.entry().data.management.pendingShift, undefined);
      f.answer({ text: 'да' });
      f.answer({ text: 'на час' });
      assert.equal(f.result.action.type, 'moveAppointment');
      assert.equal(f.entry().data.management.targetTime, '13:00');
      assert.equal(f.entry().data.management.targetDate, '2099-01-29');
    },
  );
test('searching for windows abandons a pending relative amount too', (t) => {
  const f = fixture(t);
  f.answer({ text: 'попозже' });
  f.answer({ text: 'подбери свободное время' });
  assert.equal(f.entry().data.management.pendingShift, undefined);
  f.answer({ text: 'на час' });
  assert.equal(f.entry().data.management.targetTime, '13:00');
});
test('answering the amount immediately still uses the retained direction', (t) => {
  const f = fixture(t);
  f.answer({ text: 'попозже' });
  f.answer({ text: 'на час' });
  assert.equal(f.entry().data.management.targetTime, '11:00');
  assert.equal(f.result.action.type, 'moveAppointment');
});
