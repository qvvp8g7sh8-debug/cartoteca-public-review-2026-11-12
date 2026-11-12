const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createAsyncWriteLock } = require('../src/server/infrastructure/async-write-lock.cjs');
const { createAssistantPolicy } = require('../src/server/modules/assistant/access/policy.cjs');
const { createAssistantBudget } = require('../src/server/modules/assistant/access/budget.cjs');
const { initialState } = require('../src/server/modules/assistant/access/defaults.cjs');
const turn = () => new Promise((resolve) => setImmediate(resolve));
function busy() {
  return Object.assign(Error('Synthetic clean pre-BEGIN contention'), {
    code: 'ERR_SQLITE_ERROR',
    errcode: 5,
    postgres: true,
    postgresCode: 'POSTGRES_BUSY',
    retryableBeforeBegin: true,
    transactionOpen: false,
    outcomeUnknown: false,
  });
}
function fixture(t, dialect = 'postgres') {
  const sql = new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE accounts(id TEXT PRIMARY KEY,global_admin INTEGER,status TEXT);
    CREATE TABLE organizations(id TEXT PRIMARY KEY,status TEXT);
    CREATE TABLE memberships(organization_id TEXT,account_id TEXT,role TEXT,status TEXT,created_at INTEGER);
    INSERT INTO accounts VALUES('user',0,'active');
    INSERT INTO organizations VALUES('org','active');
    INSERT INTO memberships VALUES('org','user','owner','active',123);`);
  const counts = {
    begins: 0,
    callbackUpdates: 0,
    committedFileWrites: 0,
    sync: 0,
    async: 0,
    commits: 0,
  };
  let held = false,
    updateFailure = null,
    unknownCommit = false;
  const db = {
    dialect,
    get isOpen() {
      return sql.isOpen;
    },
    get isTransaction() {
      return sql.isTransaction;
    },
    prepare: (text) => sql.prepare(text),
    exec(text) {
      if (text === 'BEGIN IMMEDIATE') {
        counts.begins++;
        if (held) throw busy();
      }
      sql.exec(text);
      if (text === 'COMMIT') {
        counts.commits++;
        if (unknownCommit) {
          unknownCommit = false;
          throw Object.assign(Error('Commit acknowledgement lost'), {
            code: 'POSTGRES_OUTCOME_UNKNOWN',
            outcomeUnknown: true,
          });
        }
      }
    },
  };
  const writer = createAsyncWriteLock(db, { timeoutMs: 500 });
  const context = {
    db,
    transaction(callback) {
      counts.sync++;
      assert.notEqual(dialect, 'postgres', 'PostgreSQL must use existing queued admission');
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = callback();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },
    asyncTransaction(callback) {
      counts.async++;
      return writer.transaction(callback);
    },
  };
  let state = initialState();
  state.revision = 7;
  state.policy.mode = 'selected';
  const store = {
    read: () => structuredClone(state),
    update(callback) {
      counts.callbackUpdates++;
      const next = structuredClone(state),
        result = callback(next);
      if (updateFailure) throw updateFailure;
      state = next;
      counts.committedFileWrites++;
      return result;
    },
  };
  const policy = createAssistantPolicy(context, store),
    current = { organizationId: 'org', accountId: 'user', role: 'owner' };
  state.grants = [policy.membership('org', 'user')];
  const budget = createAssistantBudget(context, store, policy);
  t.after(() => {
    writer.close();
    sql.close();
  });
  return {
    sql,
    context,
    counts,
    budget,
    policy,
    current,
    state: () => structuredClone(state),
    hold(value) {
      held = value;
    },
    failUpdate(value) {
      updateFailure = value;
    },
    loseCommit() {
      unknownCommit = true;
    },
    reserve: (amount = 0.5) => budget.reserve(current, 7, 'llm', amount),
  };
}

test('PG contention waits before BEGIN with no file mutation, then the same reservation continues exactly once', async (t) => {
  const f = fixture(t),
    original = f.state();
  f.hold(true);
  const pending = f.reserve();
  assert.equal(typeof pending.then, 'function');
  await turn();
  assert.ok(f.counts.begins >= 1);
  assert.equal(f.counts.callbackUpdates, 0);
  assert.deepEqual(f.state(), original);
  f.hold(false);
  const reservation = await pending;
  assert.equal(Object.keys(f.state().reservations).length, 1);
  assert.equal(f.state().reservations[reservation.id].amount, 0.5);
  assert.equal(f.counts.callbackUpdates, 1);
  assert.equal(f.counts.committedFileWrites, 1);
  assert.equal(f.counts.sync, 0);
});

test('queued PG work checks current membership inside the callback and cannot reserve after revocation', async (t) => {
  const f = fixture(t),
    original = f.state();
  f.hold(true);
  const pending = f.reserve(),
    denied = assert.rejects(pending, { status: 403 });
  await turn();
  f.sql.prepare("UPDATE memberships SET status='suspended'").run();
  f.hold(false);
  await denied;
  assert.deepEqual(f.state(), original);
  assert.equal(f.counts.callbackUpdates, 1);
  assert.equal(f.counts.committedFileWrites, 0);
});

test('PG settlement waits without changing state and repeated settlement charges one exact reservation only once', async (t) => {
  const f = fixture(t),
    reservation = await f.reserve(1.25);
  const reserved = f.state();
  f.hold(true);
  const first = f.budget.settle(reservation, 0.75),
    second = f.budget.settle(reservation, 0.75);
  await turn();
  assert.deepEqual(f.state(), reserved);
  f.hold(false);
  await Promise.all([first, second]);
  const month = Object.values(f.state().usage)[0];
  assert.deepEqual(month, { spentRub: 0.75, calls: 1, uncertainCalls: 0 });
  assert.deepEqual(f.state().reservations, {});
  assert.equal(f.counts.sync, 0);
});

test('callback BUSY and unknown commit outcomes are never replayed by admission', async (t) => {
  for (const phase of ['callback', 'unknown-commit'])
    await t.test(phase, async (t) => {
      const f = fixture(t);
      if (phase === 'callback')
        f.failUpdate(Object.assign(busy(), { retryableBeforeBegin: false, transactionOpen: true }));
      else f.loseCommit();
      await assert.rejects(f.reserve(), (error) =>
        phase === 'callback' ? error.errcode === 5 : error.outcomeUnknown === true,
      );
      assert.equal(f.counts.begins, 1);
      assert.equal(f.counts.callbackUpdates, 1);
      assert.equal(f.counts.committedFileWrites, phase === 'callback' ? 0 : 1);
      if (phase === 'unknown-commit') {
        const id = Object.keys(f.state().reservations)[0];
        await f.budget.settle({ id, amount: 0.5 }, 0);
        await f.budget.settle({ id, amount: 0.5 }, 0);
        assert.deepEqual(Object.values(f.state().usage), [
          { spentRub: 0, calls: 1, uncertainCalls: 0 },
        ]);
      }
    });
});

test('SQLite pilot reserve and settle preserve synchronous return and current limits', (t) => {
  const f = fixture(t, 'sqlite'),
    reservation = f.reserve();
  assert.equal(reservation.then, undefined);
  assert.equal(f.budget.settle(reservation, 0.25), undefined);
  assert.deepEqual(Object.values(f.state().usage), [
    { spentRub: 0.25, calls: 1, uncertainCalls: 0 },
  ]);
  assert.equal(f.counts.async, 0);
  assert.equal(f.counts.sync, 2);
});
