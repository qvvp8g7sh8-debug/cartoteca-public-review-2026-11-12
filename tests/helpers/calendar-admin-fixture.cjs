const assert = require('node:assert/strict');
const { createCipheriv, createDecipheriv } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  createCalendarSubscription,
} = require('../../src/server/modules/calendar/subscription.cjs');

// Everything in this fixture is synthetic and remains in one in-memory database.
function calendarAdminFixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE accounts(id TEXT PRIMARY KEY,value BLOB,status TEXT);
    CREATE TABLE organizations(id TEXT PRIMARY KEY,value BLOB,status TEXT);
    CREATE TABLE memberships(account_id TEXT,organization_id TEXT,role TEXT,status TEXT);
  `);
  const key = Buffer.alloc(32, 17), audits = [];
  let serial = 0, planActive = true;
  function seal(value) {
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32BE(++serial, 8);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
  }
  function open(value) {
    const data = Buffer.from(value);
    const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8'));
  }
  const names = {
    admin: 'Администратор', peer: 'Другой администратор', owner: 'Владелец',
    a: 'Анна', b: 'Борис', foreign: 'Чужой специалист',
    'blocked-account': 'Отключённый аккаунт', 'blocked-member': 'Отключённый сотрудник',
    global: 'Глобальный администратор',
  };
  for (const [id, displayName] of Object.entries(names))
    db.prepare('INSERT INTO accounts VALUES(?,?,?)').run(
      id, seal({ displayName, untouchedSetting: 'synthetic-' + id }),
      id === 'blocked-account' ? 'suspended' : 'active',
    );
  for (const id of ['org', 'other'])
    db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(id, seal({
      timeZone: 'Europe/Moscow',
      calendarPersonalVersions: { a: 'personal-a-1', b: 'personal-b-1', owner: 'personal-owner-1' },
    }), 'active');
  const members = [
    ['admin', 'org', 'salon_admin', 'active'], ['peer', 'org', 'salon_admin', 'active'],
    ['owner', 'org', 'owner', 'active'], ['a', 'org', 'cosmetologist', 'active'],
    ['b', 'org', 'cosmetologist', 'active'],
    ['blocked-account', 'org', 'cosmetologist', 'active'],
    ['blocked-member', 'org', 'cosmetologist', 'suspended'],
    ['foreign', 'other', 'cosmetologist', 'active'],
    ['global', 'org', 'global_admin', 'active'], ['admin', 'other', 'salon_admin', 'active'],
  ];
  for (const values of members) db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(...values);
  const sessions = Object.fromEntries(Object.keys(names).map((accountId) => [
    accountId, { accountId, organizationId: accountId === 'foreign' ? 'other' : 'org' },
  ]));
  sessions.other = { accountId: 'admin', organizationId: 'other' };
  const service = createCalendarSubscription({
    db, open, seal,
    transaction(fn) {
      db.exec('BEGIN');
      try { const result = fn(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    session: (token) => sessions[token],
    audit: (...values) => audits.push(values),
    subscription: () => ({ status: planActive ? 'active' : 'suspended' }),
  });
  const guard = () => {};
  function account(id = 'admin') {
    return open(db.prepare('SELECT value FROM accounts WHERE id=?').get(id).value);
  }
  function writeAccount(id, values) {
    db.prepare('UPDATE accounts SET value=? WHERE id=?').run(seal(values), id);
  }
  function profile() { return open(db.prepare("SELECT value FROM organizations WHERE id='org'").get().value); }
  function writeProfile(value) {
    db.prepare("UPDATE organizations SET value=? WHERE id='org'").run(seal(value));
  }
  const status = (provider = 'apple', token = 'admin') => service.status(token, provider);
  const select = (provider, selection, expectedSelectionRevision = status(provider).selectionRevision) =>
    service.updateSelection('admin', guard, provider, { selection, expectedSelectionRevision });
  function addSpecialist(id, displayName) {
    assert.ok(!accountExists(id));
    db.prepare('INSERT INTO accounts VALUES(?,?,?)').run(id, seal({ displayName }), 'active');
    db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(id, 'org', 'cosmetologist', 'active');
  }
  function accountExists(id) { return !!db.prepare('SELECT id FROM accounts WHERE id=?').get(id); }
  return {
    db, service, guard, audits, status, select, account, writeAccount, profile, writeProfile, addSpecialist,
    suspendPlan: () => { planActive = false; },
  };
}
module.exports = { calendarAdminFixture };
