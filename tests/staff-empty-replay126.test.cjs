const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createStaffEventReplay,
} = require('../src/server/modules/notifications/staff-event-replay.cjs');
const JOURNAL = 'appointment-notification-events-v1';
function fixture() {
  let now = 1000,
    platformDepth = 0,
    transactionMode = null,
    saved = [],
    allowed = true;
  const calls = { critical: 0, transactions: [], jobs: [], writes: 0 };
  const hooks = { beforeCritical: null, afterSnapshot: null, failCommit: false };
  const entry = () => ({
    id: 'synthetic-event',
    audience: 'staff',
    createdAt: now,
    expiresAt: now + 86400000,
    kind: 'created',
    staffId: 'staff',
    channelVersions: { telegram: '' },
    recipients: { telegram: [{ accountId: 'staff', bindingId: 'binding', eventVersion: '' }] },
    reference: { id: 'appointment' },
  });
  const storage = {
    db: { dialect: 'postgres' },
    get(key) {
      assert.equal(key, JOURNAL);
      return structuredClone(saved);
    },
    set(key, value) {
      assert.equal(key, JOURNAL);
      assert.equal(transactionMode, 'IMMEDIATE');
      saved = structuredClone(value);
      calls.writes++;
    },
    transaction(work, mode = 'IMMEDIATE') {
      assert.equal(transactionMode, null);
      transactionMode = mode;
      const call = { mode, writes: 0 };
      calls.transactions.push(call);
      const writes = calls.writes;
      try {
        return work();
      } finally {
        call.writes = calls.writes - writes;
        transactionMode = null;
        if (mode === 'READONLY' && hooks.afterSnapshot) {
          const next = hooks.afterSnapshot;
          hooks.afterSnapshot = null;
          next();
        }
      }
    },
  };
  const store = {
    hasAppointmentRecipients: () => allowed,
    inTransaction: () => platformDepth > 0,
    organizationPage: () => ({ organizations: ['organization'], cursor: '' }),
    enqueueAppointment(...args) {
      assert.equal(platformDepth, 1);
      assert.equal(transactionMode, 'DEFERRED');
      if (allowed) calls.jobs.push(args);
    },
  };
  const platform = {
    staffNotifications: store,
    staffMaxNotifications: null,
    withWriteLock(work) {
      calls.critical++;
      hooks.beforeCritical?.();
      const previous = calls.jobs.slice();
      platformDepth++;
      try {
        const result = work();
        if (hooks.failCommit) throw Error('Synthetic platform commit failed');
        return result;
      } catch (error) {
        calls.jobs = previous;
        throw error;
      } finally {
        platformDepth--;
      }
    },
  };
  const replay = createStaffEventReplay({
    platform,
    tenantStore: () => storage,
    store,
    clock: () => now,
  });
  return {
    calls,
    hooks,
    storage,
    replay,
    append() {
      saved.push(entry());
    },
    pending: () => structuredClone(saved),
    advance() {
      now += 15000;
    },
    setAllowed(value) {
      allowed = value;
    },
    clear() {
      saved = [];
    },
  };
}

test('empty managed staff replay uses only an addressed read-only snapshot and no critical or cabinet write', async () => {
  const f = fixture();
  await f.replay.batched(
    undefined,
    () => true,
    (work) => work(),
  );
  assert.equal(f.calls.critical, 0);
  assert.equal(f.calls.writes, 0);
  assert.deepEqual(f.calls.jobs, []);
  assert.deepEqual(f.calls.transactions, [{ mode: 'READONLY', writes: 0 }]);
});

test('an append racing after a negative snapshot survives and is projected at the next sweep', async () => {
  const f = fixture();
  f.hooks.afterSnapshot = () => f.append();
  await f.replay.batched(
    undefined,
    () => true,
    (work) => work(),
  );
  assert.equal(f.calls.critical, 0);
  assert.equal(f.pending().length, 1);
  assert.equal(f.calls.writes, 0);
  f.advance();
  await f.replay.batched(
    undefined,
    () => true,
    (work) => work(),
  );
  assert.equal(f.calls.critical, 1);
  assert.equal(f.calls.jobs.length, 1);
  assert.equal(f.pending().length, 0);
  assert.equal(f.calls.writes, 1);
  assert.deepEqual(f.calls.jobs[0].at(-1), [
    { accountId: 'staff', bindingId: 'binding', eventVersion: '' },
  ]);
});

test('positive replay rechecks fresh policy and journal under the original critical transaction', async () => {
  const f = fixture();
  f.append();
  f.hooks.beforeCritical = () => f.setAllowed(false);
  await f.replay.batched(
    undefined,
    () => true,
    (work) => work(),
  );
  assert.equal(f.calls.critical, 1);
  assert.equal(f.calls.jobs.length, 0);
  assert.equal(f.pending().length, 1);
  assert.equal(f.calls.writes, 0);
  f.hooks.beforeCritical = null;
  f.setAllowed(true);
  f.advance();
  await f.replay.batched(
    undefined,
    () => true,
    (work) => work(),
  );
  assert.equal(f.calls.jobs.length, 1);
  assert.equal(f.pending().length, 0);
  const raced = fixture();
  raced.append();
  raced.hooks.beforeCritical = () => raced.clear();
  await raced.replay.batched(
    undefined,
    () => true,
    (work) => work(),
  );
  assert.equal(raced.calls.jobs.length, 0);
  assert.equal(raced.calls.writes, 0);
});

test('a failed queue commit never retires the durable event and the subsequent sweep can recover it', async () => {
  const f = fixture();
  f.append();
  f.hooks.failCommit = true;
  await f.replay.batched(
    undefined,
    () => true,
    (work) => work(),
  );
  assert.equal(f.calls.jobs.length, 0);
  assert.equal(f.pending().length, 1);
  assert.equal(f.calls.writes, 0);
  assert.notEqual(f.replay.status().error, '');
  f.hooks.failCommit = false;
  f.advance();
  await f.replay.batched(
    undefined,
    () => true,
    (work) => work(),
  );
  assert.equal(f.calls.jobs.length, 1);
  assert.equal(f.pending().length, 0);
  assert.equal(f.replay.status().error, '');
});
