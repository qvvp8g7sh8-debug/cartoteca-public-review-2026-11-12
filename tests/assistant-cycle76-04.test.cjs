const test = require('node:test');
const assert = require('node:assert/strict');
const { moveExecutionFixture, day } = require('./helpers/assistant-move-execution-fixture.cjs');
function fixture(t) {
  return moveExecutionFixture(t, {
    targetTime: null,
    targetDate: null,
    beforeStart(f) {
      f.addBooking({ date: day, time: '15:00' });
      f.days['2099-01-29'] = { status: 'working', intervals: [['09:00', '18:00']] };
    },
  });
}
for (const raw of [
  'на двадцать девятое в 16:00',
  'в 16:00 на двадцать девятое',
  'на 29-е на шестнадцать тридцать',
  'на шестнадцать тридцать на 29-е',
])
  test('a whole day+clock before source retains both and asks its month once: ' + raw, (t) => {
    const f = fixture(t),
      id = f.result.dialogue.id;
    f.answer({ text: 'Перенеси запись ' + raw });
    assert.equal(f.result.dialogue.phase, 'appointmentChoice');
    assert.equal(f.entry().data.management.dateProposal.day, 29);
    const time = raw.includes('тридцать') ? '16:30' : '16:00';
    assert.equal(f.entry().data.management.initialTime, time);
    f.answer({ choice: f.result.dialogue.options[1].id });
    assert.match(f.result.dialogue.prompt, /января/u);
    f.answer({ text: 'да' });
    assert.equal(f.result.action.executionId, id);
    assert.equal(f.entry().data.management.targetDate, '2099-01-29');
    assert.equal(f.entry().data.management.targetTime, time);
    assert.equal(f.entry().data.management.source.appointmentId, f.rows()[1].id);
    assert.equal(f.calls(), 0);
  });
for (const raw of [
  'на 29-е в 16:00 или 17:00',
  'на 29-е в 16:00 и отмени запись',
  'на 29-е в 16:00 если свободно',
])
  test('a partial day+clock is not accepted by discarding conditions or actions: ' + raw, (t) => {
    const f = fixture(t);
    f.answer({ text: 'Перенеси запись ' + raw });
    assert.equal(f.result.action, null);
    assert.equal(f.entry().data.management.source, null);
    assert.equal(f.entry().data.management.initialTime, undefined);
  });
