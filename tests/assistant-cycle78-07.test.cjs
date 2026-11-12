const test = require('node:test');
const assert = require('node:assert/strict');
const {
  moveExecutionFixture,
  day,
  tomorrow,
} = require('./helpers/assistant-move-execution-fixture.cjs');
for (const field of ['date', 'time'])
  test(
    'informational controls cannot fill a cleared source field or revive consent: ' + field,
    (t) => {
      const f = moveExecutionFixture(t, {
        targetTime: null,
        beforeStart(f) {
          f.addBooking({ date: day, time: '15:00' });
          f.addBooking({ date: tomorrow, time: '10:00' });
        },
      });
      f.start({
        intent: 'cancelAppointment',
        date: field === 'date' ? day : null,
        time: field === 'time' ? '10:00' : null,
      });
      f.answer({ text: field === 'date' ? 'поменяй дату' : 'поменяй время' });
      const id = f.result.dialogue.id;
      for (const text of ['повтори вопрос', 'что уже выбрано', 'повтори варианты']) {
        f.answer({ text });
        assert.equal(f.result.dialogue.id, id);
        assert.equal(f.result.action, null);
        assert.equal(f.entry().data.management.source, null);
        assert.equal(
          f.entry().data.management[field === 'date' ? 'sourceDateRequired' : 'sourceTimeRequired'],
          true,
        );
        assert.equal(f.result.dialogue.options.length, 0);
        assert.equal(f.calls(), 0);
      }
      f.answer({ text: 'да' });
      assert.equal(f.result.action, null);
      f.answer({ text: field === 'date' ? 'завтра' : 'в 15:00' });
      assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
      assert.equal(f.result.action, null);
      assert.equal(
        f.entry().data.management.source.appointmentId,
        f.rows()[field === 'date' ? 2 : 1].id,
      );
    },
  );
