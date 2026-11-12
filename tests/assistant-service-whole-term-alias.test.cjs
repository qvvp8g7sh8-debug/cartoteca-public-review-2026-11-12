const test = require('node:test');
const assert = require('node:assert/strict');
const {
  serviceMatches,
  serviceWordForms,
} = require('../src/server/modules/assistant/language/services/service-matching.cjs');
const {
  exactServiceAnswer,
} = require('../src/server/modules/assistant/language/services/service-exact-followup.cjs');
const { entityText } = require('../src/server/modules/assistant/interpretation/entity-provenance.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const endings = ['', 'а', 'у', 'ом', 'е', 'и', 'ов', 'ам', 'ами', 'ах'];
const forms = ['плазмалифтинг', 'плазмолифтинг'].flatMap((stem) =>
  endings.map((ending) => stem + ending),
);
const noSave = (f) => assert.ok(f.patients.every((p) => p.appointments.length === 0));
function fixture(duplicate = false) {
  const f = dialogueFixture();
  f.members.push({
    accountId: 'other',
    displayName: 'Ирина Орлова',
    role: 'cosmetologist',
    status: 'active',
  });
  f.services.splice(
    0,
    f.services.length,
    { id: 'own', name: 'Плазмалифтинг', duration: 45, staffId: 'owner' },
    { id: 'foreign', name: 'Плазмолифтинг', duration: 60, staffId: 'other' },
  );
  if (duplicate)
    f.services.push({ id: 'own-duplicate', name: 'Плазмолифтинг', duration: 45, staffId: 'owner' });
  f.changed();
  f.start(
    { query: 'Анна Семёнова', staffQuery: 'Тестовый Специалист', date: day, time: '12:00' },
    { openWhenComplete: true },
  );
  return f;
}

test('the two whole-term spellings and their normal noun inflections are mutually exact', () => {
  for (const catalog of forms)
    for (const heard of forms) {
      assert.ok(serviceWordForms(catalog).has(heard), catalog + ' / ' + heard);
      assert.equal(serviceMatches(catalog, heard), true, catalog + ' / ' + heard);
      assert.equal(exactServiceAnswer([{ id: 'one', name: catalog }], heard).matches[0]?.id, 'one');
    }
});

test('closed identities never turn prefixes or arbitrary vowel errors into exact service matches', () => {
  for (const heard of [
    'плазма',
    'плазмо',
    'плазмолифт',
    'плазмалифт',
    'плезмолифтинг',
    'плазмылифтинг',
    'плазмолифтингуя',
    'не плазмолифтинг',
    'плазмолифтинг или массаж',
  ]) {
    assert.equal(serviceMatches('Плазмалифтинг', heard), false, heard);
    assert.equal(
      exactServiceAnswer([{ id: 'one', name: 'Плазмалифтинг' }], heard).matches.length,
      0,
      heard,
    );
  }
  assert.equal(serviceMatches('Карбокситерапия', 'карбоксотеропия'), false);
});

test('a canonical model title locates only the actual spoken whole term and retains its spelling', () => {
  for (const [raw, proposal, expected] of [
    ['Нужен плазмолифтинг.', 'Плазмалифтинг', 'плазмолифтинг'],
    ['На плазмалифтинга завтра.', 'Плазмолифтинг', 'плазмалифтинга'],
    ['Хочу плазмолифтингом.', 'Плазмалифтинг', 'плазмолифтингом'],
  ])
    assert.equal(entityText(raw, proposal, 'service'), expected);
  assert.equal(entityText('На плазму.', 'Плазмолифтинг', 'service'), '');
});

test('two catalog spellings belonging to the same performer remain a choice', () => {
  const f = fixture(true);
  const result = f.answer({ text: 'Плазмолифтинг' }).result;
  assert.equal(result.dialogue.step, 'service');
  assert.equal(result.action, null);
  const data = f.flow.get(f.c, f.member, f.state, result.dialogue.id).data;
  assert.equal(data.serviceChosen, false);
  assert.equal(data.service, null);
  assert.equal(result.dialogue.options.filter((o) => /Плазм[ао]лифтинг/u.test(o.label)).length, 2);
  noSave(f);
});

test('a whole-term alias selects only the chosen performer catalog without confirming the foreign duplicate', () => {
  for (const text of ['Плазмолифтинг', 'на плазмолифтинг', 'Плазмалифтингом']) {
    const f = fixture();
    const body = {
      policyVersion: f.state.revision,
      dialogueId: f.result.dialogue.id,
      dialogueVersion: f.result.dialogue.version,
      text,
    };
    assert.equal(f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock), null);
    const result = f.answer({ text }).result;
    assert.equal(result.dialogue, null);
    assert.deepEqual(result.action.serviceIds, ['own']);
    assert.equal(result.action.staffId, 'owner');
    assert.equal(result.action.duration, 45);
    noSave(f);
  }
});

test('term identity keeps all spoken numeric codes signs and additive treatment areas strict', () => {
  const equal = [
    ['Плазмалифтинг T133', 'плазмолифтинг T133'],
    ['Плазмалифтинг 5%', 'плазмолифтинга 5%'],
    ['Плазмалифтинг лицо+шея', 'плазмолифтинг лицо плюс шея'],
  ];
  for (const [catalog, heard] of equal)
    assert.equal(serviceMatches(catalog, heard), true, catalog + ' / ' + heard);
  const distinct = [
    ['Плазмалифтинг T133', 'плазмолифтинг T134'],
    ['Плазмалифтинг 5%', 'плазмолифтинг 15%'],
    ['Плазмалифтинг -5', 'плазмолифтинг 5'],
    ['Плазмалифтинг лицо+шея+декольте', 'плазмолифтинг лицо плюс шея'],
    ['Плазмалифтинг лицо+шея', 'плазмолифтинг лицо плюс декольте'],
  ];
  for (const [catalog, heard] of distinct) {
    assert.equal(serviceMatches(catalog, heard), false, catalog + ' / ' + heard);
    assert.equal(
      exactServiceAnswer([{ id: 'one', name: catalog }], heard).matches.length,
      0,
      catalog + ' / ' + heard,
    );
  }
});
