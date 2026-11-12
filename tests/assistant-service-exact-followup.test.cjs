const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const { exactServiceAnswer } = require('../src/server/modules/assistant/language/services/service-exact-followup.cjs');
const emptyFields = { client: null, staff: null, service: null, date: null, time: null, duration: null };
function fixture({ role = 'owner', services, duration } = {}) {
  const f = dialogueFixture({ role });
  if (role === 'cosmetologist') f.members[0].role = role;
  f.c.platform.serviceGroups = () => ({ groups: [
    { id: 'other', title: 'Другое' },
    { id: 'peels', title: 'Пилинги' },
    { id: 'care', title: 'Уход' },
  ] });
  f.services.splice(0, f.services.length, ...(services || [
    { id: 'peel', name: 'Жёлтый пилинг', duration: 60, staffId: 'owner', category: 'peels' },
    { id: 'care', name: 'Уход за лицом', duration: 30, staffId: 'owner', category: 'care' },
  ]));
  f.changed();
  f.start({ query: 'Анна Семёнова', date: day, time: '12:00', ...(duration ? { duration } : {}) });
  const entry = () => f.flow.get(f.c, f.member, f.state, f.result.dialogue.id);
  const body = (text) => ({
    dialogueId: f.result.dialogue.id,
    dialogueVersion: f.result.dialogue.version,
    policyVersion: f.state.revision,
    text,
  });
  const prepare = (text) => {
    const request = body(text);
    return { request, snapshot: f.flow.prepareModelTurn(f.c, request, f.state, f.member, f.clock) };
  };
  return { f, entry, body, prepare };
}
const noSave = (f) => assert.ok(f.patients.every((row) => row.appointments.length === 0));

test('category question invites a category or the full service, with no mandatory category detour', () => {
  const { f } = fixture();
  assert.equal(f.result.dialogue.prompt, 'Выберите категорию или услугу.');
  assert.deepEqual(f.result.dialogue.options.map((row) => row.label), ['Пилинги', 'Уход']);
  noSave(f);
});

for (const role of ['owner', 'salon_admin', 'cosmetologist']) {
  test('exact whole service is resolved locally without yes for ' + role, () => {
    const { f, entry, prepare } = fixture({ role });
    const initial = structuredClone(entry().data);
    assert.equal(prepare('ЖЁЛТЫЙ ПИЛИНГ.').snapshot, null);
    const result = f.answer({ text: 'ЖЁЛТЫЙ ПИЛИНГ.' }).result;
    assert.equal(result.dialogue.step, 'review');
    assert.equal(entry().data.service.id, 'peel');
    assert.equal(entry().data.duration, 60);
    assert.equal(entry().data.durationSource, 'service');
    assert.equal(entry().data.patient.id, initial.patient.id);
    assert.equal(entry().data.date, initial.date);
    assert.equal(entry().data.time, initial.time);
    assert.doesNotMatch(result.text, /Вы имеете в виду|верно\?/u);
    noSave(f);
  });
}

test('full inflected title and courtesy wrappers share exact resolution, without fuzzy spelling or lost qualifiers', () => {
  const catalog = [{ id: 'peel', name: 'Жёлтый пилинг' }];
  for (const text of ['желтого пилинга', 'на жёлтый пилинг', 'пожалуйста, жёлтый пилинг']) {
    assert.equal(exactServiceAnswer(catalog, text).matches[0]?.id, 'peel', text);
    const { f, entry } = fixture();
    f.answer({ text });
    assert.equal(entry().data.service.id, 'peel', text);
    noSave(f);
  }
  for (const text of ['жёлтый', 'жолтый пилинг', 'не жёлтый пилинг', 'жёлтый или молочный пилинг'])
    assert.equal(exactServiceAnswer(catalog, text).matches.length, 0, text);
});

test('exact title wins over longer partial titles, but duplicate complete titles still require a choice', () => {
  const catalog = [
    { id: 'exact', name: 'Пилинг', duration: 30, staffId: 'owner', category: 'peels' },
    { id: 'longer', name: 'Миндальный пилинг', duration: 60, staffId: 'owner', category: 'peels' },
  ];
  const exact = fixture({ services: catalog });
  exact.f.answer({ text: 'Пилинг' });
  assert.equal(exact.entry().data.service.id, 'exact');
  const duplicate = fixture({ services: [catalog[0], { ...catalog[0], id: 'duplicate' }] });
  duplicate.f.answer({ text: 'Пилинг' });
  assert.equal(duplicate.f.result.dialogue.step, 'service');
  assert.equal(duplicate.entry().data.serviceChosen, false);
  assert.equal(duplicate.f.result.dialogue.options.filter((row) => /^Пилинг ·/u.test(row.label)).length, 2);
  noSave(exact.f);
  noSave(duplicate.f);
});

test('a single incomplete catalog match remains a question while its full title continues without yes', () => {
  for (const answer of ['да', 'Жёлтый пилинг']) {
    const { f, entry } = fixture();
    f.answer({ text: 'Жёлтый' });
    assert.equal(f.result.dialogue.step, 'service');
    assert.equal(entry().data.serviceChosen, false);
    assert.equal(f.result.dialogue.prompt, 'Жёлтый пилинг, верно?');
    assert.ok(f.result.dialogue.options.some((row) => row.label === 'Жёлтый пилинг · 60 мин'));
    f.answer({ text: answer });
    assert.equal(f.result.dialogue.step, 'review');
    assert.equal(entry().data.service.id, 'peel');
    noSave(f);
  }
});

test('full title replaces an approximate hypothesis through fresh resolution instead of confirming an old opaque suggestion', () => {
  const { f, entry, prepare } = fixture();
  f.answer({ text: 'жолтый пилинг' });
  assert.equal(entry().data.serviceChosen, false);
  assert.equal(f.result.dialogue.phase, 'serviceChoice');
  assert.equal(prepare('Жёлтый пилинг').snapshot, null);
  f.answer({ text: 'Жёлтый пилинг' });
  assert.equal(entry().data.service.id, 'peel');
  assert.equal(f.result.dialogue.step, 'review');
  noSave(f);
});

test('model-grounded service field uses the same exact catalog rule and preserves explicit duration', () => {
  const { f, entry, prepare } = fixture({ duration: 45 });
  const prepared = prepare('Мне нужна услуга Жёлтый пилинг');
  assert.ok(prepared.snapshot);
  const result = f.flow.applyModelTurn(f.c, prepared.request, f.state, f.member, f.clock, {
    operation: 'patch', fields: { ...emptyFields, service: 'Жёлтый пилинг' }, choice: null, field: null,
  }, prepared.snapshot);
  assert.equal(result.dialogue.step, 'review');
  assert.equal(entry().data.service.id, 'peel');
  assert.equal(entry().data.duration, 45);
  assert.equal(entry().data.durationSource, 'manual');
  noSave(f);
});

test('a catalog changed between local classification and applying the answer cannot select the missing service', () => {
  const { f, entry, prepare } = fixture();
  const before = structuredClone(entry().data);
  assert.equal(prepare('Жёлтый пилинг').snapshot, null);
  f.services[0].name = 'Другой уход';
  f.changed();
  f.answer({ text: 'Жёлтый пилинг' });
  assert.equal(entry().data.serviceChosen, false);
  assert.equal(entry().data.patient.id, before.patient.id);
  assert.equal(entry().data.date, before.date);
  assert.equal(entry().data.time, before.time);
  noSave(f);
});

test('exact identity lookup stays staff scoped and rejects conflicting numeric qualifiers', () => {
  const { f, entry } = fixture({ services: [
    { id: 'numeric', name: 'Пилинг PRX-T133', duration: 30, staffId: 'owner', category: 'peels' },
    { id: 'foreign', name: 'Жёлтый пилинг', duration: 60, staffId: 'other', category: 'care' },
  ] });
  f.members.push({ accountId: 'other', displayName: 'Другой специалист', role: 'cosmetologist', status: 'active' });
  f.answer({ text: 'Жёлтый пилинг' });
  assert.equal(entry().data.serviceChosen, false);
  f.answer({ text: 'Пилинг PRX-T113' });
  assert.equal(entry().data.serviceChosen, false);
  f.answer({ text: 'Пилинг PRX' });
  assert.equal(entry().data.service.id, 'numeric');
  assert.equal(f.result.dialogue.step, 'review');
  noSave(f);
});

test('ordinary exact followups leave standalone service reads outside cabinet transactions', () => {
  const { f, prepare } = fixture();
  const store = f.c.tenantStore('org');
  const originalRead = store.readServices, originalTransaction = store.transaction;
  let inside = false, reads = 0;
  store.readServices = () => {
    assert.equal(inside, false, 'full catalog reads must not enter a cabinet writer');
    reads++;
    return originalRead();
  };
  store.transaction = (callback, mode) => {
    assert.equal(inside, false, 'no nested cabinet transaction');
    inside = true;
    try { return originalTransaction(callback, mode); } finally { inside = false; }
  };
  assert.equal(prepare('Жёлтый пилинг').snapshot, null);
  f.answer({ text: 'Жёлтый пилинг' });
  assert.equal(f.result.dialogue.step, 'review');
  assert.ok(reads >= 2);
  noSave(f);
});

test('yes to a partial singleton keeps the same fresh catalog stamp and cannot confirm a changed service', () => {
  const { f, entry } = fixture();
  f.answer({ text: 'Жёлтый' });
  const before = structuredClone(entry().data);
  f.services[0].duration = 90;
  f.changed();
  assert.throws(() => f.answer({ text: 'да' }), { status: 409 });
  assert.deepEqual(entry().data, before);
  noSave(f);
});

test('multiple partial matches and conflicting numeric codes cannot be confirmed by bare yes', () => {
  for (const [services, query] of [
    [[
      { id: 'first', name: 'Жёлтый пилинг', duration: 30, staffId: 'owner' },
      { id: 'second', name: 'Миндальный пилинг', duration: 30, staffId: 'owner' },
    ], 'пилинг'],
    [[{ id: 'numeric', name: 'Пилинг PRX-T133', duration: 30, staffId: 'owner' }], 'Пилинг PRX-T113'],
  ]) {
    const { f, entry } = fixture({ services });
    f.answer({ text: query });
    assert.equal(entry().data.serviceChosen, false);
    assert.throws(() => f.answer({ text: 'да' }), { status: 400 });
    assert.equal(entry().data.serviceChosen, false);
    noSave(f);
  }
});