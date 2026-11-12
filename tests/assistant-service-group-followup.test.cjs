const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const {
  serviceGroupOperation,
} = require('../src/server/modules/assistant/dialogue/dialogue-service-group.cjs');
const { spokenReply } = require('../src/server/modules/assistant/speech/spoken-reply.cjs');
const {
  continuationExample,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-contract.cjs');
function fixture({
  collision = false,
  duplicate = false,
  role = 'owner',
  title = 'Орбиталь Кварц',
  query = 'Непонятное название',
  serviceCount = 7,
} = {}) {
  const f = dialogueFixture({ role });
  const groups = [
    { id: 'other', title: 'Другое' },
    { id: 'a', title },
    { id: 'b', title: duplicate ? title : 'Сфера 17' },
  ];
  f.c.platform.serviceGroups = () => ({ revision: 1, groups });
  f.services.splice(
    0,
    f.services.length,
    ...Array.from({ length: serviceCount }, (_, index) => ({
      id: 'a-' + index,
      name: 'Альфа ' + index,
      duration: 30,
      staffId: 'owner',
      category: 'a',
    })),
    {
      id: 'b-0',
      name: collision ? title : 'Бета 0',
      duration: 60,
      staffId: 'owner',
      category: 'b',
    },
  );
  f.changed();
  f.start({
    query: 'Анна Семёнова',
    serviceQuery: query,
    date: day,
    time: '10:00',
    duration: 45,
  });
  const entry = () => f.flow.get(f.c, f.member, f.state, f.result.dialogue.id);
  return { f, groups, entry };
}
const labels = (result) => result.dialogue.options.map((row) => row.label);
test('a spoken match stays in its group until accepted and rejection keeps the same list', () => {
  const { f, entry } = fixture();
  const page = f.answer({ text: 'Покажи группу Орбиталь Кварц' }).result;
  const proposal = f.answer({ text: 'Альфа 3' }).result;
  assert.equal(proposal.dialogue.serviceGroupTitle, 'Орбиталь Кварц');
  assert.deepEqual(labels(proposal), labels(page));
  assert.equal(entry().data.serviceChosen, false);
  assert.match(proposal.dialogue.prompt, /Альфа 3/u);
  assert.equal(spokenReply(proposal), proposal.dialogue.prompt);
  const declined = f.answer({ text: 'нет' }).result;
  assert.equal(declined.dialogue.serviceGroupTitle, 'Орбиталь Кварц');
  assert.deepEqual(labels(declined), labels(page));
  const outside = f.answer({ text: 'Бета 0' }).result;
  assert.equal(outside.dialogue.serviceGroupTitle, 'Орбиталь Кварц');
  assert.equal(outside.dialogue.serviceConfirmation, undefined);
  f.answer({ text: 'Альфа 2' });
  f.answer({ text: 'да' });
  assert.equal(entry().data.service.id, 'a-2');
});

test('the model can propose a catalog title from the selected group for confirmation', () => {
  const { f, entry } = fixture();
  const page = f.answer({ text: 'Покажи группу Орбиталь Кварц' }).result;
  const body = {
    dialogueId: page.dialogue.id,
    dialogueVersion: page.dialogue.version,
    text: 'Хочу вариант для подготовки к процедуре',
  };
  const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
  assert.ok(snapshot.context.serviceCandidates.includes('Альфа 3'));
  assert.ok(!snapshot.context.serviceCandidates.includes('Бета 0'));
  const proposal = f.flow.applyModelTurn(
    f.c,
    body,
    f.state,
    f.member,
    f.clock,
    continuationExample({ operation: 'patch', fields: { service: 'Альфа 3' } }),
    snapshot,
  );
  assert.equal(proposal.dialogue.serviceConfirmation, true);
  assert.match(proposal.dialogue.prompt, /Альфа 3/u);
  assert.deepEqual(labels(proposal), labels(page));
  assert.equal(entry().data.serviceChosen, false);
});

test('unknown service can switch to a fresh named group, narrate its page and preserve all known fields', () => {
  const { f, entry } = fixture({ serviceCount: 26 });
  const before = structuredClone(entry().data);
  const page = f.answer({
    text: 'Не помню точное название услуги, покажи группу Орбиталь Кварц',
  }).result;
  assert.equal(page.dialogue.step, 'service');
  assert.equal(page.dialogue.serviceGroupTitle, 'Орбиталь Кварц');
  assert.equal(page.dialogue.speechQuestion, undefined);
  assert.equal(page.dialogue.options.length, 24);
  assert.ok(labels(page).every((label) => label.startsWith('Альфа')));
  assert.doesNotMatch(JSON.stringify(page.dialogue.options), /Бета/u);
  assert.match(spokenReply(page), /Альфа 0/u);
  assert.match(spokenReply(page), /Альфа 4/u);
  for (const key of ['patient', 'staff', 'date', 'time', 'duration', 'durationSource'])
    assert.deepEqual(entry().data[key], before[key]);
  assert.equal(entry().data.serviceQuery, '');
  assert.equal(entry().data.serviceChosen, false);
  const next = f.answer({ text: 'покажи ещё' }).result;
  assert.deepEqual(labels(next), ['Альфа 24 · 30 мин', 'Альфа 25 · 30 мин']);
  assert.match(spokenReply(next), /Альфа 25/u);
  assert.equal(f.patients[0].appointments.length, 0);
});

test('full category titles accept outer quotes, case endings and explicit group words locally', () => {
  for (const [title, text, query] of [
    ['Аппаратные услуги', 'Покажи аппаратные услуги', ''],
    ['Аппаратные услуги', 'Покажи группу аппаратные услуги', ''],
    ['Аппаратные услуги', 'Покажи категорию аппаратные услуги', 'Неизвестная услуга'],
    ['Аппаратные услуги', 'Покажи группу аппаратных услуг', 'Неизвестная услуга'],
    ['Аппаратные услуги', 'Покажи категорию «Аппаратные услуги»', 'Неизвестная услуга'],
    ['Аппаратные услуги', 'Покажи «Аппаратные услуги»', 'Неизвестная услуга'],
    ['Аппаратные услуги', 'Категорию аппаратные услуги', 'Неизвестная услуга'],
    ['Аппаратные услуги', 'Группу аппаратных услуг', 'Неизвестная услуга'],
    ['Лазерные процедуры', 'Покажи группу “лазерных процедур”', 'Неизвестная услуга'],
    ['Косметические процедуры', 'Покажи группу косметических процедур', 'Неизвестная услуга'],
  ]) {
    const { f, entry } = fixture({ title, query });
    const before = structuredClone(entry().data);
    assert.equal(
      f.flow.prepareModelTurn(
        f.c,
        {
          dialogueId: f.result.dialogue.id,
          dialogueVersion: f.result.dialogue.version,
          text,
        },
        f.state,
        f.member,
        f.clock,
      ),
      null,
      text,
    );
    const page = f.answer({ text }).result;
    assert.equal(page.dialogue.serviceGroupTitle, title, text);
    assert.equal(page.action, null);
    assert.ok(labels(page).every((label) => label.startsWith('Альфа')));
    assert.match(spokenReply(page), /Альфа 0/u);
    for (const key of ['patient', 'staff', 'date', 'time', 'duration', 'durationSource'])
      assert.deepEqual(entry().data[key], before[key], text + ' ' + key);
    assert.equal(f.patients[0].appointments.length, 0);
  }
});

test('literal category match wins over case variants and a category title cannot replace an exact service', () => {
  const title = 'Аппаратные услуги';
  const exact = fixture({ title });
  exact.groups[1].title = 'Аппаратных услуг';
  exact.groups[2].title = title;
  const literal = exact.f.answer({ text: 'Покажи группу аппаратных услуг' }).result;
  assert.equal(literal.dialogue.serviceGroupTitle, 'Аппаратных услуг');
  assert.ok(labels(literal).every((label) => label.startsWith('Альфа')));
  const collision = fixture({ title, collision: true });
  assert.equal(
    serviceGroupOperation(collision.f.c, collision.entry(), 'Покажи «Аппаратные услуги»', true),
    null,
  );
  collision.f.answer({ text: title });
  assert.equal(collision.entry().data.service.id, 'b-0');
  const explicit = fixture({ title, collision: true });
  const page = explicit.f.answer({ text: 'Покажи группу аппаратных услуг' }).result;
  assert.equal(page.dialogue.serviceGroupTitle, title);
  assert.equal(explicit.entry().data.service, null);
});

test('a nominal role can be part of a literal category title while explicit show still names the role', () => {
  const title = 'Аппаратные услуги';
  const named = 'Группа ' + title;
  const { f, groups } = fixture({ title, query: '' });
  groups[2].title = named;
  f.changed();
  f.start({ query: 'Анна Семёнова', date: day, time: '11:00' });
  assert.ok(labels(f.result).includes(named));
  const literal = f.answer({ text: named }).result;
  assert.equal(literal.dialogue.serviceGroupTitle, named);
  assert.deepEqual(labels(literal), ['Бета 0 · 60 мин']);
  const explicit = f.answer({ text: 'Покажи группу аппаратные услуги' }).result;
  assert.equal(explicit.dialogue.serviceGroupTitle, title);
  assert.ok(labels(explicit).every((label) => label.startsWith('Альфа')));
});

test('literal quoted and unquoted catalog titles stay distinguishable', () => {
  const title = 'Аппаратные услуги';
  const quoted = '«' + title + '»';
  const { f, groups } = fixture({ title });
  groups[2].title = quoted;
  f.changed();
  const raw = f.answer({ text: 'Покажи группу аппаратные услуги' }).result;
  assert.equal(raw.dialogue.serviceGroupTitle, title);
  assert.ok(labels(raw).every((label) => label.startsWith('Альфа')));
  const quotedReply = f.answer({ text: 'Покажи группу «аппаратные услуги»' }).result;
  assert.equal(quotedReply.dialogue.serviceGroupTitle, quoted);
  assert.deepEqual(labels(quotedReply), ['Бета 0 · 60 мин']);
});

test('a duplicate in the eligible catalog stays ambiguous even when only one is on the current page', () => {
  const title = 'Аппаратные услуги';
  const { f, groups, entry } = fixture({ title, query: '' });
  for (let index = 0; index < 22; index++) {
    groups.push({ id: 'f-' + index, title: 'Дополнительная группа ' + index });
    f.services.push({
      id: 'f-' + index,
      name: 'Дополнительная услуга ' + index,
      staffId: 'owner',
      duration: 30,
      category: 'f-' + index,
    });
  }
  groups.push({ id: 'second', title });
  f.services.push({
    id: 'second',
    name: 'Вторая услуга',
    staffId: 'owner',
    duration: 30,
    category: 'second',
  });
  f.changed();
  f.start({ query: 'Анна Семёнова', date: day, time: '11:00' });
  assert.equal(labels(f.result).filter((label) => label === title).length, 1);
  const page = f.answer({ text: title }).result;
  assert.match(page.dialogue.prompt, /несколько групп/u);
  assert.equal(page.dialogue.serviceGroupTitle, undefined);
  assert.equal(entry().data.service, null);
  const declined = f.answer({ text: 'Покажи группу аппаратных услуг' }).result;
  assert.match(declined.dialogue.prompt, /несколько групп/u);
});

test('declined category lookup excludes empty or foreign catalogs and preserves qualifiers', () => {
  for (const mode of ['empty', 'foreign']) {
    const { f, entry } = fixture({ title: 'Аппаратные услуги' });
    if (mode === 'foreign') {
      f.members.push({
        accountId: 'foreign',
        displayName: 'Другой',
        role: 'cosmetologist',
        status: 'active',
      });
      for (const service of f.services) if (service.category === 'a') service.staffId = 'foreign';
    } else {
      f.services.splice(0, 7);
    }
    f.changed();
    const page = f.answer({ text: 'Покажи группу аппаратных услуг' }).result;
    assert.equal(page.dialogue.serviceGroupTitle, undefined);
    assert.doesNotMatch(JSON.stringify(page.dialogue.options), /Аппаратн|Альфа/u);
    assert.equal(entry().data.service, null);
    assert.equal(f.patients[0].appointments.length, 0);
  }
  const { f, entry } = fixture({ title: 'Аппаратные услуги 2' });
  for (const query of ['аппаратных услуг', 'аппаратных услуг 3', 'услуг аппаратных 2'])
    assert.equal(serviceGroupOperation(f.c, entry(), 'Покажи ' + query, true), null);
  const page = f.answer({ text: 'Покажи группу аппаратных услуг 2' }).result;
  assert.equal(page.dialogue.serviceGroupTitle, 'Аппаратные услуги 2');
});

test('category lookup requires the service step and a selected specialist', () => {
  const { f } = fixture({ title: 'Аппаратные услуги' });
  const text = 'Покажи группу аппаратных услуг';
  const staff = f.start({ query: 'Анна Семёнова', staffQuery: 'Неизвестный специалист' });
  const entry = f.flow.get(f.c, f.member, f.state, staff.dialogue.id);
  assert.equal(staff.dialogue.step, 'staff');
  assert.equal(entry.data.staff, null);
  assert.equal(serviceGroupOperation(f.c, entry, text, true), null);
  assert.equal(serviceGroupOperation(f.c, { ...entry, step: 'service' }, text, true), null);
});
test('bare group after a failed service and explicit group/service collisions retain their source roles', () => {
  const plain = fixture();
  assert.equal(
    plain.f.answer({ text: 'Орбиталь Кварц' }).result.dialogue.serviceGroupTitle,
    'Орбиталь Кварц',
  );
  for (const text of [
    'Не помню название, группа Орбиталь Кварц',
    'Не помню название, Орбиталь Кварц',
  ]) {
    const memory = fixture();
    assert.equal(memory.f.answer({ text }).result.dialogue.serviceGroupTitle, 'Орбиталь Кварц');
  }
  const exact = fixture({ collision: true });
  exact.f.answer({ text: 'Орбиталь Кварц' });
  assert.equal(exact.entry().data.service.id, 'b-0');
  const grouped = fixture({ collision: true });
  const response = grouped.f.answer({ text: 'Покажи группу Орбиталь Кварц' }).result;
  assert.equal(grouped.entry().data.service, null);
  assert.ok(labels(response).every((label) => label.startsWith('Альфа')));
  assert.equal(
    serviceGroupOperation(grouped.f.c, grouped.entry(), 'Покажи Орбиталь Кварц', true),
    null,
  );
  const imperative = fixture();
  imperative.f.services.push({
    id: 'literal-command',
    name: 'Покажи Орбиталь Кварц',
    duration: 30,
    staffId: 'owner',
    category: 'b',
  });
  imperative.f.changed();
  imperative.f.answer({ text: 'Покажи Орбиталь Кварц' });
  assert.equal(imperative.entry().data.service.id, 'literal-command');
});
test('unknown and duplicate groups clarify against fresh available groups without changing client identity', () => {
  for (const [duplicate, text] of [
    [false, 'Покажи группу Неизвестная'],
    [true, 'Покажи группу Орбиталь Кварц'],
  ]) {
    const { f, entry } = fixture({ duplicate });
    const person = entry().data.patient.id;
    const response = f.answer({ text }).result;
    assert.equal(entry().data.patient.id, person);
    assert.equal(entry().data.date, day);
    assert.equal(response.dialogue.serviceList, 'groups');
    assert.equal(response.dialogue.serviceGroupTitle, undefined);
    assert.doesNotMatch(response.text, /клиент.*не найден/iu);
    assert.equal(response.dialogue.options.length, 2);
    assert.ok(labels(response).includes('Орбиталь Кварц'));
    assert.match(spokenReply(response), /Орбиталь Кварц/u);
    assert.equal(entry().data.service, null);
  }
});
test('unrelated requests, ordinal controls and uncovered clauses are not group instructions', () => {
  const { f, entry } = fixture();
  for (const value of [
    'Покажи карточку Попова',
    'Не помню название, покажи карточку Попова',
    'Покажи Альфа 0',
    'Покажи группу Орбиталь Кварц и отмени запись',
    'Покажи группу Орбиталь Кварц если будет свободно',
    'первый',
    '2',
    'нет',
    'покажи все услуги',
    'покажи ещё',
    'Не помню название, неизвестная группа',
  ]) {
    assert.equal(serviceGroupOperation(f.c, entry(), value, true), null, value);
    assert.equal(serviceGroupOperation(f.c, entry(), value, false), null, value);
  }
});
test('group lookup excludes another staff catalog and stale selection/version remains rejected', () => {
  const { f, entry, groups } = fixture();
  groups.push({ id: 'foreign', title: 'Чужая группа' });
  f.members.push({
    accountId: 'foreign',
    displayName: 'Другой',
    role: 'cosmetologist',
    status: 'active',
  });
  f.services.push({
    id: 'foreign',
    name: 'Чужая услуга',
    duration: 30,
    staffId: 'foreign',
    category: 'foreign',
  });
  f.changed();
  const before = f.result;
  const reply = f.answer({ text: 'Покажи группу Чужая группа' });
  assert.doesNotMatch(JSON.stringify(reply.result.dialogue.options), /Чужая/u);
  assert.throws(
    () =>
      f.flow.continueDialogue(
        f.c,
        {
          dialogueId: reply.body.dialogueId,
          dialogueVersion: before.dialogue.version,
          policyVersion: f.state.revision,
          text: 'Покажи группу Орбиталь Кварц',
        },
        f.state,
        f.member,
        f.clock,
      ),
    { status: 409 },
  );
  const replay = f.flow.continueDialogue(f.c, reply.body, f.state, f.member, f.clock);
  assert.deepEqual(replay, reply.result);
  f.members[0].status = 'suspended';
  f.changed();
  assert.throws(() => serviceGroupOperation(f.c, entry(), 'Покажи группу Орбиталь Кварц', true), {
    status: 409,
  });
});
