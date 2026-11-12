const test = require('node:test');
const assert = require('node:assert/strict');
const {
  moveExecutionFixture,
  day,
  tomorrow,
} = require('./helpers/assistant-move-execution-fixture.cjs');
for (const phrase of ['другую запись', 'нет, вторую'])
  test(
    'reselecting the moved appointment retains the latest target and asks fresh consent: ' + phrase,
    async (t) => {
      const f = moveExecutionFixture(t, {
        closed: true,
        beforeStart(f) {
          f.addBooking({ date: day, time: '15:00' });
        },
      });
      f.answer({ choice: f.result.dialogue.options[0].id });
      f.answer({ text: 'в 16:00' });
      const old = f.result.dialogue;
      assert.equal(old.phase, 'closedDay');
      f.answer({ text: phrase });
      if (phrase === 'другую запись') {
        assert.equal(f.result.dialogue.phase, 'appointmentChoice');
        assert.equal(f.result.dialogue.options.length, 2);
        f.answer({ choice: f.result.dialogue.options[1].id });
      }
      assert.equal(f.entry().data.management.source.appointmentId, f.rows()[1].id);
      assert.equal(f.entry().data.management.targetDate, tomorrow);
      assert.equal(f.entry().data.management.targetTime, '16:00');
      assert.equal(f.result.dialogue.phase, 'closedDay');
      assert.equal(f.result.action, null);
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
      f.answer({ text: 'да' });
      await f.api.execute(f.c, f.body());
      assert.equal(f.rows()[0].time, '10:00');
      assert.equal(f.rows()[1].time, '16:00');
      assert.equal(f.calls(), 1);
    },
  );
test('source reselection cannot infer an independently unknown time', (t) => {
  const f = moveExecutionFixture(t, {
    targetTime: null,
    beforeStart(f) {
      f.addBooking({ date: day, time: '15:00' });
    },
  });
  f.answer({ choice: f.result.dialogue.options[0].id });
  f.answer({ text: 'другую запись' });
  f.answer({ choice: f.result.dialogue.options[1].id });
  assert.equal(f.entry().data.management.source.appointmentId, f.rows()[1].id);
  assert.equal(f.entry().data.management.targetDate, tomorrow);
  assert.equal(f.entry().data.management.targetTime, null);
  assert.equal(f.result.dialogue.step, 'time');
  assert.equal(f.result.action, null);
  assert.equal(f.calls(), 0);
});
