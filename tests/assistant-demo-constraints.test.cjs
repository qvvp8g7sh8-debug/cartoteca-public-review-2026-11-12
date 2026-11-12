const test = require('node:test');
const assert = require('node:assert/strict');
const { demoIntent } = require('../src/server/modules/assistant/interpretation/demo-intents.cjs');
const {
  bookingTemporalConstraints,
} = require('../src/server/modules/assistant/language/time/booking-temporal-constraints.cjs');
const clock = { date: '2026-10-16', hour: 10, minute: 0 };
test('demo booking uses the same exact spoken duration as request constraints', () => {
  assert.equal(demoIntent('Запиши Анну Семёнову завтра на тридцать минут.', clock).duration, 30);
  assert.equal(
    demoIntent('Запиши Анну Семёнову завтра длительностью один час тридцать минут.', clock)
      .duration,
    90,
  );
  const datedClock = 'Запиши Анну Семёнову завтра на один час тридцать минут.';
  assert.equal(demoIntent(datedClock, clock).duration, undefined);
  assert.equal(
    bookingTemporalConstraints({ intent: 'prepareAppointment' }, datedClock, clock).time,
    '13:30',
  );
});
test('demo booking preserves a draft for invalid numeric durations rather than failing model decoding', () => {
  for (const duration of [0, 7, 22, 1500]) {
    const intent = demoIntent('Запиши Анну Семёнову завтра на ' + duration + ' минут.', clock);
    assert.equal(intent.intent, 'prepareAppointment');
    assert.equal(intent.duration, undefined);
  }
});
test('demo readonly availability recognizes exact spoken and abbreviated duration', () => {
  assert.equal(demoIntent('Найди свободное окно завтра по тридцать минут.', clock).duration, 30);
  assert.equal(demoIntent('Найди свободное окно завтра на 45 мин.', clock).duration, 45);
});
test('demo readonly availability refuses an unsupported explicit duration', () => {
  assert.deepEqual(demoIntent('Найди свободное окно завтра на семь минут.', clock), {
    intent: 'help',
  });
});
test('one booking plus finding its time remains prepareAppointment in demo mode', () => {
  const intent = demoIntent(
    'Подготовь запись Анне Семёновой на завтра на 15 минут. Подбери свободное время.',
    clock,
  );
  assert.equal(intent.intent, 'prepareAppointment');
  assert.equal(intent.date, '2026-10-17');
  assert.equal(intent.duration, 15);
  assert.equal(intent.time, undefined);
  assert.match(intent.query, /Анне Семёновой/);
});
test('ordinary readonly search, calendar and negative commands retain their intent', () => {
  assert.equal(demoIntent('Найди клиента Анну Семёнову', clock).intent, 'clients');
  assert.equal(demoIntent('Открой календарь на завтра', clock).intent, 'calendar');
  assert.equal(demoIntent('Не записывай Анну Семёнову', clock).intent, 'help');
});
