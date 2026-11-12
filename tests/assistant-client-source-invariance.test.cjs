const test = require('node:test');
const assert = require('node:assert/strict');
const {
  expandClientSource,
} = require('../src/server/modules/assistant/language/names/client-source-span.cjs');
const {
  wholeIdentity,
} = require('../src/server/modules/assistant/actions/client-read-request.cjs');
const titles = ['массаж', 'пилинг', 'консультация', 'люменконтур', 'берилловый контур'];
const {
  initialEntities,
} = require('../src/server/modules/assistant/interpretation/entity-provenance.cjs');
const client = 'Никита Андреевич Соколов';
const staff = 'Нине Ветровой';

test('renaming a proven service never changes the full client span in either field order', () => {
  for (const serviceQuery of titles) {
    const proof = { serviceQuery, staffQuery: staff };
    for (const raw of [
      `${serviceQuery} ${client} ${staff} завтра`,
      `${staff} ${client} ${serviceQuery} завтра`,
      `${client}, ${serviceQuery}, ${staff}`,
      `Запиши ${client} на ${serviceQuery} к ${staff} завтра`,
    ])
      assert.equal(expandClientSource(raw, 'Никита', proof), client, raw);
  }
});

test('unproved leading or trailing procedure nouns cannot silently shorten a possible full name', () => {
  const name = 'Никита Соколов';
  for (const title of titles)
    for (const raw of [`${title} ${name}`, `${name} ${title}`]) {
      const actual = expandClientSource(raw, name);
      assert.notEqual(actual, name, raw);
      assert.ok(
        actual === raw || actual === '',
        'retain the complete raw candidate or abstain: ' + raw,
      );
      assert.equal(expandClientSource(raw, name, { serviceQuery: title }), name, raw);
    }
});

test('a literal surname matching a former procedure stop word remains part of the identity', () => {
  for (const surname of ['Массаж', 'Пилинг', 'Консультация', 'Люменконтур']) {
    const name = `Никита ${surname}`;
    assert.equal(expandClientSource(`Запиши ${name} завтра`, 'Никита'), name);
    assert.equal(wholeIdentity(name), name);
  }
});

test('catalog-independent name expansion retains bounded source and token limits', () => {
  for (const [raw, query] of [
    ['Никита Соколов Люменконтур Бериллий Аврора', 'Никита'],
    ['Никита ' + 'А'.repeat(4097), 'Никита'],
    ['Никита', 'А'.repeat(161)],
    ['А'.repeat(49), 'А'.repeat(49)],
    [Array(130).fill('Никита').join(' '), 'Никита'],
  ])
    assert.equal(expandClientSource(raw, query), '', raw.slice(0, 60));
});

test('the same surname used by a disjoint service occurrence cannot clip the client identity', () => {
  for (const raw of [
    'Запиши Никиту Соколова на Соколова',
    'Соколова, Никиту Соколова',
    'Никиту Соколова, Соколова',
  ]) {
    const source = expandClientSource(raw, 'Никиту Соколова', { serviceQuery: 'Соколова' });
    assert.equal(source, 'Никиту Соколова', raw);
    const intent = initialEntities(
      { intent: 'prepareAppointment', query: 'Никиту Соколова', serviceQuery: 'Соколова' },
      raw,
    );
    assert.equal(intent.query, 'Никиту Соколова', raw);
    assert.equal(intent.serviceQuery, 'Соколова', raw);
  }
});

test('disjoint staff-name occurrences protect their own span without consuming a client anchor', () => {
  for (const raw of ['Никита Соколов, специалист Никита', 'Специалист Никита, Никита Соколов'])
    assert.equal(
      expandClientSource(raw, 'Никита Соколов', { staffQuery: 'Никита' }),
      'Никита Соколов',
      raw,
    );
});

test('one overlapping source occurrence cannot prove two roles or return a truncated person', () => {
  assert.equal(expandClientSource('Никита Соколов', 'Никита Соколов', { serviceQuery: 'Соколов' }), '');
  assert.equal(
    expandClientSource('Никита Соколов', 'Никита Соколов', { staffQuery: 'Никита' }),
    '',
  );
});
