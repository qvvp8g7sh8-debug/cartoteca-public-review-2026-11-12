const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createSessions } = require('../src/server/modules/auth/sessions.cjs');
const { createSessionMaintenance } = require('../src/server/modules/auth/session-maintenance.cjs');
const { passwordProof } = require('../src/server/modules/auth/admin-mfa-values.cjs');
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE accounts(id TEXT PRIMARY KEY,value BLOB,global_admin INTEGER,status TEXT);
    CREATE TABLE organizations(id TEXT PRIMARY KEY,status TEXT);
    CREATE TABLE memberships(account_id TEXT,organization_id TEXT,role TEXT,status TEXT);
    CREATE TABLE platform_sessions(token_hash TEXT PRIMARY KEY,id TEXT UNIQUE,account_id TEXT,organization_id TEXT,value BLOB,expires_at INTEGER);`);
  const seal = (value) => Buffer.from(JSON.stringify(value));
  const open = (value) => JSON.parse(Buffer.from(value).toString('utf8'));
  const value = {
    email: 'owner@synthetic.test',
    displayName: 'Owner',
    emailVerified: true,
    salt: 'synthetic',
    passwordHash: 'synthetic',
  };
  db.prepare('INSERT INTO accounts VALUES(?,?,0,?)').run('owner', seal(value), 'active');
  db.prepare('INSERT INTO organizations VALUES(?,?)').run('org', 'active');
  db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run('owner', 'org', 'owner', 'active');
  const state = {
    now: Date.now(),
    writes: 0,
    beforeWrite: () => {},
    mfa: { ok: true },
    auditFailure: false,
  };
  const c = {
    db,
    seal,
    open,
    crypto,
    SESSION_MS: 60000,
    id: crypto.randomUUID,
    tokenHash: (v) => v,
    fail: (status, message) => Object.assign(Error(message), { status }),
    assertLoginAllowed() {},
    clearLoginFailures() {},
    recordLoginFailure() {},
    loginLimitKeys: () => [],
    authenticate: async () => ({ account: { id: 'owner' }, credentialProof: passwordProof(value) }),
    publicAccount: (row) => ({ id: row.id, displayName: open(row.value).displayName }),
    availableMemberships: () => [{ organizationId: 'org' }],
    adminMfa: { loginCheck: () => state.mfa },
    audit() {
      if (state.auditFailure) throw Error('Synthetic audit failure');
    },
    transaction(callback) {
      db.exec('BEGIN');
      try {
        const result = callback();
        db.exec('COMMIT');
        return result;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async asyncTransaction(callback, options = {}) {
      state.writes++;
      state.beforeWrite();
      if (options.cancelled?.()) return 0;
      return c.transaction(callback);
    },
  };
  const put = (token, expiry) =>
    db
      .prepare('INSERT INTO platform_sessions VALUES(?,?,?,?,?,?)')
      .run(token, crypto.randomUUID(), 'owner', 'org', seal({}), expiry);
  const read = (token) =>
    db.prepare('SELECT * FROM platform_sessions WHERE token_hash=?').get(token);
  const maintenance = createSessionMaintenance(c, { clock: () => state.now });
  t.after(() => maintenance.stop());
  return { db, state, c, put, read, maintenance, sessions: createSessions(c) };
}
test('successful login does not delete unrelated expired sessions; expiry denial and new identity remain current', async (t) => {
  const f = fixture(t);
  f.put('old-expired', Date.now() - 1);
  f.put('live-existing', Date.now() + 60000);
  const result = await f.sessions.login('owner@synthetic.test', 'synthetic');
  assert.ok(f.read('old-expired'));
  assert.ok(f.read('live-existing'));
  assert.equal(f.sessions.session(result.token).displayName, 'Owner');
  assert.equal(f.sessions.session(result.token).organizationId, 'org');
  assert.equal(f.sessions.session('old-expired'), null);
  f.db.prepare("UPDATE memberships SET status='revoked' WHERE account_id='owner'").run();
  assert.equal(f.sessions.session(result.token), null);
});
test('MFA denial and a failed login audit preserve all previous sessions and rollback the new session', async (t) => {
  const f = fixture(t);
  f.put('old-expired', Date.now() - 1);
  f.state.mfa = { ok: false, required: true };
  await assert.rejects(
    f.sessions.login('owner@synthetic.test', 'synthetic'),
    (e) => e.code === 'MFA_REQUIRED',
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM platform_sessions').get().n, 1);
  f.state.mfa = { ok: true };
  f.state.auditFailure = true;
  await assert.rejects(
    f.sessions.login('owner@synthetic.test', 'synthetic'),
    /Synthetic audit failure/,
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM platform_sessions').get().n, 1);
  assert.ok(f.read('old-expired'));
});
test('cleanup bounds both examined and removed rows, advances its keyset page and keeps live sessions', async (t) => {
  const f = fixture(t);
  for (let n = 0; n < 260; n++) f.put('expired-' + String(n).padStart(3, '0'), f.state.now - 1);
  f.put('live', f.state.now + 60000);
  assert.deepEqual(await f.maintenance.tick({ canRun: () => true }), {
    examined: 128,
    changed: 128,
  });
  assert.deepEqual(await f.maintenance.tick({ canRun: () => true }), {
    examined: 128,
    changed: 128,
  });
  assert.deepEqual(await f.maintenance.tick({ canRun: () => true }), { examined: 5, changed: 4 });
  assert.ok(f.read('live'));
  assert.equal(f.db.prepare('SELECT count(*) n FROM platform_sessions').get().n, 1);
  const writes = f.state.writes;
  await f.maintenance.tick({ canRun: () => true });
  assert.equal(f.state.writes, writes);
});
test('cleanup rechecks expiry after writer admission and never deletes a renewed session', async (t) => {
  const f = fixture(t);
  f.put('expired', f.state.now - 1);
  f.put('still-expired', f.state.now - 1);
  f.state.beforeWrite = () =>
    f.db
      .prepare('UPDATE platform_sessions SET expires_at=? WHERE token_hash=?')
      .run(f.state.now + 60000, 'expired');
  assert.deepEqual(await f.maintenance.tick({ canRun: () => true }), { examined: 2, changed: 1 });
  assert.ok(f.read('expired'));
  assert.equal(f.read('still-expired'), undefined);
});
test('loss of background ownership during admission prevents deletion', async (t) => {
  const f = fixture(t);
  f.put('expired', f.state.now - 1);
  let owned = true;
  f.state.beforeWrite = () => {
    owned = false;
  };
  assert.equal((await f.maintenance.tick({ canRun: () => owned })).changed, 0);
  assert.ok(f.read('expired'));
  assert.equal((await f.maintenance.tick({ canRun: () => false })).changed, 0);
});
test('unknown commit suspends this maintenance lifetime and is not replayed', async (t) => {
  const f = fixture(t);
  f.put('expired', f.state.now - 1);
  let attempts = 0;
  f.c.asyncTransaction = async (callback) => {
    attempts++;
    f.c.transaction(callback);
    throw Object.assign(Error('Synthetic unknown'), { outcomeUnknown: true });
  };
  await assert.rejects(
    f.maintenance.tick({ canRun: () => true }),
    (e) => e.outcomeUnknown === true,
  );
  assert.equal(f.read('expired'), undefined);
  f.put('new-expired', f.state.now - 1);
  assert.deepEqual(await f.maintenance.tick({ canRun: () => true }), { examined: 0, changed: 0 });
  assert.equal(attempts, 1);
  assert.ok(f.read('new-expired'));
  assert.equal(f.maintenance.stats().suspended, true);
});
