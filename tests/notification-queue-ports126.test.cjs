const test = require('node:test');
const assert = require('node:assert/strict');
const { maintenanceFixture } = require('./helpers/notification-maintenance-fixture.cjs');
const {
  createNotificationStore,
} = require('../src/server/modules/notifications/notification-store.cjs');
const { createTelegramStore } = require('../src/server/modules/notifications/telegram-store.cjs');
const { createStaffQueue } = require('../src/server/modules/notifications/staff-queue.cjs');
const { createPushQueue } = require('../src/server/modules/notifications/push-queue.cjs');
const {
  createQueueMaintenance,
} = require('../src/server/modules/notifications/queue-maintenance.cjs');
function ports(f) {
  const admissions = [],
    writes = [];
  let active = '';
  const enter = (kind, work) => {
    if (f.c.db.isTransaction) return work();
    admissions.push(kind);
    return f.c.transaction(() => {
      active = kind;
      try {
        return work();
      } finally {
        active = '';
      }
    });
  };
  const c = {
    ...f.c,
    fail: require('../src/shared/errors.cjs').fail,
    organizationTimeZone: f.platform.organizationTimeZone,
    db: {
      get isTransaction() {
        return f.c.db.isTransaction;
      },
      prepare(sql) {
        const statement = f.c.db.prepare(sql);
        return {
          get: (...args) => statement.get(...args),
          all: (...args) => statement.all(...args),
          run(...args) {
            if (/^(INSERT|UPDATE|DELETE)/.test(sql)) writes.push({ kind: active, sql });
            return statement.run(...args);
          },
        };
      },
    },
    transaction: (work) => enter('critical', work),
    queueTransaction: (work) => enter('queue', work),
    asyncQueueTransaction: async (work) => enter('asyncQueue', work),
  };
  return { c, admissions, writes };
}
test('real notification claims, lease transitions and finishes use queue ports without admitting policy writes', async (t) => {
  const f = await maintenanceFixture(t, { enabled: false, prepared: false });
  const p = ports(f),
    now = f.clock();
  f.client('client');
  const client = createNotificationStore(p.c),
    job = client.claimManaged(now, ['telegram']);
  assert.equal(job.id, 'client');
  assert.equal(client.transition(job, 'reserved', 'sending', 0, now), true);
  assert.equal(client.transition(job, 'sending', 'sent', 0, now, { messageId: 'synthetic' }), true);
  for (const channel of ['telegram', 'max']) {
    f.staff(channel, channel);
    const queue = createStaffQueue(
      p.c,
      { interest: { hasEnabledRecipients: () => true } },
      channel,
    );
    const claimed = queue.claimManaged(now);
    assert.equal(claimed.id, channel);
    assert.equal(queue.finish(claimed, 'sent'), true);
    assert.equal(
      queue.finish(claimed, 'pending', now + 1000, true),
      false,
      'late refund cannot revive an ACK',
    );
  }
  f.staff('push', 'push');
  const push = createPushQueue(p.c, { runtimeAvailable: () => true, hasEnabledEvents: () => true });
  const claimed = push.claimManaged(now);
  assert.equal(claimed.id, 'push');
  assert.equal(push.deferUnstarted(claimed, now + 1000), 1);
  assert.equal(push.finish(claimed, 'sent'), 0, 'old lease cannot finish refunded work');
  f.c.db
    .prepare(
      "INSERT INTO telegram_jobs(id,organization_id,patient_id,fingerprint,callback_hash,value,status,next_at,expires_at) VALUES(?,?,?,?,?,?,'pending',?,?)",
    )
    .run(
      'legacy',
      f.owner.organizationId,
      'synthetic',
      'legacy',
      f.c.tokenHash('callback'),
      f.c.seal({ callback: 'callback' }),
      now,
      now + 60000,
    );
  const legacy = createTelegramStore(p.c),
    telegram = legacy.claimManaged(now);
  assert.equal(telegram.id, 'legacy');
  assert.equal(legacy.defer(telegram, now + 1000), true);
  assert.equal(legacy.finish(telegram, 'sent'), false);
  assert.ok(p.admissions.length >= 12);
  assert.ok(p.admissions.every((kind) => kind === 'queue'));
  assert.ok(
    p.writes.every(
      ({ kind, sql }) =>
        kind === 'queue' &&
        /(?:notification_channel_jobs|staff_notification_jobs|staff_max_jobs|staff_push_jobs|telegram_jobs|telegram_runtime)/.test(
          sql,
        ),
    ),
  );
  const explicit = createStaffQueue(
    p.c,
    { interest: { hasEnabledRecipients: () => true } },
    'telegram',
  );
  f.staff('telegram', 'legacy-prune');
  const beforeLegacy = p.admissions.length;
  assert.equal(explicit.claim(now).id, 'legacy-prune');
  assert.deepEqual(
    p.admissions.slice(beforeLegacy),
    ['critical'],
    'range-pruning legacy API keeps its stricter fence',
  );
  assert.equal(
    f.c.db.prepare("SELECT status FROM notification_channel_jobs WHERE id='client'").get().status,
    'sent',
  );
});
test('confirmation retains the critical transaction and rollback; settings still deny a nonadministrator', async (t) => {
  const f = await maintenanceFixture(t, { enabled: false, prepared: false }),
    p = ports(f),
    now = f.clock();
  f.client('client');
  const client = createNotificationStore(p.c),
    job = client.claimManaged(now, ['telegram']);
  p.admissions.length = 0;
  p.writes.length = 0;
  assert.throws(
    () =>
      client.transaction(() => {
        client.transition(job, 'reserved', 'sending', 0, now);
        client.confirm(job, now);
        throw Error('synthetic rollback');
      }),
    /synthetic rollback/,
  );
  assert.deepEqual(p.admissions, ['critical']);
  assert.equal(f.c.db.prepare('SELECT count(*) n FROM notification_confirmations').get().n, 0);
  assert.equal(
    f.c.db
      .prepare(
        "SELECT count(*) n FROM platform_audit WHERE event='notification_appointment_confirmed'",
      )
      .get().n,
    0,
  );
  assert.equal(
    f.c.db.prepare("SELECT status FROM notification_channel_jobs WHERE id='client'").get().status,
    'reserved',
  );
  client.transaction(() => client.confirm(job, now));
  assert.equal(f.c.db.prepare('SELECT count(*) n FROM notification_confirmations').get().n, 1);
  assert.equal(
    f.c.db
      .prepare(
        "SELECT count(*) n FROM platform_audit WHERE event='notification_appointment_confirmed'",
      )
      .get().n,
    1,
  );
  const telegram = createTelegramStore(p.c);
  assert.throws(
    () =>
      telegram.saveReminderPeriod(f.owner.organizationId, f.users[2].accountId, {
        leadMinutes: 30,
        expectedLeadMinutes: 1440,
      }),
    (error) => error.status === 403,
  );
  assert.ok(p.admissions.every((kind) => kind === 'critical'));
  assert.equal(telegram.settings(f.owner.organizationId).leadMinutes, 1440);
  assert.ok(
    p.writes.some(
      ({ sql, kind }) =>
        kind === 'critical' && sql.startsWith('INSERT INTO notification_confirmations'),
    ),
  );
});
test('managed cleanup enters the async queue port and retains its original finite row budget', async (t) => {
  const f = await maintenanceFixture(t),
    p = ports(f),
    now = f.clock();
  for (let n = 0; n < 140; n++) f.client('expired-' + n, { expires: now });
  const maintenance = createQueueMaintenance(p.c, {
    enabled: true,
    clock: f.clock,
    monotonic: () => 0,
  });
  t.after(() => maintenance.stop());
  assert.deepEqual(await maintenance.tick({ canRun: () => true }), { examined: 128, changed: 128 });
  assert.deepEqual(p.admissions, ['asyncQueue']);
  assert.ok(p.writes.every(({ kind }) => kind === 'asyncQueue'));
  assert.equal(
    f.c.db.prepare("SELECT count(*) n FROM notification_channel_jobs WHERE status='pending'").get()
      .n,
    12,
  );
});
