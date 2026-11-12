const test = require('node:test');
const assert = require('node:assert/strict');
const { serviceMatches } = require('../src/server/modules/assistant/language/services/service-matching.cjs');
const { resolveService } = require('../src/server/modules/assistant/actions/availability-context.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');

test('numeric service qualifiers retain complete chunks while their adjacent words may decline', () => {
  for (const [name, query] of [
    ['Пилинг1.5', 'пилинга1.5'],
    ['Пилинг1,5', 'пилингу1,5'],
    ['1 зона 2 этап', '1 зоны 2 этапа'],
    ['Зона1 этап2', 'зоны1 этапа2'],
    ['Первичная консультация2', 'первичную консультацию2'],
    ['Пилинг20%', 'пилинга20%'],
    ['Пилинг1-5', 'пилинга1-5'],
    ['RF2.0', 'rf2.0'],
    ['Уход01', 'ухода01'],
  ])
    assert.equal(serviceMatches(name, query), true, name + ' ← ' + query);
});

test('decimal parts cannot be reversed split or exchanged with a different literal numeric chunk', () => {
  for (const [name, query] of [
    ['Пилинг1.5', 'пилинга5,1'],
    ['Пилинг1.5', 'пилинга5.1'],
    ['Пилинг1.5', 'пилинга1,5'],
    ['Пилинг1.5', 'пилинга1 5'],
    ['Пилинг01', 'пилинга1'],
    ['Пилинг20%', 'пилинга20'],
    ['Пилинг+1', 'пилинга1'],
    ['Пилинг−1', 'пилинга+1'],
    ['Пилинг1-5', 'пилинга5-1'],
    ['Пилинг1/2', 'пилинга2/1'],
    ['Пилинг12', 'пилинга1 2'],
    ['Пилинг2.0', 'пилинга2'],
  ])
    assert.equal(serviceMatches(name, query), false, name + ' ← ' + query);
});

test('numeric attachment cannot move between zone stage and other ordered qualifiers', () => {
  for (const [name, query] of [
    ['1 зона 2 этап', '2 зоны 1 этап'],
    ['1 зона 2 этап', '1 этап 2 зоны'],
    ['Зона1 этап2', 'зоны2 этапа1'],
    ['Зона1 этап2', '1 зоны 2 этапа'],
    ['1 зона 2 этап', '1 зоны этапа2'],
    ['1 зона 2 этап', '1 зоны'],
    ['Первичная консультация2', 'консультацию первичную2'],
    ['Пилинг1.5', 'пилинг'],
    ['Пилинг1.5', '1.5'],
  ])
    assert.equal(serviceMatches(name, query), false, name + ' ← ' + query);
});

test('numeric catalog resolution returns only the complete matching numeric service', () => {
  const catalog = [
    { id: 'point', name: 'Пилинг1.5' },
    { id: 'comma', name: 'Пилинг1,5' },
    { id: 'reversed', name: 'Пилинг5.1' },
    { id: 'zone-first', name: '1 зона 2 этап' },
    { id: 'stage-first', name: '2 зоны 1 этап' },
  ];
  for (const [query, ids] of [
    ['пилинга1.5', ['point']],
    ['пилинга1,5', ['comma']],
    ['пилинга5,1', []],
    ['1 зоны 2 этапа', ['zone-first']],
    ['2 зоны 1 этапа', ['stage-first']],
    ['пилинг', []],
  ])
    assert.deepEqual(
      resolveService(catalog, query).map((row) => row.id),
      ids,
      query,
    );
});

test('plain text services retain unordered morphology subsets and distinct-word consumption', () => {
  for (const [name, query] of [
    ['Первичная консультация', 'консультацию первичную'],
    ['Первичная консультация', 'консультаций'],
    ['Миндальный пилинг', 'пилинга миндального'],
    ['Массаж массаж', 'массажа массажу'],
  ])
    assert.equal(serviceMatches(name, query), true, name + ' ← ' + query);
  for (const [name, query] of [
    ['Первичная консультация', 'повторную консультацию'],
    ['Массаж', 'массажа массажу'],
    ['Массаж массаж', 'массажа массажу массажем'],
  ])
    assert.equal(serviceMatches(name, query), false, name + ' ← ' + query);
});

function numericFixture(name = 'Пилинг1.5') {
  const f = dialogueFixture();
  f.services.splice(
    0,
    f.services.length,
    { id: 'numeric', name, duration: 30, staffId: 'owner' },
    { id: 'other', name: 'Пилинг5.1', duration: 60, staffId: 'owner' },
  );
  return f;
}
const noSave = (f) => assert.ok(f.patients.every((row) => row.appointments.length === 0));

test('the exact numeric service reaches an ordinary manual form with its own identity and duration', () => {
  const f = numericFixture();
  const result = f.start({
    query: 'Анна Семёнова',
    serviceQuery: 'пилинга1.5',
    date: day,
    time: '10:00',
  });
  assert.equal(result.dialogue.step, 'review');
  assert.equal(result.action, null);
  const ready = f.answer({ text: 'открой форму' }).result;
  assert.deepEqual(ready.action.serviceIds, ['numeric']);
  assert.equal(ready.action.duration, 30);
  assert.equal(ready.action.type, 'prepareAppointment');
  noSave(f);
});

test('swapped decimals or swapped numeric attachments require service clarification without an accidental draft', () => {
  for (const [name, query] of [
    ['Пилинг1.5', 'пилинга5,1'],
    ['1 зона 2 этап', '2 зоны 1 этапа'],
    ['Пилинг1.5', 'пилинг'],
  ]) {
    const f = numericFixture(name);
    const result = f.start({
      query: 'Анна Семёнова',
      serviceQuery: query,
      date: day,
      time: '10:00',
    });
    assert.equal(result.dialogue.step, 'service', query);
    assert.equal(
      result.dialogue.fields.find((row) => row.key === 'service'),
      undefined,
      query,
    );
    assert.equal(result.action, null, query);
    noSave(f);
  }
});

test('numeric ordered matching retains the bounded query and empty-input limits', () => {
  assert.equal(serviceMatches('Пилинг1.5', ''), false);
  assert.equal(serviceMatches('', 'пилинг1.5'), false);
  const bounded = [...Array(15).fill('зона'), '1'].join(' ');
  assert.equal(serviceMatches(bounded, bounded), true);
  const oversized = [...Array(16).fill('зона'), '1'].join(' ');
  assert.equal(serviceMatches(oversized, oversized), false);
});
