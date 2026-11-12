const test = require('node:test');
const assert = require('node:assert/strict');
const {
  moveExecutionFixture,
  tomorrow,
} = require('./helpers/assistant-move-execution-fixture.cjs');
const {
  sourceDayOperation,
} = require('../src/server/modules/assistant/actions/appointments/appointment-source-selection.cjs');
for (const year of ['2099', 'в 2100 году'])
  test('shared source day and month require only the missing year: ' + year, (t) => {
    const f = moveExecutionFixture(t, {
      targetTime: null,
      beforeStart(f) {
        f.addBooking({ date: '2100-01-05', time: '11:00' });
      },
    });
    f.answer({ text: 'на пятое' });
    assert.match(f.result.text, /В каком году запись/u);
    f.answer({ text: year });
    assert.equal(
      f.entry().data.management.source.appointmentId,
      f.rows()[year === '2099' ? 0 : 1].id,
    );
    assert.equal(f.entry().data.management.targetDate, tomorrow);
    assert.equal(f.entry().data.management.targetTime, null);
    assert.equal(f.result.dialogue.step, 'time');
    assert.equal(f.calls(), 0);
  });
test('four digits cannot become a source year outside its actual question', () => {
  const e = { data: { management: { sourceDay: 5, sourceMonth: 1 } }, options: new Map() };
  assert.equal(sourceDayOperation(e, 'в 2100'), null);
});
