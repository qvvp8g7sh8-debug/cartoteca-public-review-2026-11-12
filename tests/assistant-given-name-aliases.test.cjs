const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  nameForms,
  nameGender,
  firstNameKind,
  inverseForms,
} = require('../src/server/modules/assistant/language/names/name-forms.cjs');
const {
  matchesName,
  searchPlan,
  LIMITS,
} = require('../src/server/modules/assistant/language/names/name-matching.cjs');
const { resolveClient } = require('../src/server/modules/assistant/language/names/name-directory.cjs');
const { handoff, staffFor } = require('../src/server/modules/assistant/actions/actions.cjs');
const patient = (firstName, lastName = 'Неволина', extra = {}) => ({
  id: randomUUID(),
  firstName,
  lastName,
  middleName: '',
  name: firstName + ' ' + lastName,
  phone: '+79990000000',
  appointments: [],
  createdBy: 'staff',
  ...extra,
});
function fixture(rows, role = 'owner') {
  const current = { role, accountId: 'staff', organizationId: 'synthetic-given-org' };
  let reads = 0;
  const encode = (value) => Buffer.from(JSON.stringify(value));
  const storage = {
    filename: 'synthetic-given-names-' + randomUUID(),
    encode,
    decode: (value) => JSON.parse(value.toString()),
    get: () => 1,
    transaction(callback) {
      reads++;
      return callback();
    },
    read() {
      assert.fail('Name aliases must not load clinical records');
    },
    readPatient() {
      assert.fail('Name aliases must not load a patient card');
    },
    indexes: {
      summaryRows(actor) {
        assert.equal(actor, current);
        return rows
          .filter((row) => actor.role !== 'cosmetologist' || row.createdBy === actor.accountId)
          .map((row) => ({ patient_id: row.id, value: encode(row) }));
      },
    },
  };
  const members = [
    { accountId: 'staff', displayName: 'Юлия Неволина', role: 'owner', status: 'active' },
  ];
  return {
    reads: () => reads,
    members,
    c: {
      current,
      assertCurrent() {},
      tenantStore(org) {
        assert.equal(org, current.organizationId);
        return storage;
      },
      platform: { workspaceMembers: () => members, organizationTimeZone: () => 'Europe/Moscow' },
    },
  };
}
const rules = { policy: { commands: { clients: true, calendar: true, prepareAppointment: true } } };

test('declared short first names and their cases match stored formal names without rewriting them', () => {
  const examples = [
    ['Юлия', ['Юля', 'Юлю', 'Юле', 'Юлей', 'Юлею']],
    ['Ольга', ['Оля', 'Олю']],
    ['Екатерина', ['Катя', 'Катю']],
    ['Елена', ['Лена', 'Лену']],
    ['Анастасия', ['Настя', 'Настю']],
    ['Анна', ['Аня', 'Аню']],
    ['Ирина', ['Ира', 'Иру']],
    ['Мария', ['Маша', 'Машу']],
    ['Надежда', ['Надя', 'Надю']],
    ['Любовь', ['Люба', 'Любу']],
    ['Алексей', ['Лёша', 'Лешу', 'Алёшу']],
    ['Дмитрий', ['Дима', 'Диму']],
    ['Павел', ['Паша', 'Пашу']],
    ['Михаил', ['Миша', 'Мишу']],
    ['Николай', ['Коля', 'Колю']],
    ['Сергей', ['Серёжа', 'Сережу']],
  ];
  for (const [canonical, queries] of examples) {
    const row = patient(canonical),
      before = structuredClone(row);
    for (const query of queries)
      assert.equal(matchesName(row, query), true, canonical + ' / ' + query);
    assert.deepEqual(row, before);
  }
  assert.ok(nameForms('Юлия', 'first').includes('юлю'));
  assert.ok(inverseForms('Юлю').includes('юлия'));
  assert.equal(firstNameKind('юля'), true);
});
test('a full short-name query identifies the formal client in a bounded directory of more than a hundred synthetic clients', () => {
  const target = patient('Юлия');
  const rows = [
    ...Array.from({ length: 120 }, (_, index) => patient('Нина', 'Тестовая' + index)),
    target,
  ];
  const f = fixture(rows),
    before = JSON.stringify(rows);
  for (const query of ['Юлю', 'Юлю Неволину', 'Неволиной Юле']) {
    const result = resolveClient(f.c, query);
    assert.equal(result.overflow, false, query);
    assert.deepEqual(
      result.matches.map((row) => row.id),
      [target.id],
      query,
    );
  }
  assert.ok(f.reads() <= 3 * LIMITS.queries);
  assert.equal(JSON.stringify(rows), before);
  const result = handoff(f.c, { intent: 'prepareAppointment', query: 'Юлю Неволину' }, rules, {});
  assert.equal(result.action.patientId, target.id);
  assert.match(result.text, /^Подготовил форму записи\.$/u);
  assert.ok(rows.every((row) => row.appointments.length === 0));
});
test('shared short names preserve ambiguity across formal sexes alternate spellings and a literally stored short name', () => {
  for (const [query, canonicals] of [
    ['Сашу', ['Александр', 'Александра', 'Саша']],
    ['Женю', ['Евгений', 'Евгения', 'Женя']],
    ['Валю', ['Валентин', 'Валентина', 'Валя']],
    ['Наташу', ['Наталья', 'Наталия', 'Наташа']],
    ['Соню', ['Софья', 'София', 'Соня']],
  ]) {
    const rows = canonicals.map((firstName) => patient(firstName));
    assert.ok(
      rows.every((row) => matchesName(row, query)),
      query,
    );
    const f = fixture(rows),
      result = resolveClient(f.c, query);
    assert.ok(result.overflow || result.matches.length > 1, query);
    const action = handoff(f.c, { intent: 'prepareAppointment', query }, rules, {}).action;
    assert.equal(action.type, 'clients', query);
    assert.equal(action.patientId, undefined, query);
    assert.equal(
      matchesName(patient(canonicals[1]), canonicals[0]),
      false,
      query + ' must not merge formal names',
    );
  }
});
test('two clients with the same expanded given name still need identity clarification and employee ACL never adds a hidden match', () => {
  const own = patient('Юлия'),
    hidden = patient('Юлия', 'Другая', { createdBy: 'foreign-staff' });
  const owner = fixture([own, hidden]),
    employee = fixture([own, hidden], 'cosmetologist');
  assert.equal(resolveClient(owner.c, 'Юлю').matches.length, 2);
  assert.deepEqual(
    resolveClient(owner.c, 'Юлю Неволину').matches.map((row) => row.id),
    [own.id],
  );
  assert.deepEqual(
    resolveClient(employee.c, 'Юлю').matches.map((row) => row.id),
    [own.id],
  );
  assert.equal(resolveClient(employee.c, 'Юлю Другую').matches.length, 0);
});
test('literal short first names can be found by formal inflections but canonical names do not merge through a common abbreviation', () => {
  const literal = patient('Юля'),
    f = fixture([literal]);
  assert.equal(resolveClient(f.c, 'Юлию Неволину').matches[0]?.id, literal.id);
  assert.equal(matchesName(patient('Александра'), 'Александр'), false);
  assert.equal(matchesName(patient('Софья'), 'София'), false);
  assert.equal(matchesName(patient('Наталья'), 'Наталия'), false);
});
test('aliases apply only to the first-name component and do not add typo transliteration initial or legacy FIO guesses', () => {
  const row = patient('Юлия');
  for (const query of ['Юл', 'Юлька', 'Julia', 'Ю. Неволина', 'Юля Юля'])
    assert.equal(matchesName(row, query), false, query);
  assert.equal(matchesName(patient('Александр', 'Иванов'), 'Сашка Иванов'), false);
  assert.equal(matchesName(patient('Нина', 'Юлия'), 'Юлю'), false);
  assert.equal(matchesName(patient('Нина', 'Иванова', { middleName: 'Юлия' }), 'Юлю'), false);
  assert.equal(matchesName({ name: 'Юлия Ивановна Неволина' }, 'Юлю Неволину'), false);
});
test('known aliases retain the eight-query plan by removing only literal substring-covered candidate reads', () => {
  for (const firstName of ['Елена', 'Лена', 'Алексей', 'Лёша', 'Сергей', 'Серёжа', 'Юлия', 'Юлю']) {
    const plan = searchPlan(firstName);
    assert.equal(plan.overflow, false, firstName);
    assert.ok(plan.queries.length > 0 && plan.queries.length <= LIMITS.queries, firstName);
    assert.ok(
      plan.queries.every(
        (query) =>
          !plan.queries.some((other) => other.length < query.length && query.includes(other)),
      ),
      firstName,
    );
  }
  for (const [canonical, query] of [
    ['Елена', 'Лену'],
    ['Алексей', 'Лёшу'],
    ['Сергей', 'Серёжу'],
  ]) {
    const row = patient(canonical),
      f = fixture([row]);
    assert.equal(resolveClient(f.c, query).matches[0]?.id, row.id, query);
    assert.ok(f.reads() <= LIMITS.queries);
  }
});
test('staff aliases use the same fresh eligible membership filter and ambiguous short-name genders do not invent a sex', () => {
  const f = fixture([]);
  assert.equal(staffFor(f.c, 'Юле Неволиной'), 'staff');
  f.members.push({
    accountId: 'other',
    displayName: 'Юлия Другая',
    role: 'cosmetologist',
    status: 'active',
  });
  assert.equal(staffFor(f.c, 'Юля'), null);
  f.c.current.role = 'cosmetologist';
  assert.equal(staffFor(f.c, 'Юле Другой'), null);
  assert.equal(staffFor(f.c, 'Юле Неволиной'), 'staff');
  assert.equal(nameGender('Юля'), 'female');
  assert.equal(nameGender('Паша'), 'male');
  assert.equal(nameGender('Саша'), '');
  assert.equal(nameGender('Саша', 'Сергеевна'), 'female');
  assert.equal(matchesName(patient('Юля', 'Ким'), 'Юлю Кима'), false);
});

test('a known patronymic gender filters reverse unisex aliases without losing the raw short-name ambiguity', () => {
  const female = patient('Саша', 'Ким', { middleName: 'Сергеевна' });
  const male = patient('Саша', 'Ким', { middleName: 'Сергеевич' });
  assert.equal(matchesName(female, 'Александр Ким'), false);
  assert.equal(matchesName(male, 'Александр Ким'), true);
  assert.equal(matchesName(female, 'Александрой Ким'), true);
  assert.equal(matchesName(male, 'Александрой Ким'), false);
  const f = fixture([female, male]);
  assert.deepEqual(
    resolveClient(f.c, 'Александр Ким').matches.map((row) => row.id),
    [male.id],
  );
  assert.deepEqual(
    resolveClient(f.c, 'Александрой Ким').matches.map((row) => row.id),
    [female.id],
  );
  assert.equal(resolveClient(f.c, 'Сашу Ким').matches.length, 2);
  assert.ok([female, male].every((row) => row.appointments.length === 0));
});
test('known-gender Женя forms never auto-resolve through the opposite canonical while a short name of unknown gender retains both hypotheses', () => {
  const female = patient('Женя', 'Ким', { middleName: 'Олеговна' });
  const male = patient('Женя', 'Ким', { middleName: 'Олегович' });
  const f = fixture([female, male]);
  assert.deepEqual(
    resolveClient(f.c, 'Евгением Ким').matches.map((row) => row.id),
    [male.id],
  );
  assert.deepEqual(
    resolveClient(f.c, 'Евгенией Ким').matches.map((row) => row.id),
    [female.id],
  );
  assert.equal(matchesName(female, 'Евгений'), false);
  assert.equal(matchesName(male, 'Евгенией'), false);
  assert.equal(resolveClient(f.c, 'Женю Ким').matches.length, 2);
  const unknown = patient('Саша', 'Ким');
  assert.equal(nameGender(unknown.firstName, unknown.middleName), '');
  assert.equal(matchesName(unknown, 'Александр Ким'), true);
  assert.equal(matchesName(unknown, 'Александрой Ким'), true);
  assert.equal(matchesName(patient('Александра', 'Ким'), 'Александр Ким'), false);
});

test('an already ambiguous formal-name page does not hide a literal short-name client from later bounded alias queries in any role', () => {
  for (const role of ['owner', 'salon_admin', 'cosmetologist']) {
    const canonical = Array.from({ length: 9 }, (_, index) => patient('Юлия', 'Тестовая' + index));
    const literal = patient('Юля', 'Соколова'),
      rows = [...canonical, literal],
      before = JSON.stringify(rows);
    const f = fixture(rows, role);
    assert.equal(matchesName(literal, 'Юлия'), true);
    const result = resolveClient(f.c, 'Юлия');
    assert.equal(result.overflow, false, role);
    assert.equal(result.matches.length, 10, role);
    assert.deepEqual(
      new Set(result.matches.map((row) => row.id)),
      new Set(rows.map((row) => row.id)),
      role,
    );
    assert.ok(f.reads() <= LIMITS.queries, role);
    assert.equal(JSON.stringify(rows), before);
    const handoffResult = handoff(f.c, { intent: 'prepareAppointment', query: 'Юлия' }, rules, {});
    assert.equal(handoffResult.action.type, 'clients');
    assert.equal(handoffResult.action.patientId, undefined);
    assert.ok(rows.every((row) => row.appointments.length === 0));
  }
});
test('later alias queries preserve per-page overflow and never expose a colleague literal short-name client', () => {
  const canonical = [patient('Юлия', 'Первая'), patient('Юлия', 'Вторая')];
  const overflowRows = [
    ...canonical,
    ...Array.from({ length: LIMITS.perQuery + 1 }, (_, index) =>
      patient('Юля', 'Тестовая' + index),
    ),
  ];
  const full = fixture(overflowRows),
    overflow = resolveClient(full.c, 'Юлия');
  assert.equal(overflow.overflow, true);
  assert.ok(full.reads() <= LIMITS.queries);
  const handoffResult = handoff(full.c, { intent: 'prepareAppointment', query: 'Юлия' }, rules, {});
  assert.equal(handoffResult.action.type, 'clients');
  assert.equal(handoffResult.action.query, '');
  assert.equal(handoffResult.action.patientId, undefined);
  const hidden = patient('Юля', 'Скрытая', { createdBy: 'other-staff' });
  const employee = fixture([...canonical, hidden], 'cosmetologist'),
    visible = resolveClient(employee.c, 'Юлия');
  assert.equal(visible.overflow, false);
  assert.deepEqual(
    new Set(visible.matches.map((row) => row.id)),
    new Set(canonical.map((row) => row.id)),
  );
  assert.equal(
    visible.matches.some((row) => row.id === hidden.id),
    false,
  );
  assert.ok(employee.reads() <= LIMITS.queries);
  assert.ok(overflowRows.every((row) => row.appointments.length === 0));
});
