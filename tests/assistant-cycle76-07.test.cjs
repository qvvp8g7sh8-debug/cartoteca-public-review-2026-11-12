const test = require('node:test');
const assert = require('node:assert/strict');
const {
  prepareManagementIntent,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-intent.cjs');
const { modelPayload } = require('../src/server/modules/assistant/interpretation/intents.cjs');
const { initialState } = require('../src/server/modules/assistant/access/defaults.cjs');
const clock = { date: '2099-01-05', hour: 8, minute: 0 };
for (const phrase of ['к Марии', 'к специалисту Марии', 'ко врачу Марии'])
  test(
    'a model proposal cannot reinterpret a replacement staff as the source filter: ' + phrase,
    () => {
      assert.throws(
        () =>
          prepareManagementIntent(
            { intent: 'moveAppointment', query: 'Анны', staffQuery: 'Марии' },
            'Перенеси запись Анны ' + phrase + ' на завтра',
            clock,
          ),
        /Сменить сотрудника/u,
      );
    },
  );
test('an explicit source employee remains an applicable management filter', () => {
  const { intent } = prepareManagementIntent(
    { intent: 'moveAppointment', query: 'Анны', staffQuery: 'Марии' },
    'Перенеси запись Анны у Марии на завтра',
    clock,
  );
  assert.equal(intent.staffQuery, 'Марии');
  assert.equal(intent.date, '2099-01-06');
});
test('instructions define source staff and do not claim a cross-staff executor exists', () => {
  const state = initialState();
  const system = modelPayload('Перенеси запись Анны к Марии на завтра', state, 'Europe/Moscow')
    .payload.messages[0].content;
  assert.match(system, /staffQuery — только фильтр сотрудника ИСХОДНОЙ/u);
  assert.match(system, /автоматический перенос между сотрудниками не поддержан/u);
  assert.match(system, /не нового исполнителя/u);
});
test('the same first name of a client and staff cannot hide the destination preposition', () => {
  assert.throws(
    () =>
      prepareManagementIntent(
        { intent: 'moveAppointment', query: 'Марии', staffQuery: 'Марии' },
        'Перенеси запись Марии к Марии на завтра',
        clock,
      ),
    /Сменить сотрудника/u,
  );
});
