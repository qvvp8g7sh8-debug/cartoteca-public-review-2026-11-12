const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseModelIntent,
  normalizeIntent,
} = require('../src/server/modules/assistant/interpretation/intents.cjs');
for (const value of [
  null,
  [],
  true,
  7,
  'calendar',
  { intent: 'calendar', patientId: 'invented' },
  { intent: 'prepareAppointment', query: { name: 'Анна' } },
  { intent: 'clients', query: 'я'.repeat(161) },
])
  test(
    'malformed model response is a provider error without blaming saved settings: ' +
      JSON.stringify(value).slice(0, 80),
    () => {
      assert.throws(
        () => parseModelIntent(JSON.stringify(value)),
        (error) => error.status === 502 && !/настройк/iu.test(error.message),
      );
    },
  );
test('invalid JSON and unsupported actions remain rejected without leaking model content', () => {
  for (const value of [
    '{"intent":"calendar"} trailing',
    '{"intent":"deleteEverything"}',
    '{"intent":"clients","query":"\\u0000"}',
  ])
    assert.throws(() => parseModelIntent(value), { status: 502 });
});
test('historical setting validation keeps its existing client-error contract', () => {
  assert.throws(() => normalizeIntent({ intent: 'calendar', patientId: 'invented' }), {
    status: 400,
  });
  assert.deepEqual(parseModelIntent('{"intent":"calendar","date":"2026-10-18"}'), {
    intent: 'calendar',
    date: '2026-10-18',
  });
});
