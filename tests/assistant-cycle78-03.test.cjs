const test = require('node:test');
const assert = require('node:assert/strict');
const { moveExecutionFixture, day } = require('./helpers/assistant-move-execution-fixture.cjs');
const {
  filterSourceAppointments,
} = require('../src/server/modules/assistant/actions/appointments/appointment-source-selection.cjs');
test('a short brand filters real existing appointments and cancellation still requires consent', (t) => {
  const f = moveExecutionFixture(t, {
    targetTime: null,
    beforeStart(f) {
      f.mutate((next) => {
        const row = next.patients[0].appointments[0];
        row.service = 'Пилинг PRX-T133';
        row.serviceItems = [
          { id: 'prx', name: row.service, duration: 30, price: 100, category: 'other' },
        ];
      });
      f.addBooking({
        date: day,
        time: '15:00',
        service: 'Чистка',
        serviceItems: [
          { id: 'clean', name: 'Чистка', duration: 30, price: 100, category: 'other' },
        ],
      });
    },
  });
  f.start({ intent: 'cancelAppointment', date: null, time: null });
  f.answer({ text: 'пилинг PRX' });
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  assert.equal(f.entry().data.management.source.appointmentId, f.rows()[0].id);
  assert.equal(f.result.action, null);
  assert.equal(f.calls(), 0);
});
test('a shortened brand cannot pick between different product codes', () => {
  const rows = [
    { id: 'a', service: 'Пилинг PRX-T133' },
    { id: 'b', service: 'Пилинг PRX-T33' },
  ];
  assert.deepEqual(
    filterSourceAppointments(rows, { sourceServiceQuery: 'PRX' }, {}).map((r) => r.id),
    ['a', 'b'],
  );
  assert.deepEqual(filterSourceAppointments(rows, { sourceServiceQuery: 'PRX-T999' }, {}), []);
});
test('source service descriptions keep all additive treatment areas', () => {
  const rows = [
    { id: 'a', service: 'RF лифтинг лицо плюс шея' },
    { id: 'b', service: 'RF лифтинг лицо плюс шея плюс декольте' },
  ];
  assert.deepEqual(
    filterSourceAppointments(rows, { sourceServiceQuery: 'лифтинг лицо плюс шея' }, {}).map(
      (r) => r.id,
    ),
    ['a'],
  );
});
