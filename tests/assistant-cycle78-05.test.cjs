const test = require('node:test');
const assert = require('node:assert/strict');
const {
  moveExecutionFixture,
  day,
  tomorrow,
} = require('./helpers/assistant-move-execution-fixture.cjs');
for (const phrase of ['Нет, другое время', 'Нет, поменяй время'])
  test(
    'an empty source clock correction keeps the source date and invalidates cancel consent: ' +
      phrase,
    (t) => {
      const f = moveExecutionFixture(t, {
        targetTime: null,
        beforeStart(f) {
          f.addBooking({ date: tomorrow, time: '10:00' });
          f.addBooking({ date: tomorrow, time: '15:00' });
        },
      });
      f.start({ intent: 'cancelAppointment', date: null, time: '10:00' });
      f.answer({ text: 'завтра' });
      assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
      const old = f.result.dialogue;
      f.answer({ text: phrase });
      assert.match(f.result.text, /Во сколько запись/u);
      assert.equal(f.entry().data.management.sourceDate, tomorrow);
      assert.equal(f.entry().data.management.sourceTime, undefined);
      f.answer({ text: 'да' });
      assert.equal(f.result.action, null);
      f.answer({ text: 'в 15:00' });
      assert.equal(f.entry().data.management.source.appointmentId, f.rows()[2].id);
      assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
      assert.throws(
        () =>
          f.management.continueDialogue(
            f.c,
            { dialogueId: old.id, dialogueVersion: old.version, choice: old.options[0].id },
            f.state,
            f.member,
            f.clock,
          ),
        { status: 409 },
      );
      assert.equal(f.calls(), 0);
    },
  );
