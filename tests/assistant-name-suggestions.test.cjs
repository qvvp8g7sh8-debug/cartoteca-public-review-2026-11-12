const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createStorage } = require('../storage.cjs');
const {
  SUGGESTION_LIMITS, suggestionsOnlyQuery, nameSuggestionPlan, rankNameSuggestions,
} = require('../src/server/modules/assistant/language/names/name-suggestions.cjs');
const {
  resolveClient, suggestClientMatches, currentSuggestedClient,
} = require('../src/server/modules/assistant/language/names/name-directory.cjs');
const patient = (id, firstName, lastName, extra = {}) => ({
  id, firstName, lastName, middleName: '', name: firstName + ' ' + lastName,
  phone: '+79990000001', visits: [], appointments: [], createdBy: 'staff-a', ...extra,
});
const ranked = (rows, query) => rankNameSuggestions(rows, nameSuggestionPlan(query)).map(row => row.id);

test('split recognition predicate accepts bounded names and keeps negative commands out', () => {
  for (const text of ['не Полина', 'Не Олина.', 'не Неволина!'])
    assert.equal(suggestionsOnlyQuery(text), true, text);
  for (const text of [
    'не Анна', 'не сохрани', 'не сохраняй', 'не записывай', 'не открывай', 'не удаляй',
    'не отправляй', 'не отменяй', 'не записывайте', 'не откройте', 'не Полина завтра',
    '+79990000001', 'не ' + 'а'.repeat(49),
  ]) assert.equal(suggestionsOnlyQuery(text), false, text);
  for (const text of ['Ан', 'Анна', 'А. Неволина', '+79990000001', 'открой Неволину',
    'запиши Анну Неволину', 'не сохраняй'])
    assert.deepEqual(nameSuggestionPlan(text).queries, [], text);
  const plan = nameSuggestionPlan('не Полина');
  assert.ok(plan.queries.includes('олин'));
  assert.ok(plan.queries.length <= SUGGESTION_LIMITS.queries);
});

test('typos and split speech suggest complete names without selecting the exact negated tail', () => {
  const rows = [
    patient('target', 'Анна', 'Неволина'), patient('polina', 'Полина', 'Иванова'),
    patient('olina', 'Анна', 'Олина'), patient('ivanova', 'Анна', 'Иванова'),
  ];
  for (const text of ['Неполина', 'Не олина', 'не Полина', 'Анна Неполина', 'Неполиной Анной'])
    assert.ok(ranked(rows, text).includes('target'), text);
  assert.ok(!ranked(rows, 'не Полина').includes('polina'));
  assert.ok(!ranked(rows, 'не Олина').includes('olina'));
  assert.ok(!ranked(rows, 'не Иванова').includes('ivanova'));
  assert.deepEqual(ranked([patient('negated', 'Анна', 'Смирнова')], 'неСмирнова'), []);
  assert.equal(rows[0].lastName, 'Неволина');
});

test('small edit budgets do not reuse FIO tokens or fuzz short names and fragments', () => {
  const row = patient('target', 'Анна', 'Неволина');
  for (const text of ['Анна Анна Неполина', 'Жанна Неполина', 'Жанной Неполиной', 'Непол', 'Анна Непплима'])
    assert.deepEqual(ranked([row], text), [], text);
  assert.deepEqual(ranked([row], 'Анну Неполину'), ['target']);
  const long = patient('long', 'Мария', 'Александрова');
  assert.deepEqual(ranked([long], 'Александрава'), ['long']);
  assert.deepEqual(ranked([long], 'Алекскндрквк'), []);
});

function memoryFixture(rows, role = 'owner', accountId = 'owner') {
  const actor = { role, accountId, organizationId: 'synthetic-org', sessionId: 'synthetic-session' };
  const encode = value => Buffer.from(JSON.stringify(value));
  const calls = { transactions: 0, targeted: [], decoded: 0, assertions: 0 };
  const storage = {
    filename: 'synthetic-suggestions-' + randomUUID(), encode,
    get: () => 1,
    decode(value) { calls.decoded++; return JSON.parse(value.toString()); },
    read() { assert.fail('Suggestion lookup must not read clinical records'); },
    readPatient() { assert.fail('Suggestion lookup must not read a clinical record'); },
    transaction(callback, mode) {
      assert.equal(mode, 'DEFERRED'); calls.transactions++; return callback();
    },
    indexes: {
      summaryRows(current, ids) {
        if (ids) calls.targeted.push([...ids]);
        return rows.filter(row => (!ids || ids.includes(row.id)) &&
          (current.role !== 'cosmetologist' || row.createdBy === current.accountId))
          .map(row => ({ patient_id: row.id, value: encode(row) }));
      },
    },
  };
  const c = {
    current: actor, assertCurrent() { calls.assertions++; },
    tenantStore(org) { assert.equal(org, 'synthetic-org'); return storage; },
    platform: { organizationTimeZone: () => 'Europe/Moscow' },
  };
  return { c, storage, calls };
}

test('lookup returns at most five ranked summaries and never changes strict resolution', () => {
  const rows = Array.from({ length: 6 }, (_, index) =>
    patient('target-' + index, 'Анна', 'Неволина'));
  const f = memoryFixture(rows), before = JSON.stringify(rows);
  assert.deepEqual(resolveClient(f.c, 'Неполина').matches, []);
  const result = suggestClientMatches(f.c, 'Неполина');
  assert.equal(result.approximate, true);
  assert.equal(result.matches.length, SUGGESTION_LIMITS.results);
  assert.equal(result.overflow, true);
  assert.ok(result.matches.every(row => row.lastName === 'Неволина'));
  assert.equal(JSON.stringify(rows), before);
});

test('an overflowing weak anchor does not discard candidates found through stronger anchors', () => {
  const plan = nameSuggestionPlan('Неполина');
  const rows = [patient('target', 'Анна', 'Неволина'),
    ...Array.from({ length: 1200 }, (_, index) =>
      patient('other-' + index, 'Марина', 'Тестовая', {
        designation: index < 51 ? plan.queries[0] : 'ина',
      }))];
  const f = memoryFixture(rows);
  const result = suggestClientMatches(f.c, 'Неполина');
  assert.equal(result.overflow, true);
  assert.deepEqual(result.matches.map(row => row.id), ['target']);
  assert.ok(f.calls.transactions <= SUGGESTION_LIMITS.queries);
});


test('full FIO anchor sampling does not starve the misspelled surname behind a common patronymic', () => {
  const target = patient('target', 'Анна', 'Неволина', { middleName: 'Сергеевна' });
  target.name = 'Анна Сергеевна Неволина';
  const rows = [target, ...Array.from({ length: 51 }, (_, index) =>
    patient('other-' + index, 'Анна', 'Тестовая', { middleName: 'Сергеевна' }))];
  const plan = nameSuggestionPlan('Анна Сергеевна Неполина');
  assert.ok(plan.queries.includes('лина'));
  assert.ok(plan.queries.length <= SUGGESTION_LIMITS.queries);
  const f = memoryFixture(rows), result = suggestClientMatches(f.c, 'Анна Сергеевна Неполина');
  assert.deepEqual(result.matches.map(row => row.id), ['target']);
  assert.equal(result.overflow, true);
  assert.ok(f.calls.transactions <= SUGGESTION_LIMITS.queries);
});

test('candidate accumulation is bounded even when several distinct anchors are individually narrow', () => {
  const plan = nameSuggestionPlan('Неполина');
  const rows = plan.queries.slice(0, 6).flatMap((anchor, group) =>
    Array.from({ length: 40 }, (_, index) =>
      patient('group-' + group + '-' + index, 'Марина', 'Тестовая', { designation: anchor })));
  rows.unshift(patient('target', 'Анна', 'Неволина'));
  const f = memoryFixture(rows), result = suggestClientMatches(f.c, 'Неполина');
  assert.equal(result.overflow, true);
  assert.ok(result.matches.some(row => row.id === 'target'));
  assert.ok(result.matches.length <= SUGGESTION_LIMITS.results);
  assert.ok(f.calls.transactions <= SUGGESTION_LIMITS.queries);
});

test('selected suggestion rechecks only its targeted summary and fences a changed identity', () => {
  const rows = [patient('visible', 'Анна', 'Неволина'),
    patient('hidden', 'Анна', 'Неволина', { createdBy: 'staff-b' })];
  const f = memoryFixture(rows, 'cosmetologist', 'staff-a');
  assert.equal(currentSuggestedClient(f.c, 'visible').id, 'visible');
  assert.equal(currentSuggestedClient(f.c, 'hidden'), null);
  assert.deepEqual(f.calls.targeted, [['visible'], ['hidden']]);
  assert.equal(currentSuggestedClient(f.c, 'x'.repeat(129)), null);
  const original = f.storage.decode;
  f.storage.decode = value => {
    const decoded = original(value);
    f.c.current = { ...f.c.current, accountId: 'staff-b' };
    return decoded;
  };
  assert.throws(() => currentSuggestedClient(f.c, 'visible'), { status: 409 });
});

test('revoked or unsupported scopes fail before reading suggestions or selected summaries', () => {
  const f = memoryFixture([]);
  f.c.assertCurrent = () => { throw Object.assign(Error('Synthetic revoke'), { status: 403 }); };
  assert.throws(() => suggestClientMatches(f.c, 'Неполина'), { status: 403 });
  assert.throws(() => currentSuggestedClient(f.c, 'target'), { status: 403 });
  assert.equal(f.calls.transactions, 0);
  for (const current of [{ role: 'global_admin' }, { role: 'owner', globalAdmin: true },
    { role: 'owner', organizationId: '' }]) {
    const invalid = memoryFixture([]);
    invalid.c.current = { ...invalid.c.current, ...current };
    assert.throws(() => suggestClientMatches(invalid.c, 'Неполина'), { status: 403 });
    assert.throws(() => currentSuggestedClient(invalid.c, 'target'), { status: 403 });
    assert.equal(invalid.calls.transactions, 0);
  }
});

function realFixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, 'cartoteca-name-suggestions-'));
  const storage = createStorage(directory);
  t.after(() => {
    storage.close();
    assert.equal(path.dirname(directory), parent);
    assert.ok(path.basename(directory).startsWith('cartoteca-name-suggestions-'));
    assert.equal(fs.realpathSync(directory), directory);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const visible = patient('visible', 'Анна', 'Неволина'),
    hidden = patient('hidden', 'Анна', 'Неволина', { createdBy: 'staff-b' });
  storage.write({ revision: 0, services: [], patients: [visible, hidden] });
  const context = (role, accountId) => ({
    current: { role, accountId, organizationId: 'synthetic-org', sessionId: randomUUID() },
    assertCurrent() {},
    tenantStore(org) { assert.equal(org, 'synthetic-org'); return storage; },
    platform: { organizationTimeZone: () => 'Europe/Moscow' },
  });
  return { storage, context, visible, hidden };
}

test('real indexed ACL preserves namesake isolation and rechecks revocation after an offered suggestion', t => {
  const f = realFixture(t), before = f.storage.read();
  for (const [role, id] of [['owner', 'owner'], ['salon_admin', 'admin']])
    assert.deepEqual(suggestClientMatches(f.context(role, id), 'Неполина').matches
      .map(row => row.id).sort(), ['hidden', 'visible']);
  const employee = f.context('cosmetologist', 'staff-a');
  assert.deepEqual(suggestClientMatches(employee, 'не Полина').matches.map(row => row.id), ['visible']);
  assert.equal(currentSuggestedClient(employee, 'hidden'), null);
  assert.deepEqual(f.storage.read(), before);
  const changed = f.storage.read();
  changed.patients.find(row => row.id === 'visible').createdBy = 'staff-b';
  f.storage.write(changed);
  assert.equal(currentSuggestedClient(employee, 'visible'), null);
});

test('split-name predicate never reroutes known safety actions, infinitives or polite commands', () => {
  for (const verb of [
    'оплати', 'оплатить', 'оплатите', 'оплачивай', 'выполни', 'выполнить', 'выполните',
    'запусти', 'запустить', 'запустите', 'включи', 'включить', 'включите',
    'выключи', 'выключить', 'создай', 'создайте', 'создать', 'добавь', 'добавить',
    'обнови', 'обновить', 'закрой', 'закрыть', 'закончи', 'закончить',
    'верни', 'вернуть', 'расскажи', 'рассказать', 'переключи', 'переключить',
    'поменяй', 'поменять', 'измени', 'изменить', 'исправь', 'исправить',
    'замени', 'заменить', 'сдвинь', 'сдвинуть', 'посмотри', 'посмотреть',
    'выйди', 'выйти', 'повтори', 'повторить',
  ]) {
    const text = 'не ' + verb;
    assert.equal(suggestionsOnlyQuery(text), false, text);
    assert.deepEqual(nameSuggestionPlan(text).queries, [], text);
  }
});


test('literal component edges are not displaced by pronunciation and ё alternatives in either FIO order', () => {
  for (const query of ['Анна Сергеевна Неполина', 'Неполина Анна Сергеевна']) {
    const plan = nameSuggestionPlan(query);
    assert.ok(plan.queries.includes('лина'), query);
    assert.ok(plan.queries.includes('серг'), query);
    assert.ok(plan.queries.length <= SUGGESTION_LIMITS.queries, query);
  }
  for (const query of ['Алена Игоревна Ухабистонова', 'Ухабистонова Игоревна Алена']) {
    const plan = nameSuggestionPlan(query);
    assert.ok(plan.queries.includes('алён'), query);
    assert.ok(plan.queries.length <= SUGGESTION_LIMITS.queries, query);
  }
});
