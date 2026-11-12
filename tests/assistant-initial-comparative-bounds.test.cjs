const test = require('node:test');
const assert = require('node:assert/strict');
const {
  initialTemporalConstraints,
} = require('../src/server/modules/assistant/language/time/initial-temporal-constraints.cjs');
const clock = { date: '2026-10-16', hour: 10, minute: 0 };
const select = (text) =>
  initialTemporalConstraints(
    { intent: 'prepareAppointment', date: '2026-10-18', time: '14:30' },
    text,
    clock,
  );

test('comparative date and clock bounds cannot become an exact appointment start', () => {
  for (const text of [
    'Запиши Анну завтра позднее 14:30.',
    'Запиши Анну завтра ранее 14:30.',
    'Запиши Анну позднее 18 октября.',
    'Запиши Анну ранее 18 октября.',
  ])
    assert.throws(() => select(text), { status: 400 }, text);
});

test('negated comparative bounds with optional than or clock prepositions still require a concrete start', () => {
  for (const text of [
    'Запиши Анну завтра не позднее 14:30.',
    'Запиши Анну завтра не ранее чем в 14:30.',
    'Запиши Анну не позднее чем на 18 октября.',
    'Запиши Анну не ранее 18.10.2026.',
  ])
    assert.throws(() => select(text), { status: 400 }, text);
});

test('a final exact correction retracts the matching comparative bound but changing another field cannot retract it', () => {
  assert.deepEqual(select('Запиши Анну завтра позднее 14:30, нет, в 15:00.'), {
    date: '2026-10-17',
    time: '15:00',
  });
  assert.deepEqual(select('Запиши Анну не ранее 18 октября, точнее 19 октября в 14:30.'), {
    date: '2026-10-19',
    time: '14:30',
  });
  assert.throws(() => select('Запиши Анну завтра позднее 14:30, точнее услуга чистка.'), {
    status: 400,
  });
  assert.throws(() => select('Запиши Анну не ранее 18 октября, точнее в 15:00.'), { status: 400 });
});
