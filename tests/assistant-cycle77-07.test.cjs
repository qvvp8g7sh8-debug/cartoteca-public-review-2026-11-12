const test = require('node:test');
const assert = require('node:assert/strict');
const {
  moveExecutionFixture,
  day,
  tomorrow,
} = require('./helpers/assistant-move-execution-fixture.cjs');
for (const verb of [
  'Перезапиши',
  'Перезаписать',
  'Передвиньте',
  'Сдвинуть',
  'Измени',
  'Поменяй время',
])
  test('supported move synonyms retain target fields before choosing a source: ' + verb, (t) => {
    const f = moveExecutionFixture(t, {
      targetTime: null,
      beforeStart(f) {
        f.addBooking({ date: day, time: '15:00' });
      },
    });
    f.start({ date: null }, { date: null, time: null });
    f.answer({
      text: verb + (verb === 'Поменяй время' ? ' записи' : ' запись') + ' на завтра в 16:00',
    });
    assert.equal(f.entry().data.management.initialDate, tomorrow);
    assert.equal(f.entry().data.management.initialTime, '16:00');
    assert.equal(f.result.dialogue.options.length, 2);
    f.answer({ choice: f.result.dialogue.options[0].id });
    assert.equal(f.result.action?.type, 'moveAppointment');
    assert.equal(f.entry().data.management.targetTime, '16:00');
    assert.equal(f.calls(), 0);
  });
test('a negated synonym cannot set a target', (t) => {
  const f = moveExecutionFixture(t, {
    targetTime: null,
    beforeStart(f) {
      f.addBooking({ date: day, time: '15:00' });
    },
  });
  f.answer({ text: 'Не передвигайте запись на завтра в 16:00' });
  assert.equal(f.entry().data.management.initialTime, undefined);
  assert.equal(f.result.action, null);
});
