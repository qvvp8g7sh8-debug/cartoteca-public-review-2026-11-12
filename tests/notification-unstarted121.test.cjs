const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { maintenanceFixture } = require('./helpers/notification-maintenance-fixture.cjs');
const { createPushQueue } = require('../src/server/modules/notifications/push-queue.cjs');
const { createPushRuntime } = require('../src/server/modules/notifications/push-runtime.cjs');
const {
  createTelegramRuntime,
} = require('../src/server/modules/notifications/telegram-runtime.cjs');
const { createTelegramStore } = require('../src/server/modules/notifications/telegram-store.cjs');
const turn = () => new Promise(setImmediate);
async function settleTurns() {
  for (let n = 0; n < 6; n++) await turn();
}
const pushQueue = (f) =>
  createPushQueue(f.c, {
    runtimeAvailable: () => true,
    hasEnabledEvents: () => false,
    hasPendingTests: () => true,
  });
const savedPush = (f) => f.c.db.prepare("SELECT * FROM staff_push_jobs WHERE id='job'").get();
function subscription() {
  const key = crypto.createECDH('prime256v1');
  key.generateKeys();
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/unstarted121',
    keys: {
      p256dh: key.getPublicKey().toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url'),
    },
  };
}

test('unstarted Push refund is exact, idempotent and cannot revive a cancelled or newer lease', async (t) => {
  const f = await maintenanceFixture(t, { enabled: false, prepared: false }),
    now = f.clock();
  f.staff('push', 'job');
  const queue = pushQueue(f),
    first = queue.claimManaged(now);
  assert.equal(queue.deferUnstarted(first, now + 1000), 1);
  assert.equal(queue.deferUnstarted(first, now + 1000), 0);
  assert.equal(savedPush(f).attempts, 0);
  assert.equal(savedPush(f).status, 'pending');
  const second = queue.claimManaged(now + 1000);
  assert.notEqual(first.lease_id, second.lease_id);
  assert.equal(queue.deferUnstarted(first, now + 1000), 0);
  assert.equal(savedPush(f).lease_id, second.lease_id);
  assert.equal(queue.finish(second, 'cancelled'), 1);
  assert.equal(queue.deferUnstarted(second, now + 1000), 0);
  assert.equal(savedPush(f).status, 'cancelled');
});

for (const mode of ['stop', '499', '503', 'arguments', 'provider-throw'])
  test(
    `managed Push known no-send is refunded, actual provider invocation consumes its attempt: ${mode}`,
    { timeout: 5000 },
    async (t) => {
      const f = await maintenanceFixture(t, { enabled: false, prepared: false }),
        now = f.clock();
      f.staff('push', 'job');
      const queue = pushQueue(f),
        target = subscription();
      let invoked = 0,
        runtime;
      const store = {
        ...queue,
        runtimeAvailable: () => true,
        setRuntimeAvailable() {},
        hasEnabledEvents: () => false,
        hasPendingTests: () => true,
        valid: () => ({ id: 'device', decoded: { subscription: target } }),
        keys: () => {
          if (mode === 'arguments') throw Error('synthetic argument failure');
          return {};
        },
      };
      t.mock.timers.enable({ apis: ['setTimeout'] });
      runtime = createPushRuntime({
        platform: { staffPush: store },
        tenantStore: () => assert.fail('test payload needs no cabinet'),
        enabled: true,
        origin: 'https://synthetic.test',
        clock: f.clock,
        monotonic: () => 0,
        async runBackgroundWork(callback, org) {
          await turn();
          if (org && ['499', '503'].includes(mode))
            throw Object.assign(Error('synthetic admission'), { status: Number(mode) });
          if (org && mode === 'stop') runtime.stop();
          return callback();
        },
        send() {
          invoked++;
          throw Object.assign(Error('synchronous provider failure'), { statusCode: 503 });
        },
      });
      t.after(() => runtime.stop());
      runtime.start();
      t.mock.timers.tick(0);
      await settleTurns();
      const row = savedPush(f);
      assert.equal(row.status, 'pending');
      assert.equal(row.lease_id, null);
      assert.equal(row.lease_until, 0);
      assert.equal(row.attempts, mode === 'provider-throw' ? 1 : 0);
      assert.equal(invoked, mode === 'provider-throw' ? 1 : 0);
      assert.equal(runtime.stats().active, 0, 'no actual provider means no held device slot');
      if (mode !== 'provider-throw') assert.equal(row.next_at, now + 1000);
    },
  );

test(
  'Push cannot refund after a real unresolved send; a later ACK cannot overwrite a newer lease',
  { timeout: 5000 },
  async (t) => {
    const f = await maintenanceFixture(t, { enabled: false, prepared: false });
    f.staff('push', 'job');
    const queue = pushQueue(f),
      target = subscription();
    let resolve, entered;
    const started = new Promise((done) => {
      entered = done;
    });
    const provider = new Promise((done) => {
      resolve = done;
    });
    const store = {
      ...queue,
      runtimeAvailable: () => true,
      setRuntimeAvailable() {},
      hasEnabledEvents: () => false,
      hasPendingTests: () => true,
      valid: () => ({ decoded: { subscription: target } }),
      keys: () => ({}),
    };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const runtime = createPushRuntime({
      platform: { staffPush: store },
      enabled: true,
      origin: 'https://synthetic.test',
      clock: f.clock,
      monotonic: () => 0,
      send: () => {
        entered();
        return provider;
      },
    });
    t.after(() => {
      runtime.stop();
      resolve();
    });
    runtime.start();
    t.mock.timers.tick(0);
    await started;
    runtime.stop();
    assert.equal(savedPush(f).attempts, 1);
    assert.equal(savedPush(f).status, 'sending');
    assert.equal(runtime.stats().active, 1);
    f.c.db
      .prepare(
        "UPDATE staff_push_jobs SET lease_id='replacement',lease_until=lease_until+60000 WHERE id='job'",
      )
      .run();
    resolve();
    await settleTurns();
    assert.equal(savedPush(f).status, 'sending');
    assert.equal(savedPush(f).lease_id, 'replacement');
    assert.equal(runtime.stats().active, 0);
  },
);

for (const mode of ['stop', '499', '503'])
  test(
    `legacy Telegram refunds its exact unstarted reservation after queued admission: ${mode}`,
    { timeout: 5000 },
    async (t) => {
      const f = await maintenanceFixture(t, { enabled: false, prepared: false }),
        now = f.clock();
      f.c.db
        .prepare(
          "INSERT INTO telegram_jobs(id,organization_id,patient_id,fingerprint,callback_hash,value,status,next_at,expires_at) VALUES(?,?,?,?,?,?,'pending',?,?)",
        )
        .run(
          'legacy-job',
          f.owner.organizationId,
          'patient',
          'stamp',
          f.c.tokenHash('callback'),
          f.c.seal({ callback: 'callback', chatId: '123', appointmentId: 'appointment' }),
          now,
          now + 600000,
        );
      const original = createTelegramStore(f.c);
      let claimed = false,
        intercepted = false,
        sends = 0,
        runtime;
      const store = {
        ...original,
        acquirePollLease: () => true,
        releasePollLease() {},
        offset: () => 0,
        hasReminderRecipients: () => true,
        organizationBatch: () => [],
        reminderOrganizationBatch: () => [],
        claimManaged() {
          const job = original.claimManaged(now);
          if (job) claimed = true;
          return job;
        },
      };
      t.mock.timers.enable({ apis: ['setInterval'] });
      runtime = createTelegramRuntime({
        platform: { telegram: store },
        tenantStore: () => assert.fail('queued cancelled validation may not open a cabinet'),
        clock: f.clock,
        pacing: { acquire: async () => true },
        bot: {
          initialize: async () => ({ username: 'Synthetic_bot', botId: 'synthetic' }),
          updates: (_offset, signal) =>
            new Promise((done) => signal.addEventListener('abort', () => done([]), { once: true })),
          send: async () => {
            sends++;
          },
        },
        async runBackgroundWork(callback, org) {
          await turn();
          if (claimed && org && !intercepted) {
            intercepted = true;
            if (mode === 'stop') runtime.stop();
            else throw Object.assign(Error('synthetic admission'), { status: Number(mode) });
          }
          return callback();
        },
      });
      t.after(() => runtime.stop());
      runtime.start();
      await settleTurns();
      t.mock.timers.tick(250);
      await settleTurns();
      const row = f.c.db.prepare("SELECT * FROM telegram_jobs WHERE id='legacy-job'").get();
      assert.equal(intercepted, true);
      assert.equal(sends, 0);
      assert.equal(row.status, 'pending');
      assert.equal(row.attempts, 0);
      assert.equal(row.lease_until, 0);
      assert.equal(row.next_at, now + 1000);
    },
  );
