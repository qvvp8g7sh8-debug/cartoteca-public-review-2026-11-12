const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { nameForms, normalizeName } = require('../src/server/modules/assistant/language/names/name-forms.cjs');
const {
  LIMITS,
  matchesName,
  searchPlan,
} = require('../src/server/modules/assistant/language/names/name-matching.cjs');
const { resolveClient } = require('../src/server/modules/assistant/language/names/name-directory.cjs');
const { handoff, staffFor } = require('../src/server/modules/assistant/actions/actions.cjs');
const rules = { policy: { commands: { calendar: true, clients: true, prepareAppointment: true } } };
function patient(firstName, lastName, middleName = '', extra = {}) {
  return {
    id: randomUUID(),
    firstName,
    lastName,
    middleName,
    name: [firstName, middleName, lastName].filter(Boolean).join(' '),
    appointments: [],
    ...extra,
  };
}
function fixture(patients, actor = { role: 'owner', accountId: 'owner', organizationId: 'org' }) {
  let reads = 0;
  const encode = (value) => Buffer.from(JSON.stringify(value));
  const storage = {
    filename: 'synthetic-name-directory-' + randomUUID(),
    encode,
    decode: (value) => JSON.parse(value.toString()),
    get: () => 1,
    transaction(callback) {
      reads++;
      return callback();
    },
    indexes: {
      summaryRows(current) {
        assert.equal(current, actor);
        return patients
          .filter((row) => current.role !== 'cosmetologist' || row.createdBy === current.accountId)
          .map((row) => ({ patient_id: row.id, value: encode(row) }));
      },
    },
  };
  const members = [
    { accountId: actor.accountId, displayName: 'Анна Иванова', role: 'owner', status: 'active' },
  ];
  const c = {
    current: actor,
    assertCurrent() {},
    platform: { organizationTimeZone: () => 'Europe/Moscow', workspaceMembers: () => members },
    tenantStore(organizationId) {
      assert.equal(organizationId, actor.organizationId);
      return storage;
    },
  };
  return { c, members, reads: () => reads };
}
test('name aliases preserve complete tokens and spelling stays untouched', () => {
  const row = patient('Анна', 'Семёнова', 'Петровна');
  assert.equal(normalizeName('  АННА\u00a0Семёнова '), 'анна семенова');
  assert.equal(matchesName(row, 'Семенову Анну'), true);
  assert.equal(matchesName(row, 'Анн'), false);
  assert.equal(matchesName(patient('Жанна', 'Иванова'), 'Анна'), false);
  assert.equal(matchesName(row, 'Анна Анна'), false);
  assert.equal(row.lastName, 'Семёнова');
});
test('productive first, middle and surname cases use known stored nominatives', () => {
  const row = patient('Дмитрий', 'Орлов', 'Андреевич');
  for (const query of [
    'Орлову Дмитрию Андреевичу',
    'Дмитрия Орлова',
    'Дмитрием Андреевичем Орловым',
  ])
    assert.equal(matchesName(row, query), true, query);
  assert.ok(nameForms('Павел', 'first').includes('павлу'));
  assert.ok(nameForms('Лев', 'first').includes('льва'));
  assert.ok(nameForms('Любовь', 'first').includes('любови'));
});
test('compound surnames keep both parts and unknown exceptions stay exact', () => {
  const row = patient('Анна', 'Салтыкова-Щедрина', 'Игоревна');
  assert.equal(matchesName(row, 'Анне Салтыковой-Щедриной'), true);
  assert.equal(matchesName(row, 'Анна Салтыкова\u2011Щедрина'), true);
  assert.equal(matchesName(row, 'Щедрина'), false);
  assert.equal(matchesName(patient('Анна', 'Иванова-Белая'), 'Иванову-Белую'), true);
  for (const lastName of ['Шевченко', 'Черных', 'Долгих', 'Дюма']) {
    assert.equal(matchesName(patient('Вера', lastName), lastName), true);
    assert.equal(matchesName(patient('Вера', lastName), lastName + 'у'), false);
  }
  assert.equal(matchesName(patient('Вера', 'Ким'), 'Кима'), false);
  assert.equal(matchesName(patient('Павел', 'Ким'), 'Кима'), true);
});
test('undeclared nicknames, transliteration, initials, typos and legacy ambiguous FIO never infer a person', () => {
  const row = patient('Александр', 'Иванов', 'Иванович');
  for (const query of ['Сашка Иванов', 'Aleksandr Ivanov', 'А. Иванов', 'Александер Иванов'])
    assert.equal(matchesName(row, query), false, query);
  assert.equal(matchesName({ name: 'Иванов Иван Иванович' }, 'Иван Иванов'), true);
  assert.equal(matchesName({ name: 'Иванов Иван Иванович' }, 'Иванову Ивану'), false);
});
test('directory resolves supported surface forms and returns an effective UI search', () => {
  const row = patient('Анна', 'Иванова', 'Сергеевна');
  const f = fixture([row]);
  const result = handoff(f.c, { intent: 'clients', query: 'Иванову Анну' }, rules, {
    date: '2026-10-15',
  });
  assert.deepEqual(result.action, { type: 'clients', query: row.name });
  assert.ok(f.reads() <= LIMITS.queries);
});
test('literal female surname never hides a second male oblique match', () => {
  const female = patient('Анна', 'Иванова'),
    male = patient('Сергей', 'Иванов');
  const f = fixture([female, male]);
  const result = handoff(f.c, { intent: 'prepareAppointment', query: 'Иванова' }, rules, {});
  assert.equal(result.action.type, 'clients');
  assert.equal(result.action.patientId, undefined);
  assert.equal(resolveClient(f.c, 'Иванова').matches.length, 2);
});
test('only name fields confirm identities; designation matches stay manual', () => {
  const f = fixture([
    patient('Жанна', 'Орлова', '', { designation: 'Анна Иванова', notes: 'Иванову' }),
  ]);
  assert.equal(resolveClient(f.c, 'Анна Иванова').matches.length, 0);
  const result = handoff(f.c, { intent: 'prepareAppointment', query: 'Анна Иванова' }, rules, {});
  assert.equal(result.action.type, 'clients');
});
test('exact complete phones and existing Russian aliases work without partial guesses', () => {
  const row = patient('Анна', 'Иванова', '', { phone: '+7 (999) 123-45-67' });
  const f = fixture([row]);
  for (const query of ['+7 999 123 45 67', '89991234567'])
    assert.equal(resolveClient(f.c, query).matches[0]?.id, row.id, query);
  assert.equal(resolveClient(f.c, '1234567').matches.length, 0);
  assert.equal(resolveClient(f.c, '+8 999 123 45 67').matches.length, 0);
});
test('appointment preparation retains manual save contract and never looks outside ACL scope', () => {
  const actor = { role: 'cosmetologist', accountId: 'staff', organizationId: 'org' };
  const visible = patient('Анна', 'Иванова', '', { createdBy: 'staff' });
  const hidden = patient('Анна', 'Иванова', '', { createdBy: 'other' });
  const f = fixture([visible, hidden], actor);
  const result = handoff(
    f.c,
    {
      intent: 'prepareAppointment',
      query: 'Анну Иванову',
      date: '2026-10-20',
      time: '14:30',
      duration: 30,
    },
    rules,
    {},
  );
  assert.deepEqual(result.action, {
    type: 'prepareAppointment',
    patientId: visible.id,
    date: '2026-10-20',
    time: '14:30',
    staffId: 'staff',
    duration: 30,
  });
  assert.match(result.text, /^Подготовил форму записи\.$/u);
});
test('staff uses the same complete-token forms and existing membership restrictions', () => {
  const f = fixture([]);
  f.members.push({
    accountId: 'second',
    displayName: 'Жанна Иванова',
    role: 'cosmetologist',
    status: 'active',
  });
  assert.equal(staffFor(f.c, 'Анне Ивановой'), 'owner');
  assert.equal(staffFor(f.c, 'Анн'), null);
  f.members.push({
    accountId: 'third',
    displayName: 'Анна Иванова',
    role: 'cosmetologist',
    status: 'active',
  });
  assert.equal(staffFor(f.c, 'Анна Иванова'), null);
  f.c.current.role = 'cosmetologist';
  assert.equal(staffFor(f.c, 'Анна Иванова'), 'owner');
});
test('broad candidate sets and overflowing alias plans cannot select a client', () => {
  const f = fixture(
    Array.from({ length: LIMITS.perQuery + 1 }, (_, index) => patient('Анна', 'Тестовая' + index)),
  );
  const result = resolveClient(f.c, 'Анна');
  assert.equal(result.overflow, true);
  assert.ok(f.reads() <= LIMITS.queries);
  const plan = searchPlan('Сергеевича');
  assert.ok(plan.overflow || plan.queries.length <= LIMITS.queries);
});

test('yo aliases and shared full phones retain all people for manual selection', () => {
  const f = fixture([patient('Анна', 'Семёнова'), patient('Анна', 'Семенова')]);
  const result = handoff(f.c, { intent: 'prepareAppointment', query: 'Семенова' }, rules, {});
  assert.equal(result.action.type, 'clients');
  assert.equal(result.action.query, '');
  const phone = '+7 (999) 111-22-33';
  const shared = fixture([
    patient('Анна', 'Иванова', '', { phone }),
    patient('Ольга', 'Петрова', '', { phone }),
  ]);
  const choice = handoff(shared.c, { intent: 'prepareAppointment', query: phone }, rules, {});
  assert.equal(choice.action.type, 'clients');
  assert.equal(choice.action.query, '');
});
