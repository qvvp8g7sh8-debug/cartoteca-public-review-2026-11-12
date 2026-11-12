const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const { appointmentContext } = require('../src/server/modules/assistant/actions/availability-context.cjs');
const { safeContinuationContext } = require('../src/server/modules/assistant/dialogue/continuation/continuation-contract.cjs');
const { servicePickerOperation } = require('../src/server/modules/assistant/dialogue/dialogue-service-picker.cjs');
const { isFastContinuation } = require('../src/server/modules/assistant/dialogue/dialogue-input.cjs');
const names = ['Миндальный', 'Молочный', 'Жёлтый', 'Кислотный', 'Гликолевый', 'Салициловый', 'Фруктовый'];
function fixture({ groups, services, role = 'owner', query = '' } = {}) {
  const f = dialogueFixture({ role });
  if (role === 'cosmetologist') f.members[0].role = role;
  const catalogGroups = groups || [
    { id: 'other', title: 'Другое' },
    { id: 'peels', title: 'Пилинги' },
    { id: 'care', title: 'Уход' },
    { id: 'empty', title: 'Неиспользуемая группа' },
  ];
  f.c.platform.serviceGroups = () => ({ revision: 1, groups: catalogGroups });
  f.services.splice(0, f.services.length, ...(services || [
    ...names.map((name, index) => ({
      id: 'peel-' + index, name: name + ' пилинг', duration: 30 + index * 5,
      staffId: 'owner', category: 'peels',
    })),
    { id: 'care', name: 'Уход за лицом', duration: 60, staffId: 'owner', category: 'care' },
  ]));
  f.changed();
  const start = (serviceQuery = query) => f.start({
    query: 'Анна Семёнова', serviceQuery, date: day, time: '10:00',
  });
  return { f, groups: catalogGroups, start,
    entry: () => f.flow.get(f.c, f.member, f.state, f.result.dialogue.id) };
}
const labels = (result) => result.dialogue.options.map((row) => row.label);
const control = (result, label) => result.dialogue.controls?.find((row) => row.label === label);
const chooseLabel = (f, name) => f.answer({ choice: f.result.dialogue.options.find((row) => row.label === name).id }).result;
function noSave(f) { assert.ok(f.patients.every((patient) => patient.appointments.length === 0)); }
function fillFirstPage(f) {
  f.services.splice(5, 0, ...Array.from({ length: 19 }, (_, index) => ({
    id: 'extra-' + index, name: 'Дополнительный пилинг ' + index, duration: 30,
    staffId: 'owner', category: 'peels',
  })));
}

test('one trusted read projects category optionally and does not invent missing metadata', () => {
  const { f } = fixture();
  const store = f.c.tenantStore('org'), read = store.readServices;
  let reads = 0;
  store.readServices = () => { reads++; return read(); };
  const withCategory = appointmentContext(f.c);
  assert.equal(reads, 1);
  assert.deepEqual(withCategory.services[0], {
    id: 'peel-0', name: 'Миндальный пилинг', duration: 30, staffId: 'owner', category: 'peels',
  });
  delete f.services[0].category;
  const without = appointmentContext(f.c);
  assert.deepEqual(without.services[0], {
    id: 'peel-0', name: 'Миндальный пилинг', duration: 30, staffId: 'owner',
  });
});

test('unnamed service shows only nonempty real categories; category voice stays local and paginated service reaches a ready form', () => {
  const { f, start, entry } = fixture();
  fillFirstPage(f);
  const first = start();
  assert.equal(first.dialogue.step, 'service');
  assert.deepEqual(labels(first), ['Пилинги', 'Уход']);
  assert.equal(first.dialogue.prompt, 'Выберите категорию или услугу.');
  assert.ok(first.dialogue.options.every((row) => !['peels', 'care'].includes(row.id)));
  assert.equal(isFastContinuation('пилинги', entry(), f.clock), true);
  const peels = f.answer({ text: 'пилинги' }).result;
  assert.equal(peels.dialogue.options.length, 24);
  assert.ok(labels(peels).every((name) => /пилинг/u.test(name)));
  assert.ok(control(peels, 'Показать ещё'));
  const more = f.answer({ text: 'другие' }).result;
  assert.deepEqual(labels(more), ['Салициловый пилинг · 55 мин', 'Фруктовый пилинг · 60 мин']);
  assert.ok(control(more, 'К началу списка'));
  assert.equal(entry().data.date, day);
  assert.equal(entry().data.time, '10:00');
  const ready = chooseLabel(f, 'Фруктовый пилинг · 60 мин');
  assert.equal(ready.dialogue.step, 'review');
  assert.equal(entry().data.service.id, 'peel-6');
  assert.equal(entry().data.duration, 60);
  const form = f.answer({ text: 'открой форму' }).result;
  assert.equal(form.action.type, 'prepareAppointment');
  assert.deepEqual(form.action.serviceIds, ['peel-6']);
  noSave(f);
});

test('one populated category pages catalog services and never offers a manual omission', () => {
  const s = fixture();
  s.f.services.splice(-1);
  fillFirstPage(s.f);
  const first = s.start();
  assert.equal(first.dialogue.prompt, 'Выберите услугу.');
  assert.equal(first.dialogue.options.length, 24);
  assert.ok(first.dialogue.options.every((row) => !/Категории|Пилинги/u.test(row.label)));
  assert.equal(isFastContinuation('покажи ещё', s.entry(), s.f.clock), true);
  const next = s.f.answer({ text: 'покажи ещё' }).result;
  assert.equal(next.dialogue.options.length, 2);
  assert.equal(next.dialogue.options[0].label, 'Салициловый пилинг · 55 мин');
  const tail = labels(next);
  s.f.answer({ text: 'другие' });
  assert.deepEqual(labels(s.f.result), tail);
  assert.match(s.f.result.text, /^Других услуг нет\./u);
  s.f.answer({ text: 'к началу списка' });
  assert.deepEqual(labels(s.f.result), labels(first));
  const before = structuredClone(s.entry().data);
  for (const text of ['без услуги', 'без каталога', 'уточню в форме']) {
    const stillMissing = s.f.answer({ text }).result;
    assert.equal(stillMissing.dialogue.step, 'service');
    assert.match(stillMissing.text, /^Назовите услугу\./u);
    assert.equal(s.entry().data.serviceChosen, false);
    assert.equal(s.entry().data.service, null);
    assert.equal(s.entry().data.patient.id, before.patient.id);
    assert.equal(s.entry().data.date, before.date);
    assert.equal(s.entry().data.time, before.time);
    assert.ok([...stillMissing.dialogue.options, ...(stillMissing.dialogue.controls || [])]
      .every((row) => !/Без услуги|уточню в форме/u.test(row.label)));
  }
  noSave(s.f);
});

test('large category sets are bounded, other maps legacy IDs to its real title, and category pages stay reversible', () => {
  const groups = [{ id: 'other', title: 'Другое' }, ...Array.from({ length: 26 }, (_, index) => ({ id: 'g-' + index, title: 'Группа ' + index }))];
  const services = groups.slice(1).map((group, index) => ({
    id: 's-' + index, name: 'Услуга ' + index, duration: 30, staffId: 'owner', category: group.id,
  }));
  services.push({ id: 'legacy', name: 'Старая услуга', duration: 45, staffId: 'owner', category: 'unknown-raw-id' });
  const { f, start } = fixture({ groups, services });
  const first = start();
  assert.deepEqual(labels(first), ['Другое', ...Array.from({ length: 23 }, (_, index) => 'Группа ' + index)]);
  assert.doesNotMatch(JSON.stringify(first), /unknown-raw-id/u);
  const next = f.answer({ text: 'ещё' }).result;
  assert.deepEqual(labels(next), ['Группа 23', 'Группа 24', 'Группа 25']);
  const servicesPage = f.answer({ text: 'группа 25' }).result;
  assert.deepEqual(labels(servicesPage), ['Услуга 25 · 30 мин']);
  f.answer({ text: 'другие категории' });
  assert.deepEqual(labels(f.result), labels(first));
  noSave(f);
});

test('named service first uses strict bounded matches and groups only a broad result', () => {
  const s = fixture();
  s.f.services.push({ id: 'care-peel', name: 'Пилинг комбинированный', duration: 75, staffId: 'owner', category: 'care' });
  const first = s.start('пилинг');
  assert.deepEqual(labels(first), ['Пилинги', 'Уход']);
  chooseLabel(s.f, 'Уход');
  assert.ok(labels(s.f.result).includes('Пилинг комбинированный · 75 мин'));
  assert.match(JSON.stringify(s.f.result.dialogue.options), /Уход за лицом/u);
  s.start('Миндальный пилинг');
  assert.equal(s.f.result.dialogue.step, 'review');
  assert.equal(s.entry().data.service.id, 'peel-0');
  noSave(s.f);
});

test('strict search with at most five results does not force categories or expose unrelated services', () => {
  const s = fixture();
  s.f.services.splice(3, 4);
  const result = s.start('пилинг');
  assert.deepEqual(labels(result), ['Миндальный пилинг · 30 мин', 'Молочный пилинг · 35 мин', 'Жёлтый пилинг · 40 мин']);
  assert.equal(result.dialogue.prompt, 'Выберите услугу.');
  assert.doesNotMatch(JSON.stringify(result.dialogue.options), /Уход за лицом/u);
  noSave(s.f);
});

test('approximate suggestions retain strict overflow/numeric boundaries and browsing is an explicit action', () => {
  const s = fixture();
  const overflow = s.start('пилниг');
  assert.equal(overflow.dialogue.options.length, 0);
  assert.equal(s.entry().data.serviceChosen, false);
  assert.ok(control(overflow, 'Все услуги'));
  const browse = s.f.answer({ text: 'все услуги' }).result;
  assert.deepEqual(labels(browse), ['Пилинги', 'Уход']);
  assert.equal(s.entry().data.serviceQuery, '');
  s.f.services.splice(0, s.f.services.length, { id: 'n', name: 'Пилинг 30%', duration: 30, staffId: 'owner', category: 'peels' });
  const numeric = s.start('пелинг 30%');
  assert.equal(numeric.dialogue.options.length, 0);
  assert.equal(s.entry().data.serviceChosen, false);
  noSave(s.f);
});

test('fresh name/duration/category and group-title checks reject stale opaque selections without mutating the dialogue', () => {
  for (const change of ['duration', 'category', 'name', 'groupTitle']) {
    const s = fixture();
    s.start();
    chooseLabel(s.f, 'Пилинги');
    const old = s.f.result, before = structuredClone(s.entry().data);
    if (change === 'groupTitle') s.groups[1].title = 'Новое название';
    else s.f.services[0][change] = change === 'duration' ? 90 : change === 'category' ? 'care' : 'Другая услуга';
    s.f.changed();
    assert.throws(() => s.f.answer({ choice: old.dialogue.options[0].id }), { status: 409 }, change);
    assert.deepEqual(s.entry().data, before, change);
    noSave(s.f);
  }
});

test('category/more choices are versioned, session-bound, replayable and do not accept real catalog IDs', () => {
  const { f, start } = fixture();
  fillFirstPage(f);
  const first = start();
  assert.throws(() => f.answer({ choice: 'peels' }), { status: 409 });
  const accepted = f.answer({ choice: first.dialogue.options[0].id });
  assert.deepEqual(f.flow.continueDialogue(f.c, accepted.body, f.state, f.member, f.clock), accepted.result);
  assert.throws(() => f.answer({ choice: first.dialogue.options[0].id }), { status: 409 });
  const oldSession = f.c.current.sessionId;
  f.c.current.sessionId = 'other-session';
  assert.throws(() => f.answer({ choice: control(f.result, 'Показать ещё').id }), { status: 409 });
  f.c.current.sessionId = oldSession;
  noSave(f);
});

test('base continuation context omits catalog names and identifiers', () => {
  const s = fixture();
  s.start();
  const first = safeContinuationContext(s.entry(), 'owner', s.f.clock);
  assert.equal(first.options.length, 2);
  assert.deepEqual(first.options, [{ number: 1, kind: 'serviceCategory' }, { number: 2, kind: 'serviceCategory' }]);
  assert.doesNotMatch(JSON.stringify(first), /Пилинги|Уход|Миндальный|peels|care/u);
  chooseLabel(s.f, 'Пилинги');
  const page = safeContinuationContext(s.entry(), 'owner', s.f.clock);
  assert.equal(page.options.length, 7);
  assert.ok(page.options.every((row) => row.kind === 'service' && Object.keys(row).length === 2));
  assert.doesNotMatch(JSON.stringify(page), /Миндальный|Молочный|peel-/u);
  assert.equal(servicePickerOperation(s.entry(), 'пили'), null);
  noSave(s.f);
});

test('every booking role sees only categories of its accessible selected specialist', () => {
  for (const role of ['owner', 'salon_admin', 'cosmetologist']) {
    const s = fixture({ role });
    s.f.members.push({ accountId: 'other', displayName: 'Другой специалист', role: 'cosmetologist', status: 'active' });
    s.f.services.push({ id: 'other-only', name: 'Чужая услуга', duration: 30, staffId: 'other', category: 'empty' });
    const result = s.start();
    assert.deepEqual(labels(result), ['Пилинги', 'Уход'], role);
    assert.doesNotMatch(JSON.stringify(result), /Чужая услуга|Неиспользуемая группа/u);
    noSave(s.f);
  }
});


test('more at the end offers existing categories instead of cycling already seen services', () => {
  const { f, start, entry } = fixture();
  fillFirstPage(f);
  start();
  chooseLabel(f, 'Пилинги');
  f.answer({ text: 'ещё' });
  assert.equal(f.result.dialogue.options[0].label, 'Салициловый пилинг · 55 мин');
  assert.ok(control(f.result, 'К началу списка'));
  const categories = f.answer({ text: 'ещё' }).result;
  assert.deepEqual(labels(categories), ['Пилинги', 'Уход']);
  assert.equal(categories.dialogue.prompt, 'Выберите категорию или услугу.');
  assert.equal(entry().data.serviceChosen, false);
  assert.equal(entry().data.date, day);
  assert.equal(entry().data.time, '10:00');
  noSave(f);
});
