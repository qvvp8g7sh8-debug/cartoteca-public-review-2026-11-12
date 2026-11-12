const test = require('node:test');
const assert = require('node:assert/strict');
const names = require('../src/shared/patient-names.cjs');
const originalText = names.patientSearchText;
let normalizations = 0;
// Capture actual text work in both directory consumers, before their destructured imports.
// No source rewrite, require-cache deletion, lookup substitute or retained result cache.
names.patientSearchText = (...args) => {
  normalizations++;
  return originalText(...args);
};
let dialogueFixture, resolveClient;
try {
  ({ dialogueFixture } = require('./helpers/assistant-dialogue-fixture.cjs'));
  ({ resolveClient } = require('../src/server/modules/assistant/language/names/name-directory.cjs'));
} finally {
  names.patientSearchText = originalText;
}
function person(id, firstName, lastName) {
  return { id, firstName, lastName, middleName: '', name: firstName + ' ' + lastName,
    phone: '', createdBy: 'owner', appointments: [] };
}
function fixture(role = 'owner') {
  const f = dialogueFixture({ role });
  if (role === 'cosmetologist') f.members[0].role = role;
  const given = ['Анна', 'Мария', 'Дмитрий', 'Вера', 'Елена', 'Павел'];
  const surnames = ['Петров', 'Соколов', 'Морозов', 'Кузнецов', 'Орлов', 'Фролов'];
  const target = person('target', 'Алексей', 'Иванов');
  f.patients.splice(0, f.patients.length, target,
    ...Array.from({ length: 50 }, (_, i) => [person('given-' + i, 'Алексей', surnames[i % 6]),
      person('surname-' + i, given[i % 6], 'Иванов')]).flat());
  f.changed();
  return Object.assign(f, { target, storage: f.c.tenantStore('org'),
    clinical: () => JSON.stringify([f.patients, f.services, f.busy]) });
}
function lookup(f, query = 'Алексей Иванов') {
  return resolveClient(f.c, query);
}
function ids(result) { return result.matches.map(row => row.id).sort(); }
function warm(f) {
  const before = normalizations;
  const result = lookup(f);
  assert.equal(result.overflow, false);
  assert.deepEqual(ids(result), ['target']);
  assert.equal(normalizations - before, 101, 'The first cold whole-name lookup normalizes each visible row once');
}

test('the cold whole-name query populates existing row text once and ten warm repeats do no text work', () => {
  const f = fixture(), before = f.clinical();
  warm(f);
  const warmed = normalizations;
  for (let i = 0; i < 10; i++) {
    const result = lookup(f);
    assert.equal(result.overflow, false);
    assert.deepEqual(ids(result), ['target']);
  }
  assert.equal(normalizations, warmed);
  assert.equal(f.clinical(), before);
});

test('rotating whole-name queries reuse the same authorized row text without a query-result cache', () => {
  const f = fixture(), before = f.clinical();
  warm(f);
  const warmed = normalizations;
  for (let i = 0; i < 20; i++) {
    const [first, last] = [['Алексей', 'Петров'], ['Алексей', 'Соколов'],
      ['Анна', 'Иванов'], ['Мария', 'Иванов']][i % 4];
    const expected = f.patients.filter(row => row.firstName === first && row.lastName === last)
      .map(row => row.id).sort();
    const result = lookup(f, first + ' ' + last);
    assert.equal(result.overflow, false);
    assert.deepEqual(ids(result), expected);
  }
  assert.equal(normalizations, warmed);
  assert.equal(f.clinical(), before);
});

test('a new authoritative revision with unchanged encoded rows reuses only their existing text', () => {
  const f = fixture();
  warm(f);
  const warmed = normalizations, revision = f.storage.get('revision', 0), before = f.clinical();
  f.changed();
  assert.ok(f.storage.get('revision', 0) > revision);
  assert.deepEqual(ids(lookup(f)), ['target']);
  assert.equal(normalizations, warmed);
  assert.equal(f.clinical(), before);
});

test('a renamed row at a new revision is normalized again while unchanged rows remain reused', () => {
  const f = fixture();
  warm(f);
  const warmed = normalizations;
  f.target.firstName = 'Владислав';
  f.target.name = 'Владислав Иванов';
  f.changed();
  const before = f.clinical();
  assert.deepEqual(lookup(f).matches, [], 'The previous full identity cannot survive the fresh revision');
  assert.deepEqual(ids(lookup(f, 'Владислав Иванов')), ['target']);
  assert.equal(normalizations - warmed, 1, 'Only the changed authoritative row needs new search text');
  assert.equal(f.clinical(), before);
});

test('the same path and revision with a fresh encode identity cannot reuse old decoded row text', () => {
  const f = fixture();
  warm(f);
  const warmed = normalizations;
  f.target.id = 'fresh-connection-target';
  const reopened = { ...f.storage, encode: value => Buffer.from(JSON.stringify(value)) };
  f.c.tenantStore = () => reopened;
  const before = f.clinical();
  assert.deepEqual(ids(lookup(f)), ['fresh-connection-target']);
  assert.equal(normalizations - warmed, 101, 'The existing directory invalidates every decoded row at a new key/connection identity');
  assert.equal(f.clinical(), before);
});

test('a warm row-text hit still requires a fresh active session before reading cached clinical identities', () => {
  const f = fixture();
  let active = true;
  const assertCurrent = f.c.assertCurrent;
  f.c.assertCurrent = () => {
    assertCurrent();
    if (!active) throw Object.assign(Error('Synthetic access revoked'), { status: 403 });
  };
  warm(f);
  const warmed = normalizations, before = f.clinical();
  active = false;
  assert.throws(() => lookup(f), error => error.status === 403);
  assert.equal(normalizations, warmed);
  assert.equal(f.clinical(), before);
});

test('a revised employee assignment removes the cached target without rebuilding unchanged visible text', () => {
  const f = fixture('cosmetologist');
  warm(f);
  const warmed = normalizations;
  f.target.createdBy = 'other-staff';
  f.changed();
  const before = f.clinical();
  assert.deepEqual(lookup(f).matches, []);
  assert.equal(normalizations, warmed, 'Unchanged authorized rows retain their existing text; the hidden row is not read');
  assert.equal(f.clinical(), before);
});

test('a different role/account scope uses newly filtered decoded rows rather than owner row objects', () => {
  const f = fixture();
  warm(f);
  const warmed = normalizations;
  f.target.createdBy = 'other-staff';
  f.changed();
  f.c.current.role = 'cosmetologist';
  f.members[0].role = 'cosmetologist';
  const before = f.clinical();
  assert.deepEqual(lookup(f).matches, []);
  assert.equal(normalizations - warmed, 100, 'Only the one hundred newly decoded authorized staff rows are normalized');
  assert.equal(f.clinical(), before);
});
