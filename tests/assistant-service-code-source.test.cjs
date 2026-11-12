const test = require('node:test');
const assert = require('node:assert/strict');
const { entityText, initialEntities } = require('../src/server/modules/assistant/interpretation/entity-provenance.cjs');
const { expandServiceSource } = require('../src/server/modules/assistant/language/services/service-source.cjs');

const literal = 'пилинг PeriX';
test('a literal service locator retains adjacent raw codes and signed decimal or percent qualifiers', () => {
  for (const [raw, expected] of [
    ['Запиши на пилинг PeriX T134 завтра в12:30.', 'пилинг PeriX T134'],
    ['Запиши на T134 пилинг PeriX завтра.', 'T134 пилинг PeriX'],
    ['Запиши на PRX-T134 пилинг PeriX.', 'PRX-T134 пилинг PeriX'],
    ['Запиши на пилинг PeriX PRX-T134.', 'пилинг PeriX PRX-T134'],
    ['Запиши на пилинг PeriX −1,5.', 'пилинг PeriX −1,5'],
    ['Запиши на пилинг PeriX +1.5.', 'пилинг PeriX +1.5'],
    ['Запиши на 30% пилинг PeriX.', '30% пилинг PeriX'],
    ['Запиши на пилинг PeriX 30%.', 'пилинг PeriX 30%'],
    ['Запиши на пилинг PeriX T134 30%.', 'пилинг PeriX T134 30%'],
  ]) assert.equal(entityText(raw, literal, 'service'), expected, raw);
});

test('service expansion stops before explicit dates, clocks, duration units and surrounding command context', () => {
  for (const raw of [
    'Запиши на пилинг PeriX завтра в12:30.',
    'Запиши на пилинг PeriX на20октября.',
    'Запиши на пилинг PeriX на 20 октября.',
    'Запиши на пилинг PeriX 20 октября.',
    'Запиши на пилинг PeriX 20октября.',
    'Запиши на пилинг PeriX 12:30.',
    'Запиши на пилинг PeriX в12:30.',
    'Запиши на пилинг PeriX на45минут.',
    'Запиши на пилинг PeriX на20 октября.',
    'Запиши на пилинг PeriX 2099-01-05.',
    'Запиши на пилинг PeriX 20.10.2099.',
    'Запиши на пилинг PeriX 45 минут.',
    'Запиши Анну Семёнову завтра в12:30 на пилинг PeriX.',
  ]) assert.equal(entityText(raw, literal, 'service'), literal, raw);
});

test('contextual dashed clocks remain outside the service span in either field order', () => {
  for (const clock of ['в12-30', 'в 12-30', 'к12–30', 'ко 12—30', 'на12-30', 'на 12-05']) {
    for (const raw of [
      'Запиши Анну завтра на пилинг PeriX ' + clock + '.',
      'Запиши Анну завтра ' + clock + ' на пилинг PeriX.',
      'Запиши Анну завтра ' + clock + ' пилинг PeriX.',
    ]) assert.equal(entityText(raw, literal, 'service'), literal, raw);
  }
  for (const token of ['в24-30', 'в12-60', 'в12-30-20', 'на12-05', '12-30', 'T12-30']) {
    const raw = 'Запиши на пилинг PeriX ' + token + '.';
    assert.equal(entityText(raw, literal, 'service'), token === 'T12-30' ? literal + ' ' + token : '', raw);
  }
});

test('ambiguous bare numbers and excessive adjacent qualifiers cannot degrade back to the short literal', () => {
  for (const raw of [
    'Запиши на пилинг PeriX 134.',
    'Запиши на 134 пилинг PeriX.',
    'Запиши на пилинг PeriX T134 A2 B3.',
    'Запиши на T134 A2 B3 пилинг PeriX.',
    'Запиши на пилинг PeriX зона2.',
    'Запиши на пилинг PeriX на134.',
    'Запиши на пилинг PeriX на20зона2.',
  ]) assert.equal(entityText(raw, literal, 'service'), '', raw);
});

test('expanded spans keep existing negation and alternative guards and retain only a positive correction', () => {
  for (const raw of [
    'Запиши не на пилинг PeriX T134.',
    'Запиши не T134 пилинг PeriX.',
    'Запиши на пилинг PeriX T134 или консультацию.',
    'Запиши на пилинг PeriX T134 или пилинг PeriX T133.',
  ]) assert.equal(entityText(raw, literal, 'service'), '', raw);
  assert.equal(entityText('Не пилинг PeriX T133, а пилинг PeriX T134.', literal, 'service'), 'пилинг PeriX T134');
  assert.equal(entityText('пилинг PeriX T133 и пилинг PeriX T134', literal, 'service'), '');
});

test('a canonical model code is discarded while the literal raw brand and adjacent actual code survive', () => {
  for (const [proposal, raw, expected] of [
    ['Пилинг PRX-T133', 'Запиши на пилинг PeriX.', 'пилинг PeriX'],
    ['пилинг PeriX T133', 'Запиши на пилинг PeriX T134.', 'пилинг PeriX T134'],
    ['пилинг PeriX 30%', 'Запиши на пилинг PeriX 20%.', 'пилинг PeriX 20%'],
  ]) assert.equal(entityText(raw, proposal, 'service'), expected, raw);
});

test('preserving a raw service code leaves the other source-proven booking fields unchanged', () => {
  const raw = 'Запиши Анну Семёнову завтра в12:30 на пилинг PeriX T134 на45 минут.';
  const result = initialEntities({ intent: 'prepareAppointment', query: 'Анна Семёнова',
    serviceQuery: literal, date: '2099-01-05', time: '12:30', duration: 45 }, raw,
  { date: '2099-01-05', time: '12:30', duration: 45 });
  assert.equal(result.query, 'Анну Семёнову'); assert.equal(result.serviceQuery, 'пилинг PeriX T134');
  assert.equal(result.date, '2099-01-05'); assert.equal(result.time, '12:30'); assert.equal(result.duration, 45);
});

test('source bounds and nonliteral complete-service proof remain strict', () => {
  assert.equal(expandServiceSource('x'.repeat(4097), literal), '');
  assert.equal(expandServiceSource(literal, 'x'.repeat(161)), '');
  assert.equal(expandServiceSource((literal + ' T134; ').repeat(9), literal), '');
  assert.equal(entityText('Запиши на пилинг1,5.', 'Пилинг1.5', 'service'), '');
  assert.equal(entityText('Запиши на миндалный пилинг.', 'Миндальный пилинг', 'service'), 'миндалный пилинг');
});

test('the existing complete nonliteral source proof also retains its immediately adjacent raw qualifier', () => {
  assert.equal(entityText('Запиши на миндалный пилинг T134.', 'Миндальный пилинг', 'service'), 'миндалный пилинг T134');
  assert.equal(entityText('Запиши на миндалный пилинг 30%.', 'Миндальный пилинг', 'service'), 'миндалный пилинг 30%');
  assert.equal(entityText('Не миндалный пилинг T134.', 'Миндальный пилинг', 'service'), '');
  assert.equal(entityText('Миндалный пилинг T134 или молочный пилинг.', 'Миндальный пилинг', 'service'), '');
  assert.equal(entityText('Запиши на миндалный пилинг завтра.', 'Миндальный пилинг', 'service'), 'миндалный пилинг');
});
test('full brand alias source proof preserves all raw words and codes before adjacent expansion', () => {
  for (const raw of ['пилинг PeriX', 'пилинг перикс', 'пилинг пи ар икс'])
    assert.equal(entityText('Запиши на ' + raw + ' завтра.', 'пилинг PRX', 'service'), raw);
  assert.equal(entityText('Запиши на пилинг PeriX-T33.', 'пилинг PRX-T33', 'service'), 'пилинг PeriX-T33');
  assert.equal(entityText('Запиши на пилинг PeriX T134.', 'пилинг PRX', 'service'), 'пилинг PeriX T134');
  for (const [proposal, raw] of [
    ['пилинг PRX-T33', 'пилинг PeriX'],
    ['пилинг PRX-T133', 'пилинг PeriX-T33'],
    ['пилинг PRX', 'PeriX'],
    ['массаж пилинг PRX', 'пилинг PeriX'],
  ]) assert.equal(entityText('Запиши на ' + raw + '.', proposal, 'service'), raw, raw);
  assert.equal(entityText('Не пилинг PeriX T134.', 'пилинг PRX', 'service'), '');
  assert.equal(entityText('пилинг PeriX T134 или консультация.', 'пилинг PRX', 'service'), '');
});
