const test = require('node:test');
const assert = require('node:assert/strict');
const {
  serviceSuggestionScore,
  serviceChoiceOperation,
} = require('../src/server/modules/assistant/language/services/service-suggestions.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const complete = { complete: true };
const exact = { complete: true, exact: true };
const finite = (name, query, options) =>
  Number.isFinite(serviceSuggestionScore(name, query, options));

test('complete source proof consumes all catalog tokens while default suggestions retain subset matching', () => {
  assert.equal(serviceSuggestionScore('Первичная консультация', 'консультацию'), 0);
  for (const query of ['консультацию', 'консултацию', 'первичную'])
    assert.equal(
      serviceSuggestionScore('Первичная консультация', query, complete),
      Infinity,
      query,
    );
  assert.ok(finite('Первичная консультация', 'первичную консултацию', complete));
  assert.ok(finite('Первичная консультация', 'консултацию первичную', complete));
  assert.equal(
    serviceSuggestionScore('Первичная консультация', 'первичную консултацию завтра', complete),
    Infinity,
  );
});

test('complete proof permits only catalog-backed splits covering the entire title', () => {
  for (const query of ['миндальныйпилинг', 'миндальногопилинга', 'пилингаминдального'])
    assert.ok(finite('Миндальный пилинг', query, complete), query);
  for (const query of ['пилинг', 'миндального', 'миндаль', 'миндальныйпилинготправь'])
    assert.equal(serviceSuggestionScore('Миндальный пилинг', query, complete), Infinity, query);
  assert.equal(
    serviceSuggestionScore('Глубокий миндальный пилинг', 'миндальныйпилинг', complete),
    Infinity,
  );
});

test('exact complete mode accepts whole inflections and joins but never edits, numbers or qualifier loss', () => {
  for (const query of ['миндального пилинга', 'пилинга миндального', 'миндальногопилинга'])
    assert.ok(finite('Миндальный пилинг', query, exact), query);
  for (const query of [
    'миндалный пилинг',
    'миндальныйпилниг',
    'пилинг',
    'не миндальный пилинг',
    'миндальный или молочный пилинг',
  ])
    assert.equal(serviceSuggestionScore('Миндальный пилинг', query, exact), Infinity, query);
  assert.ok(finite('Пилинг 30%', 'пилинга 30%', exact));
  for (const query of ['пилинг', 'пилинг 30', 'пелинг 30%'])
    assert.equal(serviceSuggestionScore('Пилинг 30%', query, exact), Infinity, query);
});

function fixture() {
  const f = dialogueFixture();
  f.services.splice(0, f.services.length, {
    id: 's',
    name: 'Миндальный пилинг',
    duration: 30,
    staffId: 'owner',
  });
  f.changed();
  f.start({
    query: 'Анна',
    serviceQuery: 'миндалный пилинг',
    date: day,
    time: '10:00',
    duration: 45,
  });
  return { f, entry: () => f.flow.get(f.c, f.member, f.state, f.result.dialogue.id) };
}
const known = (entry) => ({
  patient: entry.data.patient.id,
  date: entry.data.date,
  time: entry.data.time,
  duration: entry.data.duration,
});
const noSave = (f) => assert.ok(f.patients.every((row) => row.appointments.length === 0));

test('a full joined repeated title confirms only the current approximate candidate without saving', () => {
  const { f, entry } = fixture();
  const before = known(entry());
  assert.equal(serviceChoiceOperation(entry(), 'миндальногопилинга').kind, 'choice');
  assert.equal(serviceChoiceOperation(entry(), 'миндальныйпилниг'), null);
  assert.equal(serviceChoiceOperation(entry(), 'пилинг').kind, 'localHelp');
  const result = f.answer({ text: 'миндальногопилинга' }).result;
  assert.equal(result.dialogue.step, 'review');
  assert.equal(entry().data.service.id, 's');
  assert.deepEqual(known(entry()), before);
  noSave(f);
});

test('a bare no rejects the current approximate offer and preserves the other established fields', () => {
  const { f, entry } = fixture();
  const before = known(entry());
  assert.deepEqual(serviceChoiceOperation(entry(), 'нет'), { kind: 'edit', field: 'service' });
  const result = f.answer({ text: 'нет' }).result;
  assert.equal(result.dialogue.step, 'service');
  assert.equal(result.dialogue.phase, 'serviceChoice');
  assert.equal(entry().data.serviceQuery, '');
  assert.equal(entry().data.serviceChosen, false);
  assert.deepEqual(known(entry()), before);
  noSave(f);
});
