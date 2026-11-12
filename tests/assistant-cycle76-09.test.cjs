const test = require('node:test');
const assert = require('node:assert/strict');
const {
  moveExecutionFixture,
  tomorrow,
} = require('./helpers/assistant-move-execution-fixture.cjs');
for (const phrase of ['поменяй время', 'измени время'])
  test(
    'an empty clock edit keeps the date but invalidates the previous gate: ' + phrase,
    async (t) => {
      const f = moveExecutionFixture(t, { closed: true }),
        old = f.result.dialogue;
      const source = structuredClone(f.entry().data.management.source);
      f.answer({ text: phrase });
      assert.equal(f.result.dialogue.step, 'time');
      assert.equal(f.entry().data.management.targetDate, tomorrow);
      assert.equal(f.entry().data.management.targetTime, null);
      assert.deepEqual(f.entry().data.management.source, source);
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
      assert.equal(f.result.action, null);
      f.answer({ text: 'в 16:00' });
      assert.equal(f.result.dialogue.phase, 'closedDay');
      f.answer({ text: 'да' });
      assert.equal((await f.api.execute(f.c, f.body())).moved, true);
      assert.equal(f.row().time, '16:00');
      assert.equal(f.calls(), 1);
    },
  );
test('clock edit can temporarily precede a pending month without losing its day', (t) => {
  const f = moveExecutionFixture(t, {
    targetTime: null,
    beforeStart(f) {
      f.days['2099-01-29'] = { status: 'working', intervals: [['09:00', '18:00']] };
    },
  });
  f.answer({ text: 'на двадцать девятое' });
  f.answer({ text: 'поменяй время' });
  assert.equal(f.result.dialogue.step, 'time');
  assert.equal(f.entry().data.management.dateProposal.day, 29);
  f.answer({ text: 'в 16:00' });
  assert.match(f.result.text, /января/u);
  f.answer({ text: 'да' });
  assert.equal(f.result.action.type, 'moveAppointment');
  assert.equal(f.entry().data.management.targetTime, '16:00');
  assert.equal(f.entry().data.management.targetDate, '2099-01-29');
});
