const test = require('node:test');
const assert = require('node:assert/strict');
const { maintenanceFixture } = require('./helpers/notification-maintenance-fixture.cjs');
const {
  createQueueMaintenance,
} = require('../src/server/modules/notifications/queue-maintenance.cjs');
const owned = { canRun: () => true };
const busy = (extra = {}) =>
  Object.assign(new Error('Synthetic clean admission refusal'), {
    code: 'ERR_SQLITE_ERROR',
    postgres: true,
    postgresCode: 'POSTGRES_BUSY',
    errcode: 5,
    status: 503,
    retryableBeforeBegin: true,
    transactionOpen: false,
    channelPoisoned: false,
    outcomeUnknown: false,
    ...extra,
  });
function maintenance(t, f, c = f.c) {
  const runtime = createQueueMaintenance(c, { enabled: true, clock: f.clock, monotonic: () => 0 });
  t.after(() => runtime.stop());
  return runtime;
}
async function drain(runtime, count = 32) {
  for (let n = 0; n < count; n++) await runtime.tick(owned);
}
const clientRow = (f, id) =>
  f.c.db
    .prepare(
      'SELECT id,status,expires_at,lease_until,value FROM notification_channel_jobs WHERE id=?',
    )
    .get(id);
function scoped(f, overrides = {}) {
  return {
    ...f.c,
    organizationQueueTransaction: (work) => f.c.transaction(work),
    entityQueueTransaction: (work) => f.c.transaction(work),
    ...overrides,
  };
}

test('async queue admission busy defers without changing a reservation and later retries it', async (t) => {
  const f = await maintenanceFixture(t);
  f.client('deferred-reservation', { status: 'reserved', lease: f.clock() });
  const before = clientRow(f, 'deferred-reservation');
  let refused = false;
  const runtime = maintenance(t, f, {
    ...f.c,
    asyncQueueTransaction: async () => {
      refused = true;
      throw busy();
    },
  });
  await runtime.tick(owned);
  assert.equal(refused, true);
  assert.deepEqual(clientRow(f, 'deferred-reservation'), before);
  assert.equal(runtime.stats().busyDeferrals, 1);
  assert.equal(runtime.stats().errors, 0);
  assert.equal(runtime.stats().busy, false);
  assert.equal(runtime.stats().lastFailure, null);
});

test('the same async runtime resumes its round-robin phase after one clean refusal', async (t) => {
  const f = await maintenanceFixture(t);
  f.client('retry-same-runtime', { status: 'reserved', lease: f.clock() });
  const c = { ...f.c };
  let refusals = 0;
  c.asyncQueueTransaction = async (work) => {
    if (refusals++ === 0) throw busy();
    return f.c.transaction(work);
  };
  const runtime = maintenance(t, f, c);
  await runtime.tick(owned);
  assert.equal(clientRow(f, 'retry-same-runtime').status, 'reserved');
  await drain(runtime);
  assert.equal(clientRow(f, 'retry-same-runtime').status, 'pending');
  assert.equal(clientRow(f, 'retry-same-runtime').lease_until, 0);
  assert.equal(runtime.stats().busyDeferrals, 1);
  assert.equal(runtime.stats().errors, 0);
  assert.equal(f.c.db.isTransaction, false);
});

test('organization cursor returns to a refused scope without losing its original lease', async (t) => {
  const f = await maintenanceFixture(t);
  f.client('org-retry', { status: 'reserved', lease: f.clock() });
  const before = clientRow(f, 'org-retry');
  let refusals = 0;
  const c = scoped(f, {
    organizationQueueTransaction: (work) => {
      if (refusals++ === 0) throw busy();
      return f.c.transaction(work);
    },
  });
  const runtime = maintenance(t, f, c);
  await runtime.tick(owned);
  assert.deepEqual(clientRow(f, 'org-retry'), before);
  assert.equal(runtime.stats().busyDeferrals, 1);
  await drain(runtime);
  assert.equal(clientRow(f, 'org-retry').status, 'pending');
  assert.equal(runtime.stats().errors, 0);
  assert.equal(f.c.db.isTransaction, false);
});

test('entity marker cursor returns after a clean refusal without deleting the marker early', async (t) => {
  const f = await maintenanceFixture(t);
  const key = 'staff-selftest-v1:telegram:synthetic-orphan';
  f.c.db
    .prepare('INSERT INTO telegram_runtime(key,value) VALUES(?,?)')
    .run(key, Buffer.from('synthetic'));
  let refusals = 0;
  const c = scoped(f, {
    entityQueueTransaction: (work) => {
      if (refusals++ === 0) throw busy();
      return f.c.transaction(work);
    },
  });
  const runtime = maintenance(t, f, c);
  await runtime.tick(owned);
  assert.ok(f.c.db.prepare('SELECT value FROM telegram_runtime WHERE key=?').get(key));
  assert.equal(runtime.stats().busyDeferrals, 1);
  await drain(runtime);
  assert.equal(
    f.c.db.prepare('SELECT value FROM telegram_runtime WHERE key=?').get(key),
    undefined,
  );
  assert.equal(runtime.stats().errors, 0);
});

test('discovery admission refusal is bounded and retries the unchanged due row', async (t) => {
  const f = await maintenanceFixture(t);
  f.client('discovery-retry', { status: 'reserved', lease: f.clock() });
  const runtime = maintenance(t, f, scoped(f));
  let rejected = false;
  await runtime.tick({
    ...owned,
    runWork(callback) {
      if (!rejected) {
        rejected = true;
        return Promise.reject(busy());
      }
      return callback();
    },
  });
  assert.equal(runtime.stats().busyDeferrals, 1);
  assert.equal(runtime.stats().errors, 0);
  await drain(runtime);
  assert.equal(clientRow(f, 'discovery-retry').status, 'pending');
});

for (const [name, extra] of [
  ['unknown outcome', { outcomeUnknown: true }],
  ['poisoned channel', { channelPoisoned: true }],
  ['open transaction metadata', { transactionOpen: true }],
  ['not a pre-BEGIN refusal', { retryableBeforeBegin: false }],
  ['callback-started metadata', { scopedQueueCallbackStarted: true }],
])
  test(name + ' remains a rejected maintenance error', async (t) => {
    const f = await maintenanceFixture(t);
    f.client('fatal-' + name, { expires: f.clock() });
    const error = busy(extra);
    const runtime = maintenance(t, f, {
      ...f.c,
      asyncQueueTransaction: () => Promise.reject(error),
    });
    await assert.rejects(runtime.tick(owned), (received) => received === error);
    const stats = runtime.stats();
    assert.equal(stats.errors, 1);
    assert.equal(stats.busyDeferrals, 0);
    assert.equal(stats.busy, false);
    assert.equal(stats.lastFailure.phase, 'admission');
    assert.equal(stats.lastFailure.code, 'POSTGRES_BUSY');
    assert.equal(stats.lastFailure.status, 503);
    assert.equal(stats.lastFailure.callbackEntered, false);
    assert.equal(Object.hasOwn(stats.lastFailure, 'message'), false);
  });

test('callback-started clean-looking failure remains fatal, rolls back, and records settlement', async (t) => {
  const f = await maintenanceFixture(t);
  f.client('callback-rollback', { expires: f.clock() });
  const before = clientRow(f, 'callback-rollback');
  const error = busy();
  const c = {
    ...f.c,
    asyncQueueTransaction: async (work) =>
      f.c.transaction(() => {
        work();
        throw error;
      }),
  };
  const runtime = maintenance(t, f, c);
  await assert.rejects(runtime.tick(owned), (received) => received === error);
  assert.deepEqual(clientRow(f, 'callback-rollback'), before);
  assert.equal(runtime.stats().busyDeferrals, 0);
  assert.equal(runtime.stats().errors, 1);
  assert.equal(runtime.stats().lastFailure.callbackEntered, true);
  assert.equal(runtime.stats().lastFailure.phase, 'settlement');
  assert.equal(f.c.db.isTransaction, false);
  c.asyncQueueTransaction = async (work) => f.c.transaction(work);
  await drain(runtime);
  assert.equal(clientRow(f, 'callback-rollback').status, 'cancelled');
  assert.equal(runtime.stats().errors, 1);
});

test('ordinary dispatcher overload remains an error with only closed technical diagnostics', async (t) => {
  const f = await maintenanceFixture(t);
  const runtime = maintenance(t, f, scoped(f));
  const error = Object.assign(new Error('Synthetic dispatcher overload; do not disclose'), {
    status: 503,
  });
  await assert.rejects(
    runtime.tick({ ...owned, runWork: () => Promise.reject(error) }),
    (received) => received === error,
  );
  const observed = runtime.stats().lastFailure;
  assert.deepEqual(observed, {
    phase: 'discovery',
    code: 'UNCLASSIFIED',
    status: 503,
    callbackEntered: false,
    retryableBeforeBegin: false,
    transactionOpen: null,
    outcomeUnknown: false,
    channelPoisoned: false,
  });
  observed.phase = 'changed externally';
  assert.equal(runtime.stats().lastFailure.phase, 'discovery');
  assert.equal(runtime.stats().errors, 1);
  assert.equal(runtime.stats().busyDeferrals, 0);
});

test('actual open transaction prevents a clean-looking pre-admission deferral', async (t) => {
  const f = await maintenanceFixture(t);
  f.client('actual-open-transaction', { expires: f.clock() });
  const error = busy();
  const runtime = maintenance(t, f, { ...f.c, asyncQueueTransaction: () => Promise.reject(error) });
  f.c.db.exec('BEGIN');
  try {
    await assert.rejects(runtime.tick(owned), (received) => received === error);
    assert.equal(runtime.stats().errors, 1);
    assert.equal(runtime.stats().busyDeferrals, 0);
    assert.equal(f.c.db.isTransaction, true);
  } finally {
    if (f.c.db.isTransaction) f.c.db.exec('ROLLBACK');
  }
});
