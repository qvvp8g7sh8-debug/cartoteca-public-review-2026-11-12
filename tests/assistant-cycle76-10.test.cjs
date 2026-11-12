const test = require('node:test');
const assert = require('node:assert/strict');
const { moveExecutionFixture, day } = require('./helpers/assistant-move-execution-fixture.cjs');
const {
  selectExamples,
} = require('../src/server/modules/assistant/behavior/example-selection.cjs');
function fixture(t) {
  return moveExecutionFixture(t, {
    targetTime: null,
    beforeStart(f) {
      f.members.push({
        accountId: 'maria',
        displayName: 'Мария Иванова',
        role: 'cosmetologist',
        status: 'active',
      });
      f.workspace.rooms[0].staffIds.push('maria');
      f.workspace.rooms[0].staffMode = 'multiple';
      f.addBooking({ date: day, time: '15:00', staffId: 'maria' });
    },
  });
}
for (const phrase of ['у Марии Ивановой', 'у специалиста Марии Ивановой'])
  test(
    'a source staff clarification selects an existing appointment and retains its performer: ' +
      phrase,
    (t) => {
      const f = fixture(t),
        id = f.result.dialogue.id;
      f.answer({ text: phrase });
      assert.equal(f.result.dialogue.id, id);
      assert.equal(f.result.dialogue.step, 'time');
      assert.equal(f.entry().data.management.source.appointmentId, f.rows()[1].id);
      f.answer({ text: 'в 16:00' });
      assert.equal(f.result.action.type, 'moveAppointment');
      assert.equal(f.entry().data.management.movePreparation.target.staffId, 'maria');
      assert.equal(f.calls(), 0);
    },
  );
test('an unknown staff filter does not erase the client or the valid appointment choices', (t) => {
  const f = fixture(t),
    id = f.entry().data.patient.id;
  f.answer({ text: 'у Ольги Ивановой' });
  assert.equal(f.entry().data.patient.id, id);
  assert.equal(f.result.dialogue.options.length, 2);
  assert.equal(f.entry().data.management.staffQuery, '');
});
test('inactive staff cannot be promoted through a source clarification', (t) => {
  const f = fixture(t);
  f.members[1].status = 'inactive';
  f.answer({ text: 'у Марии Ивановой' });
  assert.equal(f.entry().data.management.source, null);
  assert.equal(f.result.action, null);
});
test('new initial examples teach positive moves and keep time unknown for a period', () => {
  const policy = {
    exampleSelection: 'automatic',
    examples: [],
    commands: { calendar: true, clients: true, prepareAppointment: true },
  };
  for (const text of [
    'Перенеси запись Анны Ивановой на завтра утром',
    'Перенеси запись Анны Ивановой на завтра. Найди свободное время',
  ]) {
    const result = selectExamples(text, policy);
    assert.ok(
      result.metadata.selected.some((row) => /current-move-(morning|with-window)/u.test(row.id)),
    );
    assert.ok(
      result.examples.some(
        (row) => row.expected.intent === 'moveAppointment' && row.expected.time === null,
      ),
    );
    assert.ok(result.metadata.bytes <= 4096);
  }
});
