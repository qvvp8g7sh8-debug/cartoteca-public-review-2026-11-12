const test = require('node:test');
const assert = require('node:assert/strict');
const {
  relativeTemporalEvidence,
} = require('../src/server/modules/assistant/language/time/temporal-evidence.cjs');
const clock = Object.freeze({ date: '2026-10-16', hour: 9, minute: 0 });
const draft = Object.freeze({ date: '2026-10-20', time: '10:00', duration: 45 });
const proof = (text, data = draft, now = clock) => relativeTemporalEvidence(text, data, now);

test('relative clocks are computed only from the selected draft and an exact spoken offset', () => {
  for (const [text, time] of [
    ['Перенеси на полчаса позже', '10:30'],
    ['на 15 минут раньше', '09:45'],
    ['на15мин раньше', '09:45'],
    ['Передвинь время на час двадцать позднее', '11:20'],
    ['на четверть часа ранее', '09:45'],
    ['Сдвинь запись на 90 минут позже', '11:30'],
    ['Пожалуйста, перенеси на полчаса позже.', '10:30'],
  ])
    assert.deepEqual(proof(text), { time }, text);
});

test('relative clocks require a valid selected civil date and exact current clock value', () => {
  for (const data of [
    null,
    {},
    { time: '10:00' },
    { date: draft.date },
    { date: draft.date, time: '24:00' },
    { date: '2026-10-15', time: '10:00' },
    { date: '2026-02-30', time: '10:00' },
  ])
    assert.deepEqual(proof('на полчаса позже', data), {});
  for (const now of [null, {}, { date: '2026-02-30' }])
    assert.deepEqual(proof('на полчаса позже', draft, now), {});
});

test('a clock offset never crosses midnight or changes the date or appointment duration', () => {
  for (const [time, text] of [
    ['23:45', 'на полчаса позже'],
    ['00:15', 'на полчаса раньше'],
    ['10:00', 'на 24 часа позже'],
  ])
    assert.deepEqual(proof(text, { ...draft, time }), {}, text);
  assert.deepEqual(proof('на полчаса позже'), { time: '10:30' });
});

test('draft-relative days use the selected date and reject an absent basis or past result', () => {
  for (const [text, date] of [
    ['на следующий день', '2026-10-21'],
    ['Перенеси дату на предыдущий день', '2026-10-19'],
    ['на два дня позже', '2026-10-22'],
    ['днем раньше', '2026-10-19'],
    ['на 2дня раньше', '2026-10-18'],
  ])
    assert.deepEqual(proof(text), { date }, text);
  assert.deepEqual(proof('на следующий день', {}), {});
  assert.deepEqual(proof('на предыдущий день', { date: clock.date }), {});
});

test('explicit through-day expressions use the organization date rather than the selected draft', () => {
  for (const [text, date] of [
    ['через 2 дня', '2026-10-18'],
    ['через2дня', '2026-10-18'],
    ['Перенеси через два дня', '2026-10-18'],
    ['через день', '2026-10-17'],
    ['через неделю', '2026-10-23'],
    ['через двадцать один день', '2026-11-06'],
  ])
    assert.deepEqual(proof(text, {}), { date }, text);
});

test('civil date shifts handle leap days month and year boundaries without time-zone arithmetic', () => {
  assert.deepEqual(proof('на следующий день', { date: '2028-02-28' }, { date: '2028-02-28' }), {
    date: '2028-02-29',
  });
  assert.deepEqual(proof('на следующий день', { date: '2026-12-31' }), { date: '2027-01-01' });
  assert.deepEqual(proof('на следующий день', { date: '9999-12-31' }), {});
  assert.deepEqual(proof('через 32 дня'), {});
  assert.deepEqual(proof('на ноль дней позже'), {});
});

test('negation alternatives ranges vague offsets and secondary actions never prove a value', () => {
  for (const text of [
    'Не переноси на полчаса позже',
    'Нет, на полчаса позже',
    'на 15 или 30 минут позже',
    'на 15-30 минут позже',
    'на 15–30 минут позже',
    'примерно на полчаса позже',
    'если можно на полчаса позже',
    'на полчаса позже и сохрани',
    'на полчаса позже завтра',
    'позже',
    'на сколько-нибудь позже',
    'через 2 дня или через 3 дня',
    'на следующий день и в 12:30',
    'на один час шестьдесят минут позже',
    'на 15 секунд раньше',
    'на 15 позже',
  ])
    assert.deepEqual(proof(text), {}, text);
});

test('generic field cues and incompatible named fields do not prove model values', () => {
  for (const text of [
    'время уточню',
    'длительность уточню',
    'как обычно',
    'на 12 часов вечера',
    'время на следующий день',
    'дату на полчаса позже',
    '31 ноября',
    'в 12:30',
    'длительность на полчаса позже',
  ])
    assert.deepEqual(proof(text), {}, text);
});

test('evidence is pure bounded and independent of any proposed model value', () => {
  const data = Object.freeze({
    ...draft,
    patient: Object.freeze({ id: 'synthetic-client' }),
    service: Object.freeze({ id: 'synthetic-service' }),
  });
  const before = JSON.stringify(data);
  assert.deepEqual(proof('на полчаса позже', data), { time: '10:30' });
  assert.equal(JSON.stringify(data), before);
  for (const text of [null, 123, '', ' '.repeat(161), 'на полчаса позже\u0000'])
    assert.deepEqual(proof(text), {});
});
