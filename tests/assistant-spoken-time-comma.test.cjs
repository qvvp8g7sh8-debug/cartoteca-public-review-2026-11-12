const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTimeText } = require('../src/server/modules/assistant/language/time/temporal.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');

test('ASR comma clocks accept one exact value or at most one identical repetition', () => {
  for (const [text, expected] of [
    ['14, 30', '14:30'],
    ['в 14,30.', '14:30'],
    ['14, 30, 14, 30', '14:30'],
    ['14,30,14,30!', '14:30'],
    ['13, 0', '13:00'],
    ['14, 05', '14:05'],
    ['14, 5, 14, 05', '14:05'],
    ['23, 59', '23:59'],
  ])
    assert.equal(parseTimeText(text), expected, text);
});

test('comma clocks use daytime defaults and explicit meridiem conversion', () => {
  for (const [text, expected] of [
    ['2, 30 дня', '14:30'],
    ['2, 30, 2, 30 дня', '14:30'],
    ['2, 30 утра', '02:30'],
    ['12, 00 ночи', '00:00'],
    ['0, 30', '00:30'],
    ['2, 30', '14:30'],
    ['2, 30, 2, 30', '14:30'],
    ['12, 30', '12:30'],
  ])
    assert.equal(parseTimeText(text), expected, text);
  for (const text of ['14, 30 утра']) assert.equal(parseTimeText(text), null, text);
});

test('comma clocks consume the whole input and reject conflict, extra values and uncertainty', () => {
  for (const text of [
    '14, 30, 14, 31',
    '14, 30, 15, 30',
    '14, 30, 14, 30, 14, 30',
    '14, 30, 15:00',
    '15:00, 14, 30',
    '14, 30 и 14, 30',
    '14, 30 или вечером',
    'примерно 14, 30',
    'не 14, 30',
    '14, 30, точнее в три часа дня',
    '14, 30 для другого клиента',
    '14, 60',
    '24, 00',
    '14, -5',
    '14, 300',
  ])
    assert.equal(parseTimeText(text), null, text);
});

test('an ASR repeated comma clock reaches review while conflicting clocks preserve data and never Save', () => {
  const f = dialogueFixture();
  const first = f.start({ query: 'Анну Семенову', serviceQuery: 'Чистка', date: day });
  assert.equal(first.dialogue.step, 'time');
  assert.throws(() => f.answer({ text: '14, 30, 15, 30' }), { status: 400 });
  assert.equal(f.result, first);
  assert.deepEqual(f.result.dialogue.fields, first.dialogue.fields);
  const review = f.answer({ text: '14, 30, 14, 30' }).result;
  assert.equal(review.dialogue.step, 'review');
  assert.equal(review.dialogue.id, first.dialogue.id);
  assert.equal(review.dialogue.version, first.dialogue.version + 1);
  assert.equal(review.dialogue.fields.find((row) => row.key === 'time').value, '14:30');
  assert.equal(review.action, null);
  assert.equal(f.patients[0].appointments.length, 0);
  const final = f.answer({ text: 'да' }).result;
  assert.equal(final.action.type, 'prepareAppointment');
  assert.equal(final.action.time, '14:30');
  assert.equal(f.patients[0].appointments.length, 0);
});
