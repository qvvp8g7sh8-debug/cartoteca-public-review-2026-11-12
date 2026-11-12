const test = require('node:test');
const assert = require('node:assert/strict');
const {
  moveExecutionFixture,
  day,
  tomorrow,
} = require('./helpers/assistant-move-execution-fixture.cjs');
function fixture(t, cancel = false) {
  const f = moveExecutionFixture(t, {
    targetTime: null,
    beforeStart(f) {
      f.addBooking({ date: day, time: '15:00' });
      f.addBooking({ date: tomorrow, time: '14:00' });
    },
  });
  f.start({
    intent: cancel ? 'cancelAppointment' : 'moveAppointment',
    date: cancel ? day : tomorrow,
    time: null,
  });
  if (!cancel) f.answer({ text: '5 января 2099' });
  return f;
}
for (const cancel of [false, true])
  test(
    'an empty source date correction keeps the target and waits for a new source date: ' + cancel,
    (t) => {
      const f = fixture(t, cancel);
      f.answer({ text: 'другая дата' });
      assert.match(f.result.text, /На какую дату запись/u);
      assert.equal(f.entry().data.management.source, null);
      f.answer({ text: 'завтра' });
      assert.equal(f.entry().data.management.source.appointmentId, f.rows()[2].id);
      assert.equal(f.result.action, null);
      if (cancel) assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
      else {
        assert.equal(f.entry().data.management.targetDate, tomorrow);
        assert.equal(f.result.dialogue.step, 'time');
      }
      assert.equal(f.calls(), 0);
    },
  );
test('changing only source date at cancel consent invalidates the old yes gate', (t) => {
  const f = fixture(t, true);
  f.answer({ choice: f.result.dialogue.options[0].id });
  const old = f.result.dialogue;
  f.answer({ text: 'Нет, другую дату' });
  assert.match(f.result.text, /На какую дату запись/u);
  f.answer({ text: 'да' });
  assert.equal(f.result.action, null);
  f.answer({ text: 'завтра' });
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
});
