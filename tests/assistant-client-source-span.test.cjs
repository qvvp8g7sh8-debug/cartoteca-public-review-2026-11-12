const test = require('node:test');
const assert = require('node:assert/strict');
const { expandClientSource } = require('../src/server/modules/assistant/language/names/client-source-span.cjs');

test('a proved given-name fragment preserves the complete adjacent raw surname instead of authorizing a shorter identity', () => {
  for (const query of ['Артема', 'Макартичана', 'Артема Макартичана'])
    assert.equal(
      expandClientSource('Запиши Артема Макартичана, на завтра на12-30 консультаций.', query, {
        serviceQuery: 'консультаций',
      }),
      'Артема Макартичана',
    );
  assert.equal(
    expandClientSource('Запиши на завтра АрТёМа Макартичана на консультацию.', 'артема', {
      serviceQuery: 'консультацию',
    }),
    'АрТёМа Макартичана',
  );
});

test('both FIO orders and patronymics expand up to four original tokens without reordering or spelling repair', () => {
  for (const [raw, query, expected] of [
    ['Запиши Макартичана Артема на завтра', 'Артема', 'Макартичана Артема'],
    ['Запиши Макартичана Артема Ивановича на завтра', 'Артема', 'Макартичана Артема Ивановича'],
    ['Запиши Артема Ивановича Макартичана на завтра', 'Ивановича', 'Артема Ивановича Макартичана'],
    ['Запиши Анна Мария Тер-Петросян на завтра', 'Мария', 'Анна Мария Тер-Петросян'],
    ['Запиши Жан-Пьера Д’Артаньяна на завтра', 'Жан-Пьера', 'Жан-Пьера Д’Артаньяна'],
  ])
    assert.equal(expandClientSource(raw, query), expected, raw);
});

test('spoken commas between name components stay in the source while sentence and clause boundaries are not crossed', () => {
  assert.equal(
    expandClientSource('Запиши Артема, Макартичана, на завтра.', 'Артема'),
    'Артема, Макартичана',
  );
  assert.equal(expandClientSource('Запиши Артема; Макартичана на завтра', 'Артема'), 'Артема');
  assert.equal(expandClientSource('Запиши Артема. Макартичана на завтра', 'Артема'), 'Артема');
  assert.equal(expandClientSource('Запиши Артема\nМакартичана на завтра', 'Артема'), 'Артема');
});

test('proved service and staff spans stop expansion regardless of field order or missing prepositions', () => {
  const spans = {
    serviceQuery: 'Миндальный пилинг',
    staffQuery: 'Ирине Орловой',
  };
  for (const raw of [
    'Миндальный пилинг Артема Макартичана Ирине Орловой завтра',
    'Ирине Орловой Артема Макартичана Миндальный пилинг завтра',
    'Артема Макартичана, Миндальный пилинг, Ирине Орловой',
  ])
    assert.equal(expandClientSource(raw, 'Артема', spans), 'Артема Макартичана', raw);
  assert.equal(expandClientSource('Ирине Орловой завтра', 'Ирине', spans), '');
});

test('prepositions temporal words and courtesy or pronouns are boundaries instead of client name additions', () => {
  for (const raw of [
    'Пожалуйста запиши мне Артема Макартичана на завтра',
    'Давайте его Артема Макартичана в12:30',
    'Это Артема Макартичана завтра на консультацию',
    'Запиши Артема Макартичана двадцать первого октября',
    'Запиши Артема Макартичана в среду',
    'Запиши Артема Макартичана на час',
  ])
    assert.equal(expandClientSource(raw, 'Артема'), 'Артема Макартичана', raw);
});

test('negated alternative or multiple client spans fail closed instead of returning a shorter proved given name', () => {
  for (const raw of [
    'не Артема Макартичана',
    'Артема не Макартичана',
    'Артема или Анну',
    'Артема Макартичана и Анну Семенову',
    'Артема Макартичана, но не Анну',
    'Артема Макартичана или Артема Семенова',
    'Артема Макартичана на завтра, Артема Семенова на послезавтра',
  ])
    assert.equal(expandClientSource(raw, 'Артема'), '', raw);
  assert.equal(
    expandClientSource('не Анну а Артема Макартичана на завтра', 'Артема'),
    'Артема Макартичана',
  );
  assert.equal(
    expandClientSource('Артема Макартичана и на завтра', 'Артема'),
    'Артема Макартичана',
  );
});

test('more than four neighboring FIO tokens or different source candidates are never silently truncated', () => {
  assert.equal(
    expandClientSource('Запиши Артема Ивановича Макартичана Павла Семенова на завтра', 'Артема'),
    '',
  );
  assert.equal(expandClientSource('Артема Макартичана на завтра Артема Семенова', 'Артема'), '');
  assert.equal(
    expandClientSource('Запиши Артема Макартичана на завтра', 'Артем'),
    'Артема Макартичана',
  );
  assert.equal(
    expandClientSource('Запиши Артема Макартичана на завтра', 'Артема Семенова'),
    'Артема Макартичана',
  );
});

test('a source joined name remains literal and a proved phone is not expanded into nearby person or appointment fields', () => {
  assert.equal(
    expandClientSource('Запиши АртемаМакартичана на завтра', 'АртемаМакартичана'),
    'АртемаМакартичана',
  );
  assert.equal(
    expandClientSource('Запиши АртемаМакартичана на завтра', 'Артема Макартичана'),
    'АртемаМакартичана',
  );
  assert.equal(
    expandClientSource('Запиши Артема +7 (999)123-45-67 на завтра', '+7 (999)123-45-67'),
    '+7 (999)123-45-67',
  );
});

test('invalid types oversized input and token overflow fail closed without scanning unbounded text', () => {
  for (const [raw, query] of [
    [null, 'Артема'],
    ['Артема', null],
    ['Артема', ''],
    ['Артема', 'А'.repeat(161)],
    ['А'.repeat(4097), 'Артема'],
    [Array(130).fill('Артема').join(' '), 'Артема'],
    ['А'.repeat(49), 'А'.repeat(49)],
  ])
    assert.equal(expandClientSource(raw, query), '');
});

test('canonical model spelling only locates a declared given-name form and returns the entire original spoken client span', () => {
  for (const [raw, query, expected] of [
    ['Запиши Артема Макартичана на завтра', 'Артём Мкртычян', 'Артема Макартичана'],
    ['Запиши Макартичана Артема на завтра', 'Артём Мкртычян', 'Макартичана Артема'],
    ['Запиши АртемаМакартичана на завтра', 'АртёмМкртычян', 'АртемаМакартичана'],
    ['Запиши МакартичанаАртема на завтра', 'Мкртычян Артём', 'МакартичанаАртема'],
    ['Запиши Юлю Неполину на завтра', 'Юлия Неволина', 'Юлю Неполину'],
  ])
    assert.equal(expandClientSource(raw, query), expected, raw);
  assert.equal(expandClientSource('Запиши Артема Макартичана на завтра', 'Артур Мкртчян'), '');
  assert.equal(expandClientSource('Запиши неизвестное имя на завтра', 'Артём Мкртычян'), '');
  assert.equal(expandClientSource('не Артема Макартичана', 'Артём Мкртычян'), '');
  assert.equal(
    expandClientSource('Артема Макартичана на завтра Артема Семенова', 'Артём Мкртычян'),
    '',
  );
});

test('canonical fallback cannot use a proposed phone absent from the source or search a protected staff instead of a client', () => {
  assert.equal(expandClientSource('Запиши Артема на завтра', '+79991234567'), '');
  assert.equal(
    expandClientSource('Артема Макартичана на завтра', 'Артём Мкртычян', {
      staffQuery: 'Артема Макартичана',
    }),
    '',
  );
});

test('a partial given-name anchor never shortens a hyphenated or apostrophe compound name', () => {
  for (const name of ['Анна-Мария', 'Анна—Мария', 'Анна’Мария']) {
    assert.equal(expandClientSource('Запиши ' + name + ' на завтра', 'Анна'), '');
    assert.equal(expandClientSource('Запиши ' + name + ' на завтра', name), name);
  }
});

test('calendar-unit prefixes and the client preposition remain outside the complete name in either field order', () => {
  for (const prefix of [
    '5 января 2099 года',
    '5 января 2099 год',
    'в 2099 году',
    'через 10 лет',
    'на следующей неделе',
    'в следующем месяце',
    'через десять дней',
    'к следующему дню',
  ]) {
    const raw = 'Запиши ' + prefix + ' Анну Семёнову на консультацию первичную в12:30';
    assert.equal(
      expandClientSource(raw, 'Анну', { serviceQuery: 'консультацию первичную' }),
      'Анну Семёнову',
      prefix,
    );
    assert.equal(
      expandClientSource('Запиши Анну Семёнову ' + prefix, 'Анну'),
      'Анну Семёнову',
      prefix,
    );
  }
  assert.equal(
    expandClientSource('Для Анны Семёновой на завтра консультацию', 'Анны', {
      serviceQuery: 'консультацию',
    }),
    'Анны Семёновой',
  );
});
