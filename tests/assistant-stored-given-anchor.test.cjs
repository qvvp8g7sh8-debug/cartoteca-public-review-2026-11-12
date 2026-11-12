const test = require('node:test');
const assert = require('node:assert/strict');
const { nameSuggestionPlan, rankNameSuggestions } = require('../src/server/modules/assistant/language/names/name-suggestions.cjs');
const { expandClientSource } = require('../src/server/modules/assistant/language/names/client-source-span.cjs');
const { initialEntities } = require('../src/server/modules/assistant/interpretation/entity-provenance.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const person = (id, firstName, lastName) => ({ id, firstName, lastName, middleName: '', name: firstName + ' ' + lastName, phone: '', appointments: [], createdBy: 'owner' });
const patients = [person('wanted', 'Гульнара', 'Мухамедянова'), person('other-given', 'Гузель', 'Мухамедянова'), person('other-surname', 'Гульнара', 'Хабибуллина')];
const rank = (text, rows = patients) => rankNameSuggestions(rows, nameSuggestionPlan(text)).map(row => row.id);
test('a directory first-name field anchors phonetic surname suggestions without a static first-name whitelist', () => {
  for (const text of ['Гульнару Мухомидианову', 'Мухомидианову Гульнару']) assert.deepEqual(rank(text), ['wanted']);
  for (const text of ['Мухомидианову', 'Гульнору Мухомидианову', 'не Гульнару Мухомидианову', 'если Гульнару Мухомидианову']) assert.deepEqual(rank(text), []);
  const custom = [person('synthetic-unlisted', 'Аделина', 'Мухамедянова'), person('wrong', 'Алёна', 'Мухамедянова')];
  assert.deepEqual(rank('Аделину Мухомидианову', custom), ['synthetic-unlisted']);
});
test('a model-normalized uncommon given name locates the full original surname without replacing its letters', () => {
  const raw = 'Запиши гульнару Мухомидианову на сегодня на консультацию на 6 вечера.';
  for (const query of ['Гульнара Мухамедянова', 'Гульнара', 'Гульнару Мухомидианову']) {
    assert.equal(expandClientSource(raw, query, { serviceQuery: 'консультацию' }), 'гульнару Мухомидианову');
    const result = initialEntities({ intent: 'prepareAppointment', query, serviceQuery: 'консультация', date: day, time: '18:00' }, raw, { date: day, time: '18:00' });
    assert.equal(result.query, 'гульнару Мухомидианову');
  }
  assert.equal(expandClientSource('Гульнару Мухомидианову или Гульнару Хабибуллину', 'Гульнара'), '');
  assert.equal(expandClientSource('Запиши Анну-Марию Семёнову', 'Анна'), '');
});
test('an uncommon-name approximation requires an explicit current-person confirmation while retaining all booking fields', () => {
  const f = dialogueFixture();
  f.patients.splice(0, f.patients.length, ...structuredClone(patients));
  f.c.platform.workSchedules.view = () => ({ days: { [day]: { status: 'working', intervals: [['07:00', '20:00']] } }, closures: {} });
  const initial = f.start({ query: 'Гульнару Мухомидианову', serviceQuery: 'Чистка', date: day, time: '18:00' });
  assert.equal(initial.action, null);
  assert.equal(initial.dialogue.step, 'client');
  assert.equal(initial.dialogue.options.length, 1);
  assert.match(initial.dialogue.prompt, /Гульнара.*Мухамедянова/u);
  assert.ok([...f.flow.get(f.c, f.member, f.state, initial.dialogue.id).options.values()].every(row => row.approximate === true));
  const selected = f.answer({ text: 'Мухамедянову' }).result;
  assert.equal(selected.dialogue.step, 'review');
  const ready = f.answer({ text: 'открой форму' }).result;
  assert.equal(ready.action.patientId, 'wanted');
  assert.equal(ready.action.time, '18:00');
  assert.equal(ready.action.date, day);
  assert.equal(ready.action.duration, 30);
  assert.ok(f.patients.every(row => row.appointments.length === 0));
});
