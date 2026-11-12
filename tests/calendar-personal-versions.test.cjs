const test = require('node:test');
const assert = require('node:assert/strict');
const { createCipheriv, createDecipheriv } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  createPersonalFeedState,
  updatePersonalVersions,
} = require('../src/server/modules/calendar/personal-feed-state.cjs');

const event = (staffId = 'a', id = 'personal-' + staffId) => ({
  id,
  staffId,
  date: '2026-10-16',
  time: '12:00',
  duration: 60,
  notes: 'Synthetic note',
});
const profile = () => ({
  timeZone: 'Europe/Moscow',
  calendarPersonalVersions: { a: 'a-1', b: 'b-1', c: 'c-1' },
  unrelatedSetting: 'preserved',
});

function fixture(t, options) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(
    'CREATE TABLE organizations(id TEXT PRIMARY KEY, value BLOB); CREATE TABLE synthetic_audit(id INTEGER)',
  );
  const key = Buffer.alloc(32, 7);
  let serial = 0,
    decryptions = 0;
  function seal(value) {
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32BE(++serial, 8);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
  }
  function open(value) {
    decryptions++;
    const data = Buffer.from(value);
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'),
    );
  }
  function write(value, id = 'org') {
    db.prepare(
      'INSERT INTO organizations(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
    ).run(id, seal(value));
  }
  const context = { db, open };
  const state = createPersonalFeedState(context, options);
  const metadata = (accountId = 'a', organizationId = 'org') =>
    state.metadata({ accountId, organizationId });
  return { db, write, metadata, context, decryptions: () => decryptions };
}

test('unchanged events and note edits retain personal occupancy versions and the original profile', () => {
  const original = profile();
  const before = [event('a'), event('b')];
  assert.equal(
    updatePersonalVersions(
      original,
      before,
      before.map((value) => ({ ...value })),
    ),
    original,
  );
  const after = before.map((value) => ({
    ...value,
    notes: 'Another synthetic note',
    title: 'A renamed personal event',
  }));
  assert.equal(updatePersonalVersions(original, before, after), original);
  assert.deepEqual(original, profile());
});

for (const [field, value] of [
  ['date', '2026-10-17'],
  ['time', '14:30'],
  ['duration', 90],
]) {
  test('personal ' + field + ' changes invalidate only the affected employee', () => {
    const original = profile();
    const before = [event('a'), event('b')];
    const next = updatePersonalVersions(original, before, [
      { ...before[0], [field]: value },
      before[1],
    ]);
    assert.notEqual(next.calendarPersonalVersions.a, original.calendarPersonalVersions.a);
    assert.equal(next.calendarPersonalVersions.b, original.calendarPersonalVersions.b);
    assert.equal(next.calendarPersonalVersions.c, original.calendarPersonalVersions.c);
    assert.equal(next.unrelatedSetting, original.unrelatedSetting);
    assert.deepEqual(original, profile());
  });
}

test('moving personal occupancy between employees invalidates both, leaving all others intact', () => {
  const original = profile();
  const before = [event('a')];
  const next = updatePersonalVersions(original, before, [{ ...before[0], staffId: 'b' }]);
  assert.notEqual(next.calendarPersonalVersions.a, original.calendarPersonalVersions.a);
  assert.notEqual(next.calendarPersonalVersions.b, original.calendarPersonalVersions.b);
  assert.equal(next.calendarPersonalVersions.c, original.calendarPersonalVersions.c);
  assert.deepEqual(before, [event('a')]);
});

test('creation, deletion and recreation change the staff version even when the collection is empty', () => {
  const initial = { timeZone: 'Europe/Moscow' };
  const created = updatePersonalVersions(initial, [], [event('a')]);
  assert.ok(created.calendarPersonalVersions.a);
  const deleted = updatePersonalVersions(created, [event('a')], []);
  assert.notEqual(deleted.calendarPersonalVersions.a, created.calendarPersonalVersions.a);
  const restored = updatePersonalVersions(deleted, [], [event('a')]);
  assert.notEqual(restored.calendarPersonalVersions.a, deleted.calendarPersonalVersions.a);
  assert.equal(initial.calendarPersonalVersions, undefined);
});

test('metadata reuses the encrypted profile stamp across employees and unrelated platform writes', (t) => {
  const { write, metadata, decryptions, db } = fixture(t);
  write({ ...profile(), personalEvents: { revision: 1, events: [event('a'), event('b')] } });
  assert.deepEqual(metadata('a'), { zone: 'Europe/Moscow', personalVersion: 'a-1' });
  assert.equal(decryptions(), 1);
  assert.deepEqual(metadata('b'), { zone: 'Europe/Moscow', personalVersion: 'b-1' });
  db.exec('INSERT INTO synthetic_audit VALUES(1)');
  metadata('a');
  assert.equal(decryptions(), 1);
  assert.deepEqual(metadata('unknown'), { zone: 'Europe/Moscow', personalVersion: '' });
  assert.equal(decryptions(), 1);
});

test('reencrypting note edits refreshes metadata once without changing occupancy versions', (t) => {
  const { write, metadata, decryptions } = fixture(t);
  const before = [event('a'), event('b')];
  const original = { ...profile(), personalEvents: { revision: 1, events: before } };
  write(original);
  const first = metadata('a');
  const after = before.map((value) => ({ ...value, notes: 'Changed synthetic note' }));
  write({
    ...updatePersonalVersions(original, before, after),
    personalEvents: { revision: 2, events: after },
  });
  assert.deepEqual(metadata('a'), first);
  assert.deepEqual(metadata('b'), { zone: 'Europe/Moscow', personalVersion: 'b-1' });
  assert.equal(decryptions(), 2);
});

test('a new encrypted profile exposes only the changed staff version and observes time zone edits', (t) => {
  const { write, metadata, decryptions } = fixture(t);
  const original = profile();
  const before = [event('a'), event('b')];
  write(original);
  const unaffected = metadata('a');
  const after = [before[0], { ...before[1], time: '15:00' }];
  const edited = updatePersonalVersions(original, before, after);
  write(edited);
  assert.deepEqual(metadata('a'), unaffected);
  assert.equal(metadata('b').personalVersion, edited.calendarPersonalVersions.b);
  assert.notEqual(metadata('b').personalVersion, 'b-1');
  assert.equal(decryptions(), 2);
  write({ ...edited, timeZone: 'Asia/Yerevan' });
  assert.deepEqual(metadata('a'), { zone: 'Asia/Yerevan', personalVersion: 'a-1' });
  assert.equal(decryptions(), 3);
});

test('independent workers see persisted personal versions and encrypted profile changes', (t) => {
  const { write, metadata, context, decryptions } = fixture(t);
  const secondWorker = createPersonalFeedState(context);
  const current = { organizationId: 'org', accountId: 'a' };
  const original = profile();
  write(original);
  assert.deepEqual(metadata('a'), secondWorker.metadata(current));
  const changed = updatePersonalVersions(original, [event('a')], []);
  write(changed);
  assert.deepEqual(metadata('a'), secondWorker.metadata(current));
  assert.equal(metadata('a').personalVersion, changed.calendarPersonalVersions.a);
  assert.equal(decryptions(), 4);
});

test('metadata LRU limits organizations and touches hits before eviction', (t) => {
  const { write, metadata, decryptions } = fixture(t, { maxEntries: 2 });
  for (const org of ['one', 'two', 'three']) write(profile(), org);
  metadata('a', 'one');
  metadata('a', 'two');
  metadata('a', 'one');
  metadata('a', 'three');
  assert.equal(decryptions(), 3);
  metadata('a', 'one');
  assert.equal(decryptions(), 3);
  metadata('a', 'two');
  assert.equal(decryptions(), 4);
});

test('a profile exceeding the byte budget remains readable without being retained', (t) => {
  const { write, metadata, decryptions } = fixture(t, { maxBytes: 1 });
  write(profile());
  assert.equal(metadata('a').personalVersion, 'a-1');
  assert.equal(metadata('a').personalVersion, 'a-1');
  assert.equal(decryptions(), 2);
});

test('legacy profiles use the default zone and no version; missing organizations are denied', (t) => {
  const { write, metadata, db } = fixture(t);
  write({});
  assert.deepEqual(metadata('a'), { zone: 'Europe/Moscow', personalVersion: '' });
  db.exec("DELETE FROM organizations WHERE id='org'");
  assert.throws(() => metadata('a'), { status: 404 });
});
