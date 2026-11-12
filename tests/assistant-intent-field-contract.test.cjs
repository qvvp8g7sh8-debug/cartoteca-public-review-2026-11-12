const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseModelIntent,
  normalizeIntent,
} = require('../src/server/modules/assistant/interpretation/intents.cjs');
const { loadCatalog } = require('../src/server/modules/assistant/behavior/behavior-library.cjs');
const cases = [
  [
    'calendar must not silently discard a client filter',
    { intent: 'calendar', date: '2026-10-17', query: 'Анна Семёнова' },
  ],
  [
    'calendar must not silently discard a time filter',
    { intent: 'calendar', date: '2026-10-17', time: '14:30' },
  ],
  [
    'calendar must not silently discard requested duration',
    { intent: 'calendar', date: '2026-10-17', duration: 30 },
  ],
  [
    'calendar must not silently discard requested service',
    { intent: 'calendar', serviceQuery: 'Первичная консультация' },
  ],
  [
    'client search must not silently discard a specialist filter',
    { intent: 'clients', query: 'Анна Семёнова', staffQuery: 'Ирина Орлова' },
  ],
  [
    'client search must not silently discard a date filter',
    { intent: 'clients', query: 'Анна Семёнова', date: '2026-10-17' },
  ],
  [
    'client card must not silently discard an appointment time',
    { intent: 'clientCard', query: 'Анна Семёнова', time: '14:30' },
  ],
  [
    'client card must not silently discard a specialist filter',
    { intent: 'clientCard', query: 'Анна Семёнова', staffQuery: 'Ирина Орлова' },
  ],
  [
    'availability must not silently discard a client constraint',
    { intent: 'availability', date: '2026-10-17', query: 'Анна Семёнова' },
  ],
  [
    'availability must not accept calendar display mode',
    { intent: 'availability', date: '2026-10-17', mode: 'week' },
  ],
  [
    'one booking cannot silently become a range',
    {
      intent: 'prepareAppointment',
      query: 'Анна Семёнова',
      date: '2026-10-17',
      endDate: '2026-10-19',
    },
  ],
  [
    'one booking cannot accept calendar display mode',
    { intent: 'prepareAppointment', query: 'Анна Семёнова', mode: 'day' },
  ],
  [
    'help must not carry an executable interpretation of a named person',
    { intent: 'help', query: 'Анна Семёнова' },
  ],
];
for (const [title, value] of cases)
  test(title, () => {
    assert.throws(() => parseModelIntent(JSON.stringify(value)), { status: 502 });
  });
test('supported command conditions survive normalization without widening or dropping a filter', () => {
  for (const value of [
    { intent: 'calendar', date: '2026-10-17', mode: 'week', staffQuery: 'Ирина Орлова' },
    { intent: 'clients', query: 'Анна Семёнова' },
    { intent: 'clientCard', query: '+79990000001' },
    {
      intent: 'availability',
      date: '2026-10-17',
      endDate: '2026-10-19',
      time: '14:00',
      endTime: '17:00',
      staffQuery: 'Ирина Орлова',
      serviceQuery: 'Первичная консультация',
      duration: 30,
    },
    {
      intent: 'prepareAppointment',
      query: 'Анна Семёнова',
      date: '2026-10-17',
      time: '14:30',
      staffQuery: 'Ирина Орлова',
      serviceQuery: 'Первичная консультация',
      duration: 30,
    },
    { intent: 'help' },
  ])
    assert.deepEqual(normalizeIntent(value), value);
});
test('nullable constrained-provider envelope and every existing catalog command retain their meaning', () => {
  assert.deepEqual(
    normalizeIntent({
      intent: 'calendar',
      query: null,
      date: '2026-10-17',
      endDate: null,
      time: null,
      endTime: null,
      mode: 'day',
      staffQuery: null,
      serviceQuery: null,
      duration: null,
    }),
    { intent: 'calendar', date: '2026-10-17', mode: 'day' },
  );
  for (const item of loadCatalog().cases)
    if (item.current?.intent) {
      assert.deepEqual(normalizeIntent(item.current.intent), item.current.intent, item.id);
    }
});

test('historical saved examples remain readable while unsupported execution is rejected', () => {
  const historical = { intent: 'calendar', date: '2026-10-17', query: 'Анна Семёнова' };
  assert.deepEqual(normalizeIntent(historical), historical);
  assert.throws(() => parseModelIntent(JSON.stringify(historical)), { status: 502 });
});
