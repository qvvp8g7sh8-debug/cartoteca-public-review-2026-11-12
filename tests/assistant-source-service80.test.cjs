const test = require('node:test');
const assert = require('node:assert/strict');
const {
  prepareManagementIntent,
  localManagementIntent,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-intent.cjs');
const { parseModelIntent } = require('../src/server/modules/assistant/interpretation/intents.cjs');
const { moveExecutionFixture } = require('./helpers/assistant-move-execution-fixture.cjs');
const clock = { date: '2099-01-05', hour: 8, minute: 0 };
for (const [intent, verb] of [
  ['cancelAppointment', 'Отмени'],
  ['moveAppointment', 'Перенеси'],
  ['editAppointment', 'Открой'],
]) {
  test(intent + ' represents a grounded source service and recovers a provider omission', () => {
    const raw = verb + ' запись Анны Семёновой на пилинг PRX';
    const parsed = parseModelIntent(
      JSON.stringify({ intent, query: 'Анны Семёновой', serviceQuery: 'пилинг PRX' }),
    );
    const result = prepareManagementIntent(parsed, raw, clock);
    assert.equal(result.intent.serviceQuery, 'пилинг PRX');
    assert.equal(result.intent.query, 'Анны Семёновой');
    assert.equal(localManagementIntent(raw, clock).serviceQuery, 'пилинг PRX');
    assert.equal(
      prepareManagementIntent({ intent, query: 'Анны Семёновой' }, raw, clock).intent.serviceQuery,
      'пилинг PRX',
    );
  });
}
test('a model cannot invent a source service, or use the filter as an edit', () => {
  assert.throws(
    () =>
      prepareManagementIntent(
        { intent: 'moveAppointment', query: 'Анны', serviceQuery: 'пилинг PRX' },
        'Перенеси запись Анны',
        clock,
      ),
    { status: 400 },
  );
  for (const raw of [
    'Перенеси запись Анны и поменяй услугу на пилинг PRX',
    'Измени услугу записи Анны на пилинг PRX',
    'Отмени запись Анны на пилинг PRX если завтра',
  ])
    assert.equal(localManagementIntent(raw, clock), null, raw);
  assert.throws(
    () => parseModelIntent(JSON.stringify({ intent: 'moveAppointment', duration: 60 })),
    { status: 502 },
  );
  for (const raw of [
    'Отмени запись Анны не на пилинг PRX',
    'Отмени запись Анны на пилинг PRX или консультацию',
    'Отмени запись Анны на пилинг PRX если завтра',
  ])
    assert.throws(
      () =>
        prepareManagementIntent(
          { intent: 'cancelAppointment', query: 'Анны', serviceQuery: 'пилинг PRX' },
          raw,
          clock,
        ),
      { status: 400 },
    );
});
test('the initial service filter selects only actual matching source appointments without changing or saving them', (t) => {
  const f = moveExecutionFixture(t, {
    beforeStart(f) {
      f.addBooking({
        service: 'Пилинг PRX-T133',
        serviceItems: [],
        date: '2099-01-06',
        time: '16:00',
      });
    },
  });
  const before = structuredClone(f.rows());
  f.start({ serviceQuery: 'пилинг PRX' });
  assert.equal(f.entry().data.management.sourceServiceQuery, 'пилинг PRX');
  const source = f.rows().find((row) => row.id === f.entry().data.management.source.appointmentId);
  assert.equal(source.date, '2099-01-06');
  assert.equal(source.service, 'Пилинг PRX-T133');
  assert.deepEqual(f.rows(), before);
  assert.equal(f.calls(), 0);
});
