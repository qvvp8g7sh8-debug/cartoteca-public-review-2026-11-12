const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createNotificationScheduler,
} = require('../src/server/modules/notifications/notification-scheduler.cjs');
const {
  createDueRunner,
} = require('../src/server/modules/notifications/notification-due-runner.cjs');
const {
  createManagedPushDelivery,
} = require('../src/server/modules/notifications/push-managed-delivery.cjs');
const turn = () => new Promise(setImmediate);

test('background dispatcher owns real discovery/transaction units and their trusted organization', async () => {
  let inTransaction = false;
  const seen = [],
    scopes = [];
  const scheduler = createNotificationScheduler({
    organizations: () => ['runtime'],
    *work() {
      yield { organizationId: 'own-organization' };
      inTransaction = true;
      seen.push('committed');
      inTransaction = false;
      yield;
    },
  });
  const pending = scheduler.scheduleBatched({
    runWork: async (callback, org) => {
      assert.equal(inTransaction, false, 'no open transaction may cross admission');
      scopes.push(org);
      await turn();
      assert.equal(inTransaction, false);
      return callback();
    },
  });
  assert.deepEqual(seen, [], 'work cannot start before the dispatcher executes it');
  assert.equal(await pending, true);
  assert.deepEqual(seen, ['committed']);
  assert.ok(scopes.includes('own-organization'));
});

test('ownership lost while a background callback is queued stops before opening its organization', async () => {
  let active = true,
    callbacks = 0,
    opened = 0;
  const scheduler = createNotificationScheduler({
    organizations: () => ['organization'],
    *work() {
      opened++;
      yield;
    },
  });
  const completed = await scheduler.scheduleBatched({
    canRun: () => active,
    async runWork(callback) {
      callbacks++;
      await turn();
      active = false;
      return callback();
    },
  });
  assert.equal(completed, false);
  assert.equal(callbacks, 1);
  assert.equal(opened, 0);
  assert.equal(scheduler.schedule(), true, 'cancelled pass releases only its scan guard');
});

test('expired intent recovery yields after one committed unit and retains the remaining work on stop', async () => {
  let active = true,
    recovered = 0;
  const runner = createDueRunner({
    kind: 'client',
    clock: () => 1,
    recover: () => {
      recovered++;
      return 1;
    },
    schedule: {
      nextDirty: () => assert.fail('remaining scan must not run after ownership loss'),
    },
  });
  assert.equal(
    await runner.scheduleBatched({
      canRun: () => active,
      runWork(callback) {
        const result = callback();
        if (recovered) active = false;
        return result;
      },
    }),
    false,
  );
  assert.equal(recovered, 1, 'ten tenant opens may not hide in the first iterator step');
});

test('a queued managed Push callback cannot claim after stop or release a live slot before settlement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let current = true,
    claims = 0,
    sends = 0;
  const queued = [];
  let settle;
  const actual = new Promise((resolve) => {
    settle = resolve;
  });
  const managed = createManagedPushDelivery({
    store: {
      peekManaged: () => ({ next_at: 1 }),
      claimManaged: () => ({
        id: String(++claims),
        next_at: 1,
        device_id: 'device',
        organization_id: 'org',
      }),
    },
    clock: () => 1,
    monotonic: () => 0,
    current: () => current,
    active: () => current,
    available: () => true,
    manualRunning: () => false,
    plan() {},
    onError() {},
    deliver: async () => {
      sends++;
      await actual;
      return { outcome: 'sent' };
    },
    runBackgroundWork: (callback) =>
      new Promise((resolve) => queued.push(() => resolve(callback()))),
  });
  t.after(() => {
    current = false;
    managed.stop();
    settle();
  });
  managed.start(1);
  t.mock.timers.tick(0);
  assert.equal(claims, 0);
  current = false;
  queued.shift()();
  await turn();
  assert.equal(claims, 0);
  assert.equal(sends, 0);
  current = true;
  managed.start(2);
  t.mock.timers.tick(0);
  queued.shift()();
  await turn();
  assert.equal(claims, 1);
  assert.equal(sends, 1);
  assert.equal(managed.active, 1);
  current = false;
  managed.stop();
  assert.equal(managed.active, 1, 'stop does not fabricate provider settlement');
  settle();
  await turn();
  assert.equal(managed.active, 0);
});

test('schema18 managed Push planning is charged to the existing observed-work bank and trusted scope', async (t) => {
  const { scheduleFixture } = require('./helpers/notification-schedule-fixture.cjs');
  const { createPushRuntime } = require('../src/server/modules/notifications/push-runtime.cjs');
  const f = scheduleFixture(t);
  f.device();
  f.database.db
    .prepare('INSERT INTO work_schedule_days VALUES(?,?,?,?)')
    .run(
      'org',
      'owner',
      '2030-01-03',
      f.database.seal({ status: 'working', intervals: [['10:00', '12:00']] }),
    );
  let mono = 0;
  const scopes = [],
    original = f.platform.workSchedules.futureDays;
  f.platform.workSchedules.futureDays = (...args) => {
    mono += 6;
    return original(...args);
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const runtime = createPushRuntime({
    platform: f.platform,
    tenantStore: f.tenantStore,
    enabled: true,
    origin: 'https://synthetic.test',
    clock: f.clock,
    monotonic: () => mono,
    send: () => assert.fail('future workday must not send'),
    runBackgroundWork(callback, org) {
      scopes.push(org);
      return callback();
    },
  });
  t.after(() => runtime.stop());
  runtime.start();
  for (let n = 0; n < 10; n++) {
    mono += 100;
    f.advance(100);
    t.mock.timers.tick(100);
    await turn();
  }
  assert.ok(runtime.stats().syncWorkMs >= 6, 'durable scheduler may not bypass Push accounting');
  assert.ok(scopes.includes('org'), 'owning transaction uses its actual organization');
  assert.equal(
    f.database.db.prepare("SELECT count(*) n FROM notification_schedule WHERE kind='workday'").get()
      .n,
    1,
  );
  runtime.stop();
  t.mock.timers.tick(1000);
  await turn();
});
