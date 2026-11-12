const test = require('node:test');
const assert = require('node:assert/strict');
const { serviceMatches } = require('../src/server/modules/assistant/language/services/service-matching.cjs');
const { serviceSuggestionScore, suggestServices, serviceChoiceOperation } = require('../src/server/modules/assistant/language/services/service-suggestions.cjs');
const { partialServiceScore, serviceAliasSourceMatches } = require('../src/server/modules/assistant/language/services/service-partial-search.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const catalog = names => names.map((name, index) => ({ id: 's-' + index, name, duration: 60, staffId: 'owner' }));
const ids = result => result.matches.map(row => row.id).sort();
function fixture(names = ['Пилинг PRX-t33'], query = 'пилинг PeriX', foreign = false) {
  const f = dialogueFixture();
  f.services.splice(0, f.services.length, ...catalog(names));
  if (foreign) {
    f.members.push({ accountId: 'other', role: 'cosmetologist', status: 'active', displayName: 'Другой специалист' });
    f.services.push({ id: 'foreign', name: 'Пилинг PRX-T133', duration: 30, staffId: 'other' });
  }
  f.changed();
  const beforePatients = structuredClone(f.patients);
  const result = f.start({ query: 'Анна', serviceQuery: query, date: day, time: '10:00', duration: 45 });
  return { f, result, beforePatients, entry: () => f.flow.get(f.c, f.member, f.state, f.result.dialogue.id) };
}
function offerEntry(names) {
  return { step: 'service', response: { dialogue: { phase: 'serviceChoice' } }, options: new Map(names.map((serviceName, index) => ['choice-' + index, { kind: 'service', approximateService: true, serviceName }])) };
}
test('strict matching and complete provenance scoring never acquire incomplete numeric aliases', () => {
  assert.equal(serviceMatches('Пилинг PRX-T33', 'пилинг PRX'), false);
  assert.equal(serviceSuggestionScore('Пилинг PRX-T33', 'пилинг PeriX'), Infinity);
  assert.equal(serviceSuggestionScore('Пилинг PRX', 'пилинг PeriX', { complete: true }), Infinity);
  assert.equal(serviceSuggestionScore('Пилинг PRX-T33', 'пилинг PeriX-T33', { complete: true, exact: true }), Infinity);
});
test('missing codes and deterministic letter pronunciations create candidates only without a brand dictionary', () => {
  const services = catalog(['Пилинг PRX-t33']);
  for (const query of ['пилинг PRX', 'пилинг PeriX', 'пилинг перикс', 'пилинг пиарикс', 'пилинг пи ар икс', 'перикс']) {
    assert.deepEqual(ids(suggestServices(services, query)), ['s-0'], query);
    assert.equal(serviceMatches(services[0].name, query), false, query);
  }
  assert.deepEqual(ids(suggestServices(catalog(['RF уход']), 'эр эф уход')), ['s-0']);
});
test('several real code variants stay ambiguous and explicitly named codes cannot be silently changed', () => {
  const services = catalog(['Пилинг PRX-T33', 'Пилинг PRX-T133']);
  assert.deepEqual(ids(suggestServices(services, 'пилинг PeriX')), ['s-0', 's-1']);
  assert.deepEqual(ids(suggestServices(services, 'пилинг PeriX-T133')), ['s-1']);
  for (const query of ['пилинг PRX-T132', 'пилинг PeriX-T132', 'пилинг PeriX-133', 'пилинг PRX-T+33'])
    assert.deepEqual(ids(suggestServices(services, query)), [], query);
});
test('numeric signs decimals percentages leading zeroes and qualifier attachment never use fuzzy repairs', () => {
  for (const [name, query] of [
    ['Пилинг 30%', 'пилинг 20%'], ['Пилинг 30%', 'пелинг 30%'],
    ['Пилинг PRX-T01', 'пилинг PeriX-T1'], ['Пилинг PRX-T1.5', 'пилинг PeriX-T1,5'],
    ['Пилинг PRX-T33', 'пилинг PeriX-T-33'], ['RF2.0', 'rf2'],
    ['PRX 1 зона 2 этап', 'PRX 1 этап 2 зоны'], ['PRX 1 зона 2 этап', 'PRX зоны 1 этап 2'],
  ]) assert.deepEqual(ids(suggestServices(catalog([name]), query)), [], name + ' <- ' + query);
});
test('whole mixed-script brand words may be searched without accepting arbitrary prefixes or dropping unknown words', () => {
  const services = catalog(['Пилинг JetPeel', 'Пилинг AquaPeel']);
  assert.deepEqual(ids(suggestServices(services, 'джетпил')), ['s-0']);
  assert.deepEqual(ids(suggestServices(services, 'аквапил')), ['s-1']);
  for (const query of ['джет', 'аква', 'джетпил массаж', 'PeriX массаж', 'не перикс', 'перикс или массаж', 'если перикс'])
    assert.deepEqual(ids(suggestServices(services, query)), [], query);
});
test('a full source-alias proof covers both sides and never supplies an unheard or conflicting code', () => {
  for (const raw of ['пилинг PeriX', 'пилинг перикс', 'пилинг пи ар икс'])
    assert.equal(serviceAliasSourceMatches('пилинг PRX', raw), true, raw);
  assert.equal(serviceAliasSourceMatches('пилинг PRX-T33', 'пилинг PeriX-T33'), true);
  for (const [proposal, raw] of [
    ['пилинг PRX-T33', 'пилинг PeriX'], ['пилинг PRX-T133', 'пилинг PeriX-T33'],
    ['пилинг PRX', 'PeriX'], ['пилинг PRX', 'пилинг PeriX массаж'],
    ['пилинг PRX', 'не пилинг PeriX'], ['пилинг PRX-T01', 'пилинг PeriX-T1'],
  ]) assert.equal(serviceAliasSourceMatches(proposal, raw), false, proposal + ' <- ' + raw);
});
test('current offers accept only a uniquely distinguishing partial answer and never the first generic match', () => {
  const ordinary = offerEntry(['Миндальный пилинг']);
  assert.equal(serviceChoiceOperation(ordinary, 'пилинг').kind, 'localHelp');
  assert.equal(serviceChoiceOperation(ordinary, 'миндальный').kind, 'localHelp');
  assert.deepEqual(serviceChoiceOperation(ordinary, 'да'), { kind: 'choice', choice: 'choice-0' });
  assert.deepEqual(serviceChoiceOperation(ordinary, 'Миндальный пилинг'), { kind: 'choice', choice: 'choice-0' });
  const singleBrand = offerEntry(['Пилинг PRX-T33']);
  assert.equal(serviceChoiceOperation(singleBrand, 'пилинг').kind, 'localHelp');
  for (const answer of ['PRX', 'перикс', 'пиарикс', 'T33'])
    assert.deepEqual(serviceChoiceOperation(singleBrand, answer), { kind: 'choice', choice: 'choice-0' }, answer);
  const ordinaryPair = offerEntry(['Миндальный пилинг', 'Молочный пилинг']);
  assert.equal(serviceChoiceOperation(ordinaryPair, 'пилинг').kind, 'localHelp');
  assert.deepEqual(serviceChoiceOperation(ordinaryPair, 'молочный'), { kind: 'choice', choice: 'choice-1' });
  const entry = offerEntry(['Пилинг PRX-T33', 'Пилинг PRX-T133']);
  assert.equal(serviceChoiceOperation(entry, 'пилинг').kind, 'localHelp');
  assert.equal(serviceChoiceOperation(entry, 'перикс').kind, 'localHelp');
  assert.equal(serviceChoiceOperation(entry, 'да').kind, 'localHelp');
  assert.deepEqual(serviceChoiceOperation(entry, 'T33'), { kind: 'choice', choice: 'choice-0' });
  assert.equal(serviceChoiceOperation(entry, 'T132'), null);
  const brands = offerEntry(['Пилинг JetPeel', 'Пилинг AquaPeel']);
  assert.deepEqual(serviceChoiceOperation(brands, 'аквапил'), { kind: 'choice', choice: 'choice-1' });
});
test('one unique deterministic short identity needs no confirmation and keeps client date time and manual duration through the form', () => {
  const { f, result, beforePatients, entry } = fixture();
  assert.equal(result.action, null);
  assert.equal(result.dialogue.step, 'review');
  assert.equal(entry().data.serviceChosen, true);
  assert.equal(entry().data.service.id, 's-0');
  assert.equal(entry().data.patient.id, f.patients[0].id);
  assert.equal(entry().data.date, day);
  assert.equal(entry().data.time, '10:00');
  assert.equal(entry().data.duration, 45);
  assert.doesNotMatch(result.text, /верно|имеете в виду/iu);
  const form = f.answer({ text: 'открой форму' }).result;
  assert.equal(form.action.type, 'prepareAppointment');
  assert.deepEqual(form.action.serviceIds, ['s-0']);
  assert.equal(form.action.duration, 45);
  assert.deepEqual(f.patients, beforePatients);
});
test('distinct partial code answers select the current service while preserving the other known fields', () => {
  const { f, result, entry, beforePatients } = fixture(['Пилинг PRX-T33', 'Пилинг PRX-T133']);
  assert.equal(result.dialogue.options.length, 2);
  f.answer({ text: 'T133' });
  assert.equal(entry().data.service.id, 's-1');
  assert.equal(entry().data.date, day);
  assert.equal(entry().data.time, '10:00');
  assert.equal(entry().data.duration, 45);
  assert.deepEqual(f.patients, beforePatients);
});
test('foreign specialist catalog and stale names durations staff or removals cannot turn a candidate into a selected service', () => {
  const foreign = fixture(['Пилинг PRX-T33'], 'пилинг', true);
  assert.equal(foreign.result.dialogue.options.length, 1);
  assert.ok(foreign.result.dialogue.options.every(row => !row.label.includes('T133')));
  for (const field of ['name', 'duration', 'staffId', 'remove']) {
    const { f, result, beforePatients } = fixture(['Пилинг PRX-T33'], 'пилинг');
    if (field === 'remove') f.services.splice(0);
    else f.services[0][field] = field === 'name' ? 'Пилинг PRX-T133' : field === 'duration' ? 30 : 'other';
    f.changed();
    assert.throws(() => f.answer({ choice: result.dialogue.options[0].id }), { status: 409 }, field);
    assert.deepEqual(f.patients, beforePatients);
  }
});
test('candidate limits remain bounded and overflow cannot silently choose a service', () => {
  const many = catalog(['Пилинг PRX-T33', 'Пилинг PRX-T34', 'Пилинг PRX-T35', 'Пилинг PRX-T36']);
  const result = suggestServices(many, 'пилинг PeriX');
  assert.equal(result.overflow, true);
  assert.equal(result.matches.length, 3);
  assert.equal(suggestServices(Array.from({ length: 201 }, (_, index) => ({ id: index, name: 'Пилинг PRX-T33' })), 'пилинг PeriX').overflow, true);
  assert.equal(partialServiceScore('Пилинг PRX-T33', 'перикс '.repeat(9)), Infinity);
});
