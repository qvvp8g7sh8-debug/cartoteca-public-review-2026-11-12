const register = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createSessions } = require('../src/server/modules/auth/sessions.cjs');
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE accounts(id TEXT PRIMARY KEY,value BLOB,global_admin INTEGER,status TEXT);
  CREATE TABLE organizations(id TEXT PRIMARY KEY,status TEXT);
  CREATE TABLE memberships(account_id TEXT,organization_id TEXT,role TEXT,status TEXT);
  CREATE TABLE platform_sessions(token_hash TEXT PRIMARY KEY,id TEXT,account_id TEXT,organization_id TEXT,value BLOB,expires_at INTEGER);`);
  const state = { intent: null, transactions: 0, audits: [] };
  const observed = new Proxy(db, {
    get(target, name) {
      if (name === 'transactionIntent') return state.intent;
      const value = Reflect.get(target, name, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const seal = (v) => Buffer.from(JSON.stringify(v)),
    open = (v) => JSON.parse(Buffer.from(v).toString('utf8'));
  for (const [id, name] of [
    ['owner', 'Owner'],
    ['admin', 'Administrator'],
  ]) {
    db.prepare('INSERT INTO accounts VALUES(?,?,0,?)').run(
      id,
      seal({ email: id + '@synthetic.test', displayName: name }),
      'active',
    );
    db.prepare('INSERT INTO organizations VALUES(?,?)').run('org-' + id, 'active');
    db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(
      id,
      'org-' + id,
      id === 'owner' ? 'owner' : 'salon_admin',
      'active',
    );
    db.prepare('INSERT INTO platform_sessions VALUES(?,?,?,?,?,?)').run(
      'token-' + id,
      'session-' + id,
      id,
      'org-' + id,
      seal({}),
      Date.now() + 60000,
    );
  }
  const sessions = createSessions({
    db: observed,
    seal,
    open,
    tokenHash: (v) => v,
    audit: (...args) => state.audits.push(args),
    availableMemberships: (account) =>
      db
        .prepare(
          "SELECT organization_id organizationId FROM memberships WHERE account_id=? AND status='active'",
        )
        .all(account),
    transaction(callback) {
      state.transactions++;
      db.exec('BEGIN');
      try {
        const value = callback();
        db.exec('COMMIT');
        return value;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  });
  return {
    db,
    state,
    sessions,
    seal,
    read: (token) => db.prepare('SELECT * FROM platform_sessions WHERE token_hash=?').get(token),
  };
}
for (const intent of ['COMPOUND', 'QUEUEORG', 'QUEUEENTITY']) {
  const test = (title, callback) => register(intent + ': ' + title, callback);
  test('compound expired authority is denied without session cleanup; ordinary lookup still cleans up', (t) => {
    const f = fixture(t);
    f.db
      .prepare('UPDATE platform_sessions SET expires_at=? WHERE token_hash=?')
      .run(Date.now() - 1, 'token-admin');
    f.state.intent = intent;
    assert.equal(f.sessions.session('token-admin'), null);
    assert.ok(f.read('token-admin'));
    assert.equal(f.state.transactions, 0);
    f.state.intent = null;
    assert.equal(f.sessions.session('token-admin'), null);
    assert.equal(f.read('token-admin'), undefined);
    assert.ok(f.read('token-owner'));
  });
  test('compound does not auto-select a cabinet; ordinary lookup retains the existing repair', (t) => {
    const f = fixture(t);
    f.db
      .prepare('UPDATE platform_sessions SET organization_id=NULL WHERE token_hash=?')
      .run('token-admin');
    f.state.intent = intent;
    assert.equal(f.sessions.session('token-admin'), null);
    assert.equal(f.read('token-admin').organization_id, null);
    assert.deepEqual(f.state.audits, []);
    assert.equal(f.state.transactions, 0);
    f.state.intent = null;
    const current = f.sessions.session('token-admin');
    assert.equal(current.organizationId, 'org-admin');
    assert.equal(current.displayName, 'Administrator');
    assert.equal(f.read('token-admin').organization_id, 'org-admin');
    assert.equal(f.state.transactions, 1);
    assert.equal(f.state.audits.length, 1);
  });
  test('compound identity remains account-specific and reads current account and membership on each check', (t) => {
    const f = fixture(t);
    f.state.intent = intent;
    assert.equal(f.sessions.session('token-admin').displayName, 'Administrator');
    assert.equal(f.sessions.session('token-owner').displayName, 'Owner');
    f.db
      .prepare('UPDATE accounts SET value=? WHERE id=?')
      .run(
        f.seal({ email: 'admin@synthetic.test', displayName: 'Current administrator' }),
        'admin',
      );
    assert.equal(f.sessions.session('token-admin').displayName, 'Current administrator');
    f.db.prepare("UPDATE memberships SET status='revoked' WHERE account_id=?").run('admin');
    assert.equal(f.sessions.session('token-admin'), null);
    assert.equal(f.sessions.session('token-owner').organizationId, 'org-owner');
    assert.ok(f.read('token-admin'));
    assert.deepEqual(f.state.audits, []);
  });
  test('compound MFA revision is still checked without changing the session', (t) => {
    const f = fixture(t);
    f.state.intent = intent;
    f.db.prepare('UPDATE accounts SET global_admin=1,value=? WHERE id=?').run(
      f.seal({
        email: 'admin@synthetic.test',
        displayName: 'Administrator',
        adminMfa: { enabled: true, revision: 'new' },
      }),
      'admin',
    );
    assert.equal(f.sessions.session('token-admin'), null);
    assert.ok(f.read('token-admin'));
    assert.deepEqual(f.state.audits, []);
  });
}
