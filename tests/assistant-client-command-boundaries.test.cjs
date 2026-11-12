const test = require('node:test');
const assert = require('node:assert/strict');
const { expandClientSource } = require('../src/server/modules/assistant/language/names/client-source-span.cjs');
const { initialEntities } = require('../src/server/modules/assistant/interpretation/entity-provenance.cjs');
const {
  nameSuggestionPlan,
  suggestionsOnlyQuery,
} = require('../src/server/modules/assistant/language/names/name-suggestions.cjs');

const reflexiveCommands = ['Запишись', 'Запишитесь', 'Записывайся', 'Записывайтесь', 'Записаться'];

test('reflexive booking commands remain outside the complete spoken client span for canonical and declined model locators', () => {
  for (const command of reflexiveCommands) {
    const raw = command + ' Сашу Иванова на сегодня на консультацию.';
    for (const query of ['Саша Иванов', 'Сашу Иванова', 'Сашу'])
      assert.equal(
        expandClientSource(raw, query, { serviceQuery: 'консультацию' }),
        'Сашу Иванова',
        command + ': ' + query,
      );
  }
});

test('a literal short given name and its spoken patronymic survive command isolation in both FIO orders', () => {
  for (const command of reflexiveCommands)
    for (const [name, queries] of [
      ['Сашу Олеговича Иванова', ['Саша Олегович Иванов', 'Сашу', 'Олеговича']],
      ['Иванова Сашу Олеговича', ['Иванов Саша Олегович', 'Сашу', 'Иванова']],
    ])
      for (const query of queries)
        assert.equal(
          expandClientSource(command + ' ' + name + ' на консультацию сегодня.', query, {
            serviceQuery: 'консультацию',
          }),
          name,
          command + ': ' + query,
        );
});

test('initial model locators preserve the entire raw nickname and all independently proven appointment fields', () => {
  const raw = 'Запишись Сашу Олеговича Иванова на сегодня на консультацию в 12:30.';
  const result = initialEntities(
    {
      intent: 'prepareAppointment',
      query: 'Саша Олегович Иванов',
      serviceQuery: 'Консультация',
      date: '2099-01-05',
      time: '12:30',
      duration: 45,
    },
    raw,
    { date: '2099-01-05', time: '12:30', duration: 45 },
  );
  assert.deepEqual(result, {
    intent: 'prepareAppointment',
    query: 'Сашу Олеговича Иванова',
    serviceQuery: 'консультацию',
    date: '2099-01-05',
    time: '12:30',
    duration: 45,
  });
});

test('command-word recognition is exact and does not discard similarly prefixed real surname tokens', () => {
  for (const surname of ['Запишина', 'Запискина', 'Записывальцева', 'Запишинского']) {
    const name = 'Сашу ' + surname;
    assert.equal(expandClientSource('Запиши ' + name + ' на сегодня.', 'Сашу'), name);
    assert.ok(nameSuggestionPlan(name).variants.length > 0, surname);
  }
});

test('a whole reflexive action is never a name candidate or a split-negative surname hypothesis', () => {
  for (const command of reflexiveCommands) {
    assert.deepEqual(nameSuggestionPlan(command).variants, [], command);
    assert.deepEqual(nameSuggestionPlan('Сашу ' + command).variants, [], command);
    assert.equal(suggestionsOnlyQuery('не ' + command), false, command);
  }
});

test('command isolation leaves negative conditional multiple-client and protected-staff source gates closed', () => {
  for (const raw of [
    'Запишись не Сашу Иванова на сегодня',
    'Запишитесь Сашу Иванова или Анну Семёнову на сегодня',
    'Записывайся Сашу Иванова и Анну Семёнову на сегодня',
    'Записаться если Сашу Иванова на сегодня',
  ])
    assert.equal(expandClientSource(raw, 'Сашу'), '', raw);
  assert.equal(
    expandClientSource('Записывайтесь Сашу Олеговича Иванова на сегодня', 'Сашу', {
      staffQuery: 'Сашу Олеговича Иванова',
    }),
    '',
  );
});
