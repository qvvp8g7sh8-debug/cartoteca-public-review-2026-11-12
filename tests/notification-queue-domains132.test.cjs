const test = require('node:test');
const assert = require('node:assert/strict');
const { maintenanceFixture } = require('./helpers/notification-maintenance-fixture.cjs');
const {
  createNotificationStore,
} = require('../src/server/modules/notifications/notification-store.cjs');
const { createStaffQueue } = require('../src/server/modules/notifications/staff-queue.cjs');
const { createPushQueue } = require('../src/server/modules/notifications/push-queue.cjs');
const { createMaxInbox } = require('../src/server/modules/notifications/max-inbox.cjs');
const {
  createQueueMaintenance,
} = require('../src/server/modules/notifications/queue-maintenance.cjs');
const {
  createNotificationWorker,
} = require('../src/server/modules/notifications/notification-worker.cjs');

test('actual queue stores pass fixed domains while MAX capacity/dedupe and legacy prune retain critical ownership', async (t) => {
  const f = await maintenanceFixture(t, { enabled: false, prepared: false }),
    seen = [],
    now = f.clock();
  const enter = (domain, callback) => {
    if (f.c.db.isTransaction) return callback();
    seen.push(domain);
    return f.c.transaction(callback);
  };
  const c = {
    ...f.c,
    fail: require('../src/shared/errors.cjs').fail,
    transaction: (callback) => enter('critical', callback),
    queueTransaction: (callback, domain) => enter(domain, callback),
  };
  f.client('client');
  const client = createNotificationStore(c),
    job = client.claimManaged(now, ['telegram']);
  client.transition(job, 'reserved', 'sending');
  client.transition(job, 'sending', 'sent');
  assert.deepEqual(seen.splice(0), ['client', 'client', 'client']);
  for (const channel of ['telegram', 'max']) {
    f.staff(channel, channel);
    const staff = createStaffQueue(c, { interest: { hasEnabledRecipients: () => true } }, channel);
    const row = staff.claimManaged(now);
    staff.finish(row, 'sent');
    assert.deepEqual(seen.splice(0), ['staff-' + channel, 'staff-' + channel]);
    f.staff(channel, 'legacy-' + channel);
    staff.claim(now);
    assert.deepEqual(seen.splice(0), ['critical']);
  }
  f.staff('push', 'push');
  const push = createPushQueue(c, { runtimeAvailable: () => true, hasEnabledEvents: () => true });
  const pushed = push.claimManaged(now);
  push.finish(pushed, 'sent');
  assert.deepEqual(seen.splice(0), ['push', 'push']);
  const inbox = createMaxInbox(c),
    event = { update_type: 'bot_started', timestamp: now, user: { user_id: '456', is_bot: false } };
  inbox.accept('123', event, now);
  inbox.accept('123', event, now);
  assert.deepEqual(seen.splice(0), ['critical', 'critical']);
  inbox.acquire('123', 'synthetic-owner', now);
  const row = inbox.claim('123', now);
  inbox.saveResult(row, {});
  inbox.finish(row, 'done');
  assert.deepEqual(seen.splice(0), ['max-inbox', 'max-inbox', 'max-inbox', 'max-inbox']);
});

test('real maintenance phase passes its fixed queue domain through async writer admission', async (t) => {
  const f = await maintenanceFixture(t),
    now = f.clock(),
    seen = [];
  f.client('expired-client', { expires: now });
  const maintenance = createQueueMaintenance(
    {
      ...f.c,
      asyncQueueTransaction(callback, options) {
        seen.push(options.queueDomain);
        return f.c.asyncTransaction(callback);
      },
    },
    { enabled: true, clock: f.clock, monotonic: () => 0 },
  );
  t.after(() => maintenance.stop());
  await maintenance.tick({ canRun: () => true });
  assert.deepEqual(seen, ['client']);
});

test('managed delivery uses its queue transaction at the outer boundary and keeps confirmation critical', async () => {
  const calls = [],
    now = 100000,
    job = {
      id: 'synthetic-job',
      organization_id: 'org',
      patient_id: 'patient',
      status: 'pending',
      lease_until: now + 120000,
      decoded: {
        channel: 'telegram',
        kind: 'reminder',
        recipient: { chatId: 'synthetic' },
        callback: 'synthetic',
      },
    };
  let admitted = false;
  const store = {
    transaction(callback) {
      calls.push('critical');
      return callback();
    },
    deliveryTransaction(callback) {
      assert.equal(admitted, true);
      calls.push('client');
      return callback();
    },
    deliveryReadMode: 'DEFERRED',
    claimManaged() {
      if (job.status !== 'pending') return null;
      job.status = 'reserved';
      return job;
    },
    transition(_job, before, after) {
      if (job.status !== before) return false;
      job.status = after;
      return true;
    },
  };
  const worker = createNotificationWorker({
    store,
    platform: {
      telegram: {
        link: () => null,
        messageIdentity: () => ({ organization: { name: 'Synthetic' } }),
      },
      organization: () => ({ phone: '' }),
    },
    tenantStore: () => ({
      transaction(callback, mode) {
        calls.push(mode || 'IMMEDIATE');
        return callback();
      },
    }),
    policy: {
      readyChannels: () => ['telegram'],
      valid: () => ({
        a: { date: '2099-01-01', time: '10:00', duration: 30 },
        settings: { showServices: false },
      }),
    },
    providers: {
      telegram: {
        status: () => ({ configured: true, connected: true }),
        acquire: async () => true,
        async send() {
          assert.equal(admitted, true);
          calls.push('send');
          return { message_id: 1 };
        },
        release() {},
      },
    },
    clock: () => now,
    async runBackgroundWork(callback) {
      admitted = true;
      try {
        return callback();
      } finally {
        admitted = false;
      }
    },
  });
  await worker.tickManaged(null);
  assert.equal(job.status, 'sent');
  assert.deepEqual(calls, ['client', 'DEFERRED', 'send']);
  worker.locked(job, () => calls.push('confirm'));
  assert.deepEqual(calls.slice(3), ['critical', 'IMMEDIATE', 'confirm']);
});
