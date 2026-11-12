const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createWorkspace } = require('../src/server/modules/workspace/service.cjs');
const { createFutureDays } = require('../src/server/modules/schedules/future-days.cjs');
const { hasOpenWorkingDays } = require('../src/server/modules/booking/schedule-state.cjs');
const { createBookingPublication } = require('../src/server/modules/booking/publication.cjs');

const org = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const now = Date.parse('2040-01-01T00:00:00Z');

function fixture(t, durable = false) {
  const folder = durable ? fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-pub-identities-')) : null;
  const filename = folder ? path.join(folder, 'fixture.sqlite') : ':memory:';
  if (folder)
    fs.writeFileSync(path.join(folder, 'synthetic-marker.json'), '{"syntheticOnly":true}', { flag: 'wx' });
  const db = new DatabaseSync(filename);
  let peer;
  t.after(() => {
    peer?.close();
    db.close();
    if (!folder) return;
    assert.equal(fs.realpathSync(folder), path.resolve(folder));
    assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'synthetic-marker.json'))).syntheticOnly, true);
    for (const name of ['fixture.sqlite', 'fixture.sqlite-journal', 'fixture.sqlite-wal', 'fixture.sqlite-shm', 'synthetic-marker.json']) {
      const file = path.join(folder, name);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(folder);
  });
  db.exec(`
    CREATE TABLE accounts(id TEXT PRIMARY KEY,status TEXT,value BLOB);
    CREATE TABLE memberships(organization_id TEXT,account_id TEXT,role TEXT,status TEXT,created_at INTEGER,
      PRIMARY KEY(organization_id,account_id));
    CREATE TABLE organizations(id TEXT PRIMARY KEY,status TEXT,value BLOB);
    CREATE TABLE work_schedule_days(organization_id TEXT,staff_id TEXT,date TEXT,value BLOB,
      PRIMARY KEY(organization_id,staff_id,date));
  `);
  const key = crypto.randomBytes(32), accountPayloads = new Set();
  const counters = { accountOpens: 0, dayOpens: 0 };
  function seal(value) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    const encrypted = Buffer.concat([iv, cipher.getAuthTag(), body]);
    if (value.kind === 'account') accountPayloads.add(encrypted.toString('hex'));
    return encrypted;
  }
  function open(value) {
    const encrypted = Buffer.from(value);
    if (accountPayloads.has(encrypted.toString('hex'))) counters.accountOpens++;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12));
    decipher.setAuthTag(encrypted.subarray(12, 28));
    const decoded = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]));
    if (decoded.kind === 'day') counters.dayOpens++;
    return decoded;
  }
  const staff = {}, audits = [];
  const context = {
    db, seal, open,
    organization: (id) => open(db.prepare('SELECT value FROM organizations WHERE id=?').get(id).value),
    organizationTimeZone: () => 'Europe/Moscow',
    onlineBooking: { settings: () => ({ staff }) },
    audit: (...args) => audits.push(args),
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const result = fn(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  Object.assign(context, createWorkspace(context));
  context.workSchedules = { futureDays: createFutureDays(context) };
  for (const id of [org, other])
    db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(id, 'active', seal({
      name: 'Synthetic organization', bookingPublication: { enabled: true, revision: 1 },
    }));
  let sequence = 0;
  function member(id, values = {}, connection = db) {
    connection.prepare('INSERT OR IGNORE INTO accounts VALUES(?,?,?)').run(
      id, values.accountStatus || 'active', seal({ kind: 'account', displayName: 'Synthetic ' + id }),
    );
    connection.prepare('INSERT OR REPLACE INTO memberships VALUES(?,?,?,?,?)').run(
      values.org || org, id, values.role || 'owner', values.status || 'active', values.created ?? ++sequence,
    );
  }
  function day(id, values = {}, connection = db) {
    connection.prepare('INSERT OR REPLACE INTO work_schedule_days VALUES(?,?,?,?)').run(
      values.org || org, id, values.date || '2040-01-02', seal({
        kind: 'day', status: values.status || 'working', intervals: values.intervals || [['09:00', '10:00']],
      }),
    );
  }
  const snapshot = () => [
    db.prepare('SELECT * FROM accounts ORDER BY id').all(),
    db.prepare('SELECT * FROM memberships ORDER BY organization_id,account_id').all(),
    db.prepare('SELECT * FROM organizations ORDER BY id').all(),
    db.prepare('SELECT * FROM work_schedule_days ORDER BY organization_id,staff_id,date').all(),
  ];
  function unchanged(fn) {
    const before = snapshot(), result = fn();
    assert.deepEqual(snapshot(), before, 'schedule/publication read must not mutate fixture');
    return result;
  }
  return {
    db, context, counters, staff, audits, member, day, seal, accountPayloads, unchanged,
    peer: () => { assert.ok(folder); return peer ||= new DatabaseSync(filename); },
    read: (id = org, time = now) => unchanged(() => hasOpenWorkingDays(context, id, time)),
  };
}

test('actual identity JOIN preserves membership order, role and both current status gates without opening profiles', (t) => {
  const f = fixture(t);
  f.member('owner', { created: 30 });
  f.member('employee', { role: 'cosmetologist', accountStatus: 'suspended', created: 10 });
  f.member('admin', { role: 'salon_admin', status: 'suspended', created: 20 });
  f.member('outside', { org: other, created: 0 });
  assert.deepEqual(f.context.workspaceIdentities(org), [
    { accountId: 'employee', role: 'cosmetologist', status: 'suspended' },
    { accountId: 'admin', role: 'salon_admin', status: 'suspended' },
    { accountId: 'owner', role: 'owner', status: 'active' },
  ]);
  assert.deepEqual(f.context.workspaceIdentities(org, 'owner'), [
    { accountId: 'owner', role: 'owner', status: 'active' },
  ]);
  assert.equal(f.counters.accountOpens, 0);
});

test('a future working day does not decrypt any account name, including unrelated organization members', (t) => {
  const f = fixture(t);
  f.member('owner');
  f.day('owner');
  for (let i = 0; i < 24; i++) f.member('not-performing-' + i, { role: 'viewer' });
  assert.equal(f.read(), true);
  assert.equal(f.counters.dayOpens, 1, 'actual encrypted schedule is still evaluated');
  assert.equal(f.counters.accountOpens, 0, 'existence of work hours does not consume account profiles');
});

test('an unused unreadable account profile cannot prevent identity-only schedule evaluation', (t) => {
  const f = fixture(t);
  f.member('owner');
  f.day('owner');
  const invalid = Buffer.alloc(32, 7);
  f.accountPayloads.add(invalid.toString('hex'));
  f.db.prepare('UPDATE accounts SET value=? WHERE id=?').run(invalid, 'owner');
  assert.equal(f.read(), true);
  assert.equal(f.counters.accountOpens, 0);
});

test('owner and cosmetologist hours count independently of online assignments; admin requires exact enabled=true', (t) => {
  for (const [role, enabled, expected] of [
    ['owner', false, true], ['cosmetologist', false, true], ['salon_admin', true, true],
    ['salon_admin', false, false], ['salon_admin', undefined, false],
    ['salon_admin', 'true', false], ['viewer', true, false],
  ]) {
    const f = fixture(t);
    f.member('performer', { role });
    f.staff.performer = { enabled };
    f.day('performer');
    assert.equal(f.read(), expected, role + '/' + enabled);
    assert.equal(f.counters.accountOpens, 0);
  }
});

test('another SQLite connection can suspend, reactivate, change role or remove a member between schedule reads', (t) => {
  const f = fixture(t, true), peer = f.peer();
  f.member('performer', { role: 'cosmetologist' });
  f.day('performer');
  assert.equal(f.read(), true);
  peer.prepare('UPDATE memberships SET status=? WHERE account_id=?').run('suspended', 'performer');
  assert.equal(f.read(), false);
  peer.prepare('UPDATE memberships SET status=? WHERE account_id=?').run('active', 'performer');
  peer.prepare('UPDATE accounts SET status=? WHERE id=?').run('suspended', 'performer');
  assert.equal(f.read(), false);
  peer.prepare('UPDATE accounts SET status=? WHERE id=?').run('active', 'performer');
  assert.equal(f.read(), true);
  peer.prepare('UPDATE memberships SET role=? WHERE account_id=?').run('salon_admin', 'performer');
  assert.equal(f.read(), false);
  f.staff.performer = { enabled: true };
  assert.equal(f.read(), true);
  f.day('performer', { status: 'closed', intervals: [] }, peer);
  assert.equal(f.read(), false);
  f.day('performer', {}, peer);
  assert.equal(f.read(), true);
  peer.prepare('DELETE FROM memberships WHERE account_id=?').run('performer');
  assert.equal(f.read(), false);
  f.member('performer', { role: 'owner' }, peer);
  assert.equal(f.read(), true);
  assert.equal(f.counters.accountOpens, 0);
});

test('an active membership or schedule in another organization cannot restore this organization schedule', (t) => {
  const f = fixture(t);
  f.member('shared', { status: 'suspended' });
  f.member('shared', { org: other });
  f.day('shared');
  f.day('shared', { org: other });
  assert.equal(f.read(org), false);
  assert.equal(f.read(other), true);
  f.member('ours');
  f.day('ours', { org: other });
  assert.equal(f.read(org), false);
  f.day('ours');
  assert.equal(f.read(org), true);
  assert.equal(f.counters.accountOpens, 0);
});

test('current schedule, organization closure and end-of-day timezone boundaries remain authoritative', (t) => {
  const f = fixture(t, true), peer = f.peer();
  f.member('owner');
  f.day('owner', { date: '2039-12-31' });
  f.day('owner', { date: '2040-01-01', intervals: [['00:00', '03:00']] });
  f.day('owner', { date: '2040-01-02', status: 'closed', intervals: [] });
  f.day('unrelated-account', { date: '2040-01-03' });
  assert.equal(f.read(), false, 'past, ended, closed and non-member hours do not count');
  f.day('owner', { date: '2040-01-01', intervals: [['03:00', '24:00']] });
  assert.equal(f.read(org, Date.parse('2040-01-01T20:59:59Z')), true);
  assert.equal(f.read(org, Date.parse('2040-01-01T21:00:00Z')), false);
  f.day('owner', { date: '2050-02-03' }, peer);
  f.day('organization', { date: '2050-02-03', status: 'closed', intervals: [] }, peer);
  const nextDay = Date.parse('2040-01-02T00:00:00Z');
  assert.equal(f.read(org, nextDay), false, 'fresh organization closure excludes a distant opened day');
  peer.prepare('DELETE FROM work_schedule_days WHERE organization_id=? AND staff_id=?').run(org, 'organization');
  assert.equal(f.read(org, nextDay), true, 'a distant explicitly opened day is not cut off by a horizon');
  assert.equal(f.counters.accountOpens, 0);
});

test('actual publication reconciliation keeps an opened organization enabled without writes or account decrypts', (t) => {
  const f = fixture(t);
  f.member('owner');
  f.day('owner');
  const publication = createBookingPublication(f.context);
  const result = f.unchanged(() => f.context.transaction(() => publication.reconcileInTransaction(org, now)));
  assert.equal(result.enabled, true);
  assert.equal(result.hasWorkingDays, true);
  assert.equal(result.revision, 1);
  assert.equal(f.audits.length, 0);
  assert.equal(f.counters.accountOpens, 0);
});
