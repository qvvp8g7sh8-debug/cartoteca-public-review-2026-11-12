const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDateText,
  parseTimeText,
  calendarContext,
} = require('../src/server/modules/assistant/language/time/temporal.cjs');
const {
  normalizeIntent,
  commandCategory,
} = require('../src/server/modules/assistant/interpretation/intent-schema.cjs');
const { demoIntent } = require('../src/server/modules/assistant/interpretation/intents.cjs');
const clock = { date: '2026-10-15', hour: 10, minute: 30 };
test('calendar periods use Monday and month boundaries including year changes', () => {
  assert.deepEqual(calendarContext('Покажи эту неделю', clock), {
    date: '2026-10-12',
    mode: 'week',
  });
  assert.deepEqual(calendarContext('Следующая неделя', clock), {
    date: '2026-10-19',
    mode: 'week',
  });
  assert.deepEqual(calendarContext('Прошлый месяц', clock), { date: '2026-09-01', mode: 'month' });
  assert.deepEqual(calendarContext('Следующий месяц', { date: '2026-12-31' }), {
    date: '2027-01-01',
    mode: 'month',
  });
});
test('clarification dates are explicit or relative to the organization clock', () => {
  assert.equal(parseDateText('завтра', { date: '2026-12-31' }), '2027-01-01');
  assert.equal(parseDateText('в пятницу', clock), '2026-10-16');
  assert.equal(parseDateText('в следующую пятницу', clock), '2026-10-16');
  assert.equal(parseDateText('20 октября 2026', clock), '2026-10-20');
  assert.equal(parseDateText('20.10.2026', clock), '2026-10-20');
  for (const value of [
    'пятого',
    '2026-02-30',
    'не завтра',
    'в понедельник 2026-10-20',
  ])
    assert.equal(parseDateText(value, clock), null, value);
});
test('clarification uses daytime hours while rejecting dates negation and multiple times', () => {
  assert.equal(parseTimeText('14:30'), '14:30');
  assert.equal(parseTimeText('в 3 часа дня'), '15:00');
  assert.equal(parseTimeText('в три'), '15:00');
  assert.equal(parseTimeText('в 3'), '15:00');
  assert.equal(parseTimeText('полночь'), '00:00');
  assert.equal(parseTimeText('в 14.30'), '14:30');
  for (const value of ['после обеда', '15.10.2026', '2026-10-20', 'не в 14:30', '14:30 или 15:00'])
    assert.equal(parseTimeText(value), null, value);
});
test('bounded schema admits new read capabilities without arbitrary identities or actions', () => {
  assert.deepEqual(normalizeIntent({ intent: 'calendar', mode: 'month', date: '2026-10-01' }), {
    intent: 'calendar',
    date: '2026-10-01',
    mode: 'month',
  });
  assert.equal(commandCategory('availability'), 'calendar');
  assert.equal(commandCategory('clientCard'), 'clients');
  assert.equal(commandCategory('help'), null);
  for (const value of [
    { intent: 'calendar', mode: 'year' },
    { intent: 'clients', mode: 'week' },
    { intent: 'clientCard', patientId: 'invented' },
    { intent: 'availability', date: '2026-10-20', endDate: '2026-10-19' },
  ])
    assert.throws(() => normalizeIntent(value));
});
test('demo can request week, month, a client card and bounded windows without implying a save', () => {
  assert.deepEqual(demoIntent('Покажи расписание на следующую неделю', clock), {
    intent: 'calendar',
    date: '2026-10-19',
    mode: 'week',
  });
  assert.deepEqual(demoIntent('Открой календарь на следующий месяц', clock), {
    intent: 'calendar',
    date: '2026-11-01',
    mode: 'month',
  });
  assert.deepEqual(demoIntent('Открой карточку Анны Ивановой', clock), {
    intent: 'clientCard',
    query: 'Анны Ивановой',
  });
  const slots = demoIntent('Найди свободное окно на завтра на 30 минут', clock);
  assert.equal(slots.intent, 'availability');
  assert.equal(slots.date, '2026-10-16');
  assert.equal(slots.duration, 30);
  assert.deepEqual(demoIntent('Не записывай Анну Иванову', clock), { intent: 'help' });
  assert.equal(demoIntent('Запиши Анну Иванову', clock).date, undefined);
});
test('clarification rejects alternative or approximate dates and conflicting relative context', () => {
  for (const text of [
    '20.10.2026 или 21.10.2026',
    '2026-10-20 или завтра',
    '20 октября 2026 или в пятницу',
    'примерно 20.10.2026',
    'около 2026-10-20',
    'завтра, 20.10.2026',
    'сегодня или завтра',
  ])
    assert.equal(parseDateText(text, clock), null, text);
  assert.equal(parseDateText('завтра, 16.10.2026', clock), '2026-10-16');
});
test('clarification does not accept a precise fragment within alternative or approximate times', () => {
  for (const text of [
    '14:30 или вечером',
    '14:30 либо утром',
    'примерно в 14:30',
    'около 14:30',
    'между 14:30 и вечером',
    'полдень или вечером',
    'около полудня',
    'в 14 часов или вечером',
  ])
    assert.equal(parseTimeText(text), null, text);
});
test('explicit named months open a month while an explicit named day remains a day', () => {
  assert.deepEqual(calendarContext('Покажи календарь за октябрь 2026 года', clock), {
    date: '2026-10-01',
    mode: 'month',
  });
  assert.deepEqual(calendarContext('Открой календарь за февраль 2028 года', clock), {
    date: '2028-02-01',
    mode: 'month',
  });
  assert.deepEqual(calendarContext('Открой календарь на 20 октября 2026 года', clock), {
    date: '2026-10-20',
    mode: 'day',
  });
});
test('invalid explicit days cannot degrade to a month-only calendar action', () => {
  for (const text of [
    'Покажи календарь на 31 ноября 2026 года',
    'Открой календарь на 29 февраля 2027 года',
  ])
    assert.deepEqual(demoIntent(text, clock), { intent: 'help' }, text);
});
test('intent calendar dates start at year one, including availability end boundaries', () => {
  assert.throws(() => normalizeIntent({ intent: 'calendar', date: '0000-01-01' }));
  assert.throws(() =>
    normalizeIntent({ intent: 'availability', date: '0000-01-01', endDate: '0001-01-01' }),
  );
  assert.deepEqual(calendarContext('Следующий месяц', { date: '0099-12-15' }), {
    date: '0100-01-01',
    mode: 'month',
  });
});
