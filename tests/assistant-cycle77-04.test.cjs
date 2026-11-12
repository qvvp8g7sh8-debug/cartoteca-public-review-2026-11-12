const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isAffirmativeAnswer,
  isConfirmationAnswer,
} = require('../src/server/modules/assistant/dialogue/affirmative-answer.cjs');
const { cancellationFixture } = require('./helpers/assistant-cancellation-fixture.cjs');
for (const phrase of ['Да!!', 'Ага!?', 'Верно!!'])
  test('ASR terminal punctuation does not lose a whole affirmative: ' + phrase, () => {
    assert.equal(isAffirmativeAnswer(phrase), true);
    assert.equal(isConfirmationAnswer(phrase, 'cancel'), true);
  });
test('punctuated consent executes only after a bound cancellation question', async (t) => {
  const f = cancellationFixture(t);
  f.answer({ text: 'Да!!' });
  assert.equal(f.result.action?.type, 'cancelAppointment');
  assert.equal(f.calls(), 0);
  await f.api.execute(f.c, f.body());
  assert.equal(f.row().status, 'cancelled');
  assert.equal(f.calls(), 1);
});
test('punctuation does not hide negative or added conditions', () => {
  for (const phrase of ['Да, не отменяй…', 'Верно, но завтра!!', 'Да или нет…', 'Да…', 'Да...'])
    assert.equal(isConfirmationAnswer(phrase, 'cancel'), false);
});
