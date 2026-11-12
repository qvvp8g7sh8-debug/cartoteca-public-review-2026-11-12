// Actual runtime functions against a small synthetic SQLite transaction fixture.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createSessions } = require('../src/server/modules/auth/sessions.cjs');
const { createLoginLimits } = require('../src/server/modules/auth/login-limits.cjs');
const { passwordProof } = require('../src/server/modules/auth/admin-mfa-values.cjs');
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE accounts(id TEXT PRIMARY KEY,value BLOB,global_admin INTEGER,status TEXT);
    CREATE TABLE organizations(id TEXT PRIMARY KEY,status TEXT);
    CREATE TABLE memberships(account_id TEXT,organization_id TEXT,role TEXT,status TEXT);
    CREATE TABLE platform_sessions(token_hash TEXT PRIMARY KEY,id TEXT UNIQUE,account_id TEXT,organization_id TEXT,value BLOB,expires_at INTEGER);
    CREATE TABLE login_limits(key TEXT PRIMARY KEY,failures INTEGER,window_started INTEGER,blocked_until INTEGER);
    CREATE TABLE audit(id INTEGER PRIMARY KEY,event TEXT);`);
  const seal = (v) => Buffer.from(JSON.stringify(v));
  const open = (v) => JSON.parse(Buffer.from(v).toString());
  const value = {
    email: 'owner@synthetic.test',
    displayName: 'Owner',
    emailVerified: true,
    salt: 'synthetic',
    passwordHash: 'unchanged',
  };
  db.prepare('INSERT INTO accounts VALUES(?,?,0,?)').run('owner', seal(value), 'active');
  for (const org of ['one', 'two'])
    db.prepare('INSERT INTO organizations VALUES(?,?)').run(org, 'active');
  db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run('owner', 'one', 'owner', 'active');
  const state = {
    transactions: 0,
    admissions: 0,
    deletes: 0,
    auditFailure: false,
    unknownCommit: false,
    beforeAdmission: null,
    mfa: { ok: true },
  };
  const instrumented = {
    get isTransaction() {
      return db.isTransaction;
    },
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        get: (...v) => statement.get(...v),
        all: (...v) => statement.all(...v),
        run(...v) {
          if (sql === 'DELETE FROM login_limits WHERE key=?') state.deletes++;
          return statement.run(...v);
        },
      };
    },
  };
  const c = {
    db: instrumented,
    crypto,
    seal,
    open,
    SESSION_MS: 60000,
    LOGIN_ATTEMPT_WINDOW_MS: 60000,
    LOGIN_BLOCK_MS: 900000,
    LOGIN_MAX_FAILURES: 5,
    id: crypto.randomUUID,
    tokenHash: (v) => v,
    normalizeEmail: (v) => v.trim().toLowerCase(),
    limitKey: (scope, v) => scope + ':' + v,
    fail: (status, message) => Object.assign(Error(message), { status }),
    authenticate: async () => ({ account: { id: 'owner' }, credentialProof: passwordProof(value) }),
    publicAccount: (row) => ({ id: row.id, displayName: open(row.value).displayName }),
    availableMemberships: () =>
      db
        .prepare(
          "SELECT m.organization_id organizationId FROM memberships m JOIN organizations o ON o.id=m.organization_id WHERE m.account_id='owner' AND m.status='active' AND o.status='active'",
        )
        .all(),
    adminMfa: { loginCheck: () => state.mfa },
    audit(event) {
      db.prepare('INSERT INTO audit(event) VALUES(?)').run(event);
      if (state.auditFailure) throw Error('Synthetic audit SQL failure');
    },
    transaction(callback) {
      state.transactions++;
      db.exec('BEGIN');
      try {
        const result = callback();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },
    async asyncTransaction(callback) {
      state.admissions++;
      await state.beforeAdmission?.();
      const result = c.transaction(callback);
      if (state.unknownCommit)
        throw Object.assign(Error('Synthetic lost COMMIT acknowledgement'), {
          outcomeUnknown: true,
        });
      return result;
    },
  };
  Object.assign(c, createLoginLimits(c));
  const keys = c.loginLimitKeys(value.email, 'synthetic-client');
  const putFailure = (key, count = 2, expiry = 0, started = Date.now()) =>
    db
      .prepare('INSERT OR REPLACE INTO login_limits VALUES(?,?,?,?)')
      .run(key, count, started, expiry);
  const count = (name) => db.prepare('SELECT count(*) n FROM ' + name).get().n;
  return { db, c, state, value, keys, putFailure, count, sessions: createSessions(c) };
}
test('successful login with no failures has exactly one owning transaction and no reset DELETE', async (t) => {
  const f = fixture(t),
    result = await f.sessions.login(f.value.email, 'synthetic', '', 'synthetic-client');
  assert.equal(f.state.admissions, 1);
  assert.equal(f.state.transactions, 1);
  assert.equal(f.state.deletes, 0);
  assert.equal(f.count('platform_sessions'), 1);
  assert.equal(f.count('audit'), 1);
  assert.equal(f.sessions.session(result.token).organizationId, 'one');
});
test('session+audit+observed rate resets commit together and never perform a post-commit writer', async (t) => {
  const f = fixture(t);
  for (const key of f.keys) f.putFailure(key);
  const result = await f.sessions.login(f.value.email, 'synthetic', '', 'synthetic-client');
  assert.ok(result.token);
  assert.equal(f.count('login_limits'), 0);
  assert.equal(f.state.deletes, 2);
  assert.equal(f.state.transactions, 1);
});
test('late audit failure rolls back the newly created session and both cleared rate counters', async (t) => {
  const f = fixture(t);
  for (const key of f.keys) f.putFailure(key);
  f.state.auditFailure = true;
  await assert.rejects(
    f.sessions.login(f.value.email, 'synthetic', '', 'synthetic-client'),
    /Synthetic audit SQL failure/,
  );
  assert.equal(f.count('login_limits'), 2);
  assert.equal(f.count('platform_sessions'), 0);
  assert.equal(f.count('audit'), 0);
  assert.equal(f.state.transactions, 1);
});
test('password and membership authority are freshly checked after async admission', async (t) => {
  const f = fixture(t);
  for (const key of f.keys) f.putFailure(key);
  f.state.beforeAdmission = () =>
    f.db
      .prepare('UPDATE accounts SET value=? WHERE id=?')
      .run(f.c.seal({ ...f.value, passwordHash: 'changed' }), 'owner');
  await assert.rejects(
    f.sessions.login(f.value.email, 'synthetic', '', 'synthetic-client'),
    (e) => e.status === 401,
  );
  assert.equal(f.count('platform_sessions'), 0);
  assert.equal(f.count('login_limits'), 2);
  f.db.prepare('UPDATE accounts SET value=? WHERE id=?').run(f.c.seal(f.value), 'owner');
  f.state.beforeAdmission = () =>
    f.db.prepare("UPDATE memberships SET status='revoked' WHERE account_id='owner'").run();
  const result = await f.sessions.login(f.value.email, 'synthetic', '', 'synthetic-client');
  assert.equal(result.organizationId, null);
  assert.equal(f.sessions.session(result.token).role, null);
  assert.equal(f.sessions.session(result.token).organizationAccess, 'none');
});
test('newly blocked client before BEGIN and MFA-required login cannot clear counters or issue a session', async (t) => {
  const f = fixture(t);
  f.state.beforeAdmission = () => f.putFailure(f.keys[1], 5, Date.now() + 60000);
  await assert.rejects(
    f.sessions.login(f.value.email, 'synthetic', '', 'synthetic-client'),
    (e) => e.status === 429,
  );
  assert.equal(f.state.deletes, 0);
  assert.equal(f.count('platform_sessions'), 0);
  f.db.exec('DELETE FROM login_limits');
  f.state.beforeAdmission = null;
  f.putFailure(f.keys[0]);
  f.state.mfa = { ok: false, required: true };
  await assert.rejects(f.sessions.login(f.value.email, 'synthetic', '', 'synthetic-client'), {
    code: 'MFA_REQUIRED',
  });
  assert.equal(f.count('login_limits'), 1);
  assert.equal(f.count('platform_sessions'), 0);
  assert.equal(f.state.deletes, 0);
});
test('expired rate inspection is pure, still denies an active block, and resets on the next failure', (t) => {
  const f = fixture(t);
  f.putFailure(f.keys[0], 4, 0, Date.now() - 120000);
  assert.deepEqual(f.c.assertLoginAllowed(f.keys), [f.keys[0]]);
  assert.equal(f.state.deletes, 0);
  assert.equal(f.state.transactions, 0);
  assert.throws(
    () => f.c.recordLoginFailure(f.keys),
    (e) => e.status === 401,
  );
  assert.equal(
    f.db.prepare('SELECT failures FROM login_limits WHERE key=?').get(f.keys[0]).failures,
    1,
  );
  assert.throws(
    () => f.c.clearLoginFailures(f.keys, { transactionOwned: true }),
    /owning transaction/,
  );
});
test('lost COMMIT acknowledgement is propagated without replay or a second clear transaction', async (t) => {
  const f = fixture(t);
  for (const key of f.keys) f.putFailure(key);
  f.state.unknownCommit = true;
  await assert.rejects(f.sessions.login(f.value.email, 'synthetic', '', 'synthetic-client'), {
    outcomeUnknown: true,
  });
  assert.equal(f.state.admissions, 1);
  assert.equal(f.state.transactions, 1);
  assert.equal(f.count('platform_sessions'), 1);
  assert.equal(f.count('login_limits'), 0);
  assert.equal(f.count('audit'), 1);
});
