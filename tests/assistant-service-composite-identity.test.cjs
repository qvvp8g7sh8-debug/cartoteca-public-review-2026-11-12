const test = require('node:test');
const assert = require('node:assert/strict');
const { serviceMatches, serviceText } = require('../src/server/modules/assistant/language/services/service-matching.cjs');
const { exactServiceAnswer } = require('../src/server/modules/assistant/language/services/service-exact-followup.cjs');
const {
  partialServiceScore,
  serviceAliasSourceMatches,
  serviceDescriptionMatches,
  servicePartialIdentityMatches,
} = require('../src/server/modules/assistant/language/services/service-partial-search.cjs');
const { entityText, initialEntities } = require('../src/server/modules/assistant/interpretation/entity-provenance.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const title = 'RF-лифтинг (лицо+шея)';
const catalog = (names) => names.map((name, index) => ({
  id: 'service-' + index, name, duration: 60, staffId: 'owner', category: 'lifting',
}));
const ids = (matches) => matches.map((row) => row.id).sort();
const known = { query: 'Анна Семёнова', date: day, time: '12:00' };
function fixture(names = [title], role = 'owner') {
  const f = dialogueFixture({ role });
  if (role === 'cosmetologist') f.members[0].role = role;
  f.services.splice(0, f.services.length, ...catalog(names));
  f.c.platform.serviceGroups = () => ({ groups: [
    { id: 'other', title: 'Другое' },
    { id: 'lifting', title: 'Лифтинг' },
    { id: 'care', title: 'Уход' },
  ] });
  f.changed();
  const entry = () => f.flow.get(f.c, f.member, f.state, f.result.dialogue.id);
  const prepare = (text) => f.flow.prepareModelTurn(f.c, {
    dialogueId: f.result.dialogue.id, dialogueVersion: f.result.dialogue.version,
    policyVersion: f.state.revision, text,
  }, f.state, f.member, f.clock);
  return { f, entry, prepare };
}
const noSave = (f) => assert.ok(f.patients.every((row) => row.appointments.length === 0));

test('spoken additive areas and script-boundary typography are equivalent without discarding plus', () => {
  for (const name of [title, 'RF лифтинг лицо + шея', 'RF–лифтинг (лицо + шея)']) {
    assert.equal(serviceMatches(name, 'RF лифтинг лицо плюс шея'), true, name);
    assert.equal(serviceMatches(name, 'шея плюс лицо RF лифтинг'), true, name);
    assert.equal(serviceMatches(name, 'RF лифтинг лицо плюс декольте'), false, name);
  }
  assert.equal(serviceMatches('RF лифтинг лицо шея', 'RF лифтинг лицо плюс шея'), false);
  assert.equal(serviceText('PRX-T133 +1.5 -2.0 30%'), 'PRX-T133 +1.5 -2.0 30%');
  assert.equal(serviceText('A1RF-лифтинг'), 'A1RF-лифтинг');
});

test('complete Latin and Cyrillic acronyms and spoken letters share the same current service', () => {
  for (const name of [title, 'РФ-лифтинг (лицо+шея)', 'рф-лифтинг лицо + шея'])
    for (const query of [
      'RF лифтинг лицо плюс шея', 'рф лифтинг лицо плюс шея',
      'эр эф лифтинг лицо плюс шея', 'лицо плюс шея RF лифтинг',
    ]) {
      assert.deepEqual(ids(exactServiceAnswer(catalog([name]), query).matches), ['service-0'], name + ' ← ' + query);
      assert.ok(Number.isFinite(partialServiceScore(name, query)), query);
    }
  assert.deepEqual(exactServiceAnswer(catalog([title]), 'HF лифтинг лицо плюс шея').matches, []);
});

test('the full nonnumeric description may omit only its technology acronym', () => {
  assert.equal(serviceDescriptionMatches(title, 'лифтинг лицо плюс шея'), true);
  assert.deepEqual(ids(exactServiceAnswer(catalog([title]), 'лифтинг лицо плюс шея').matches), ['service-0']);
  for (const query of [
    'лифтинг', 'лифтинг лицо', 'лифтинг лицо шея',
    'лифтинг лицо плюс декольте', 'лифтинг лицо плюс шея массаж',
    'не лифтинг лицо плюс шея', 'лифтинг лицо плюс шея или массаж',
  ]) {
    assert.equal(serviceDescriptionMatches(title, query), false, query);
    assert.deepEqual(exactServiceAnswer(catalog([title]), query).matches, [], query);
  }
  assert.equal(serviceDescriptionMatches('RF уход', 'уход'), false);
  assert.equal(serviceDescriptionMatches('Жёлтый пилинг', 'жёлтый'), false);
});

test('different technologies duplicate names and additional areas retain real ambiguity', () => {
  const rows = catalog([title, 'SMAS-лифтинг (лицо+шея)', title, 'RF-лифтинг (лицо+шея+декольте)']);
  assert.deepEqual(ids(exactServiceAnswer(rows, 'лифтинг лицо плюс шея').matches), ['service-0', 'service-1', 'service-2']);
  assert.deepEqual(ids(exactServiceAnswer(rows, 'RF лифтинг лицо плюс шея').matches), ['service-0', 'service-2']);
  const { f, entry } = fixture([title, 'SMAS-лифтинг (лицо+шея)']);
  f.start({ ...known, serviceQuery: 'лифтинг лицо плюс шея' });
  assert.equal(f.result.dialogue.step, 'service');
  assert.equal(entry().data.serviceChosen, false);
  assert.equal(f.result.dialogue.options.length, 2);
  f.answer({ text: 'SMAS лифтинг лицо плюс шея' });
  assert.equal(entry().data.service.id, 'service-1');
  noSave(f);
});

test('an explicit two-area command cannot auto-select the sole three-area service', () => {
  const longer = 'RF-лифтинг (лицо+шея+декольте)';
  for (const query of ['RF лифтинг лицо плюс шея', 'RF лифтинг лицо+шея']) {
    assert.equal(serviceMatches(longer, query), false, query);
    assert.equal(servicePartialIdentityMatches(longer, query), false, query);
    assert.equal(partialServiceScore(longer, query), Infinity, query);
    assert.deepEqual(exactServiceAnswer(catalog([longer]), query).matches, [], query);
    const { f, entry } = fixture([longer]);
    f.start({ ...known, serviceQuery: query });
    assert.equal(f.result.dialogue.step, 'service', query);
    assert.equal(entry().data.serviceChosen, false, query);
    assert.equal(f.result.action, null, query);
    noSave(f);
  }
  for (const query of ['PRX', 'пилинг PRX'])
    assert.deepEqual(ids(exactServiceAnswer(catalog(['Пилинг PRX-T133']), query).matches), ['service-0'], query);
  for (const query of ['пилинг PRX лицо плюс шея', 'пилинг PRX-T133 лицо плюс шея'])
    assert.equal(servicePartialIdentityMatches('Пилинг PRX-T133 лицо+шея', query), true, query);
});

test('numeric identities and a complete alias proof do not acquire missing or changed qualifiers', () => {
  assert.equal(serviceAliasSourceMatches(title, 'эр эф лифтинг лицо плюс шея'), true);
  assert.equal(serviceAliasSourceMatches(title, 'лифтинг лицо плюс шея'), false);
  for (const name of ['RF-лифтинг 2.0 (лицо+шея)', 'RF-лифтинг (лицо+шея) 30%'])
    assert.equal(serviceDescriptionMatches(name, 'лифтинг лицо плюс шея'), false, name);
  for (const [name, query] of [
    ['Пилинг+1', 'пилинг1'], ['Пилинг1.5', 'пилинг1,5'],
    ['RF2.0', 'RF2'], ['RF-лифтинг 30%', 'RF лифтинг 20%'],
    ['Пилинг PRX-T133', 'пилинг PRX-T33'],
  ]) assert.deepEqual(exactServiceAnswer(catalog([name]), query).matches, [], name + ' ← ' + query);
});

for (const role of ['owner', 'salon_admin', 'cosmetologist'])
  test('a complete named service bypasses category choice and redundant yes for ' + role, () => {
    for (const text of ['RF лифтинг лицо плюс шея', 'лифтинг лицо плюс шея']) {
      const { f, entry, prepare } = fixture([title, 'Уход за лицом'], role);
      f.services[1].category = 'care';
      f.start(known);
      assert.equal(f.result.dialogue.prompt, 'Выберите категорию или услугу.');
      const before = structuredClone(entry().data);
      assert.equal(prepare(text), null, text);
      f.answer({ text });
      assert.equal(f.result.dialogue.step, 'review', text);
      assert.equal(entry().data.service.id, 'service-0');
      assert.equal(entry().data.duration, 60);
      assert.equal(entry().data.durationSource, 'service');
      assert.equal(entry().data.patient.id, before.patient.id);
      assert.equal(entry().data.staff.id, before.staff.id);
      assert.equal(entry().data.date, before.date);
      assert.equal(entry().data.time, before.time);
      assert.doesNotMatch(f.result.text, /верно|имеете в виду/iu);
      const form = f.answer({ text: 'открой форму' }).result;
      assert.deepEqual(form.action.serviceIds, ['service-0']);
      noSave(f);
    }
  });

test('fresh specialist scope and catalog changes cannot reuse an earlier description match', () => {
  for (const mutation of ['name', 'staffId', 'remove', 'duplicate']) {
    const { f, entry, prepare } = fixture();
    f.members.push({ accountId: 'other', role: 'cosmetologist', status: 'active', displayName: 'Другой специалист' });
    f.services.push({ ...f.services[0], id: 'foreign', staffId: 'other' });
    f.start(known);
    assert.equal(prepare('лифтинг лицо плюс шея'), null);
    if (mutation === 'remove') f.services.shift();
    else if (mutation === 'duplicate') f.services.push({ ...f.services[0], id: 'duplicate' });
    else f.services[0][mutation] = mutation === 'name' ? 'RF-лифтинг (тело+руки)' : 'other';
    f.changed();
    f.answer({ text: 'лифтинг лицо плюс шея' });
    assert.equal(entry().data.serviceChosen, false, mutation);
    assert.equal(entry().data.date, day);
    assert.equal(entry().data.time, '12:00');
    assert.ok(!f.result.dialogue.options.some((row) => row.label.includes('foreign')));
    noSave(f);
  }
});

test('five-plus-word source aliases retain every spoken area instead of the four-word person limit', () => {
  for (const spoken of [
    'RF лифтинг лицо плюс шея', 'эр эф лифтинг лицо плюс шея',
    'рф лифтинг лицо плюс шея', 'лифтинг лицо плюс шея',
  ]) {
    const raw = 'Запиши Анну Семёнову на ' + spoken + ' завтра в12:00.';
    assert.equal(entityText(raw, title, 'service'), spoken, raw);
    assert.equal(entityText(raw, 'РФ-лифтинг (лицо+шея)', 'service'), spoken, raw);
    const grounded = initialEntities({ intent: 'prepareAppointment', ...known, serviceQuery: title }, raw, {
      date: day, time: '12:00',
    });
    assert.equal(grounded.serviceQuery, spoken);
    const { f, entry } = fixture();
    f.start(grounded);
    assert.equal(entry().data.service.id, 'service-0');
    assert.equal(entry().data.date, day);
    assert.equal(entry().data.time, '12:00');
    noSave(f);
  }
  assert.equal(entityText('Открой Анну Марину Ольгу Юлию Елену.', 'Анна Марина Ольга Юлия Елена', 'client'), '');
});

test('canonical model titles never remove heard areas or substitute an unheard numeric product code', () => {
  for (const [spoken, expected] of [
    ['RF лифтинг лицо плюс шея плюс декольте', 'RF лифтинг лицо плюс шея плюс декольте'],
    ['лифтинг лицо плюс шея плюс декольте', ''],
    ['RF лифтинг лицо плюс шея T134', 'RF лифтинг лицо плюс шея T134'],
  ]) {
    const source = entityText('Запиши на ' + spoken + ' завтра.', title, 'service');
    assert.equal(source, expected, spoken);
    if (source) assert.deepEqual(exactServiceAnswer(catalog([title]), source).matches, [], spoken);
  }
  assert.equal(
    entityText('Запиши на RF лифтинг лицо+шея+декольте завтра.', title, 'service'),
    'RF лифтинг лицо+шея+декольте',
  );
  assert.equal(entityText('Запиши на RF лифтинг лицо+шея+30% завтра.', title, 'service'), '');
  const source = entityText('Запиши на RF лифтинг лицо плюс шея T134 завтра.', title + ' T133', 'service');
  assert.equal(source, 'RF лифтинг лицо плюс шея T134');
  assert.ok(!source.includes('T133'));
  assert.deepEqual(exactServiceAnswer(catalog([title + ' T133']), source).matches, []);
  for (const raw of [
    'Запиши не на RF лифтинг лицо плюс шея.',
    'Запиши на RF лифтинг лицо плюс шея или массаж.',
    'Запиши на лифтинг лицо плюс шея массаж.',
  ]) assert.equal(entityText(raw, title, 'service'), '', raw);
});

test('service source scans retain their own twelve-word and current catalog bounds', () => {
  const description = 'лифтинг лицо плюс шея плюс декольте поверхностный аппаратный комплексный комфортный уход';
  const canonical = 'RF-' + description;
  const spoken = 'RF ' + description;
  assert.equal(entityText('Запиши на ' + spoken + ' завтра.', canonical, 'service'), spoken);
  assert.equal(entityText('Запиши на ' + spoken + ' специальный завтра.', canonical + ' специальный', 'service'), '');
  assert.equal(entityText('пожалуйста '.repeat(129) + spoken, canonical, 'service'), '');
  assert.deepEqual(exactServiceAnswer(catalog(Array(201).fill(title)), 'лифтинг лицо плюс шея').matches, []);
});
