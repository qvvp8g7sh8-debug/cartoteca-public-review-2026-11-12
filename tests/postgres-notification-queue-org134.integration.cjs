const test = require('node:test');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const { randomUUID, randomBytes, createECDH } = require('node:crypto');
const { postgresBusinessFixture } = require('./helpers/postgres-business133-fixture.cjs');
const { advisoryKey } = require('../src/server/infrastructure/postgres/lock-intents.cjs');
const { createPushRuntime } = require('../src/server/modules/notifications/push-runtime.cjs');
const domains = ['telegram', 'staff-telegram', 'staff-max', 'push', 'client'];
const tableFor = {
  telegram: 'telegram_jobs',
  'staff-telegram': 'staff_notification_jobs',
  'staff-max': 'staff_max_jobs',
  push: 'staff_push_jobs',
  client: 'notification_channel_jobs',
};
const storeFor = (f, domain) =>
  ({
    telegram: f.platform.telegram,
    'staff-telegram': f.platform.staffNotifications,
    'staff-max': f.platform.staffMaxNotifications,
    push: f.platform.staffPush,
    client: f.platform.notificationStore,
  })[domain];
function seed(f, domain, actor, nextAt, options = {}) {
  const id = randomUUID(),
    callback = randomBytes(20).toString('base64url'),
    status = options.status || 'pending';
  const org = actor.organizationId,
    account = actor.accountId,
    now = Date.now();
  const value = f.database.seal({
    callback,
    kind: 'test',
    event: 'test',
    reference: {},
    chatId: 'synthetic-chat',
    bindingId: 'synthetic-push-binding',
    channel: 'telegram',
    channelVersion: domain === 'push' ? 'synthetic-push' : '',
  });
  f.database.transaction(() => {
    const db = f.database.db;
    if (domain === 'telegram')
      db.prepare(
        'INSERT INTO telegram_jobs(id,organization_id,patient_id,fingerprint,callback_hash,value,status,next_at,expires_at,lease_until) VALUES(?,?,?,?,?,?,?,?,?,?)',
      ).run(
        id,
        org,
        'queue-patient',
        id,
        f.database.tokenHash(callback),
        value,
        status,
        nextAt,
        now + 86400000,
        options.leaseUntil || 0,
      );
    else if (domain.startsWith('staff-')) {
      db.prepare(
        `INSERT INTO ${tableFor[domain]}(id,organization_id,account_id,event_key,value,status,next_at,expires_at,lease_until) VALUES(?,?,?,?,?,?,?,?,?)`,
      ).run(id, org, account, id, value, status, nextAt, now + 86400000, options.leaseUntil || 0);
      db.prepare('INSERT INTO telegram_runtime VALUES(?,?)').run(
        'staff-selftest-v1:' + (domain === 'staff-max' ? 'max' : 'telegram') + ':' + id,
        f.database.seal({ active: true }),
      );
    } else if (domain === 'push')
      db.prepare(
        'INSERT INTO staff_push_jobs(id,organization_id,account_id,device_id,event_key,value,status,next_at,expires_at,lease_until) VALUES(?,?,?,?,?,?,?,?,?,?)',
      ).run(
        id,
        org,
        account,
        options.deviceId || 'queue-device-' + org,
        id,
        value,
        status,
        nextAt,
        now + 86400000,
        options.leaseUntil || 0,
      );
    else
      db.prepare(
        'INSERT INTO notification_channel_jobs(id,organization_id,patient_id,appointment_id,stamp,channel,callback_hash,value,status,next_at,expires_at,lease_until) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        id,
        org,
        'queue-patient',
        id,
        id,
        'telegram',
        f.database.tokenHash(callback),
        value,
        status,
        nextAt,
        now + 86400000,
        options.leaseUntil || 0,
      );
  });
  return id;
}
const status = (f, domain, id) =>
  f.database.db.prepare(`SELECT status FROM ${tableFor[domain]} WHERE id=?`).get(id)?.status;
function finish(store, domain, job) {
  if (domain !== 'client') return store.finish(job, 'sent');
  assert.equal(store.transition(job, 'reserved', 'sending'), true);
  return store.transition(job, 'sending', 'sent');
}
test(
  'real notification store ports isolate organization claims, preserve CAS and never start a provider inside a transaction',
  { timeout: 180000 },
  async (t) => {
    const f = await postgresBusinessFixture(t),
      now = Date.now();
    const actors = [f.owner];
    for (let n = 1; n < 9; n++) {
      const actor = await f.platform.registerOwner({
        email: 'queue-' + n + '@scope.synthetic.test',
        password: 'Synthetic-queue-scope-password',
        displayName: 'Synthetic queue owner',
        organizationName: 'Synthetic queue organization',
      });
      f.platform.verifyEmail(actor.verificationToken);
      actors.push(actor);
    }
    f.database.transaction(() => {
      const row = f.database.db
        .prepare("SELECT value FROM telegram_runtime WHERE key='notification-channel-state-v1'")
        .get();
      const channels = f.database.open(row.value);
      channels.max.enabled = true;
      f.database.db
        .prepare("UPDATE telegram_runtime SET value=? WHERE key='notification-channel-state-v1'")
        .run(f.database.seal(channels));
    });
    const key = (org) =>
      advisoryKey('cartoteca:platform-organization:v1:' + f.database.db.scope.storeId + ':' + org);
    const held = new Set();
    async function hold(org) {
      await f.admin.query('SELECT pg_advisory_lock($1::bigint)', [key(org)]);
      held.add(org);
    }
    async function release(org) {
      await f.admin.query('SELECT pg_advisory_unlock($1::bigint)', [key(org)]);
      held.delete(org);
    }
    t.after(async () => {
      for (const org of held)
        await f.admin.query('SELECT pg_advisory_unlock($1::bigint)', [key(org)]);
    });
    for (const domain of domains)
      await t.test(
        domain +
          ' skips a contended organization, claims the next one and rejects stale settlement',
        async () => {
          const store = storeFor(f, domain),
            [a, b] = actors;
          const first = seed(f, domain, a, now - 2000),
            second = seed(f, domain, b, now - 1000);
          await hold(a.organizationId);
          let job;
          try {
            job = domain === 'client' ? store.claim(now, ['telegram']) : store.claim(now);
          } finally {
            await release(a.organizationId);
          }
          assert.ok(job);
          assert.equal(job.id, second);
          assert.equal(job.organization_id, b.organizationId);
          assert.equal(status(f, domain, first), 'pending');
          assert.equal(finish(store, domain, job), domain === 'push' ? 1 : true);
          const stale =
            domain === 'client'
              ? store.transition(job, 'sending', 'sent')
              : store.finish(job, 'sent');
          assert.equal(Boolean(stale), false);
          const original =
            domain === 'client' ? store.claimManaged(now, ['telegram']) : store.claimManaged(now);
          assert.equal(original.id, first);
          finish(store, domain, original);
          assert.equal(status(f, domain, first), 'sent');
        },
      );
    await t.test(
      'client and staff MAX expired sending entries become uncertain and never return to pending',
      () => {
        for (const domain of ['client', 'staff-max']) {
          const id = seed(f, domain, actors[0], now - 1000, {
            status: 'sending',
            leaseUntil: now - 1,
          });
          const store = storeFor(f, domain);
          const job = domain === 'client' ? store.claim(now, ['telegram']) : store.claim(now);
          assert.equal(job, null);
          assert.equal(status(f, domain, id), 'uncertain');
        }
      },
    );
    await t.test(
      'queue settlement inside a callback rolls back atomically and forged organization cannot settle the real lease',
      () => {
        const store = f.platform.staffPush,
          id = seed(f, 'push', actors[0], now - 500);
        const job = store.claim(now);
        assert.equal(job.id, id);
        assert.throws(
          () =>
            store.deliveryFor(job, () => {
              assert.equal(f.database.db.transactionIntent, 'QUEUEORG');
              assert.ok(f.storage.readSelected(['synthetic-0']).patients[0]);
              store.finish(job, 'sent');
              throw Error('Synthetic queue callback rollback');
            }),
          /Synthetic queue callback rollback/,
        );
        assert.equal(status(f, 'push', id), 'sending');
        assert.equal(
          store.finish({ ...job, organization_id: actors[1].organizationId }, 'sent'),
          0,
        );
        assert.equal(status(f, 'push', id), 'sending');
        assert.equal(store.finish(job, 'sent'), 1);
      },
    );
    await t.test(
      'Push validates through the native organization port and invokes only the injected provider after commit',
      async () => {
        const device = f.database.db
          .prepare("SELECT value FROM staff_push_devices WHERE id='synthetic-device'")
          .get();
        const saved = f.database.open(device.value),
          ecdh = createECDH('prime256v1');
        saved.subscription = {
          endpoint: 'https://fcm.googleapis.com/synthetic-never-sent',
          keys: {
            p256dh: ecdh.generateKeys().toString('base64url'),
            auth: randomBytes(16).toString('base64url'),
          },
        };
        f.database.transaction(() =>
          f.database.db
            .prepare("UPDATE staff_push_devices SET value=? WHERE id='synthetic-device'")
            .run(f.database.seal(saved)),
        );
        const id = seed(f, 'push', actors[0], now - 100, { deviceId: 'synthetic-device' });
        let delivered = 0,
          scoped = 0;
        const original = f.platform.staffPush.deliveryFor;
        const store = {
          ...f.platform.staffPush,
          hasEnabledEvents: () => false,
          hasPendingTests: () => true,
          deliveryFor(job, work) {
            scoped++;
            return original(job, work);
          },
        };
        const runtime = createPushRuntime({
          platform: { ...f.platform, staffPush: store },
          tenantStore: () => f.storage,
          origin: 'https://synthetic.invalid',
          enabled: true,
          clock: () => now,
          send: async () => {
            assert.equal(f.database.db.transactionIntent, null);
            delivered++;
          },
        });
        runtime.start();
        try {
          await runtime.tick(1);
        } finally {
          runtime.stop();
        }
        assert.equal(delivered, 1);
        assert.ok(scoped > 0);
        assert.equal(status(f, 'push', id), 'sent');
      },
    );
    await t.test(
      'actual durable client due dispatch creates and restarts a cancelled Telegram job in one scoped transaction',
      () => {
        const {
          createClientDueScheduler,
        } = require('../src/server/modules/notifications/client-due-scheduler.cjs');
        const {
          createNotificationPolicy,
        } = require('../src/server/modules/notifications/notification-policy.cjs');
        const { fingerprint } = require('../src/server/modules/notifications/appointments.cjs');
        const { db } = f.database,
          schedule = f.platform.notificationSchedule;
        let dueNow = f.now,
          enqueues = 0;
        const enqueueEffects = [];
        const appointment = f.storage.readSelected(['synthetic-0']).patients[0].appointments[0];
        const stamp = fingerprint(appointment, 'Europe/Moscow');
        const policy = createNotificationPolicy({
          platform: f.platform,
          tenantStore: f.context.tenantStore,
          store: f.platform.notificationStore,
          links: f.platform.maxLinks,
          providers: {
            telegram: {
              status: () => ({ configured: true, connected: true, botId: 'synthetic-bot' }),
            },
          },
          clock: () => dueNow,
        });
        const scheduler = createClientDueScheduler({
          platform: f.platform,
          tenantStore: f.context.tenantStore,
          store: f.platform.notificationStore,
          links: f.platform.maxLinks,
          policy,
          clock: () => dueNow,
          enqueue(org, patient, id, onEntered) {
            return schedule.transaction(() => {
              onEntered();
              assert.equal(db.transactionIntent, 'QUEUEORG');
              assert.equal(db.scopedQueue.queueDomain, 'schedule');
              assert.equal(db.scopedQueue.organizationId, f.org);
              const prepared = f.storage.readOnlySnapshot(() => {
                const current = policy.current(org, patient, id, null, { kind: 'reminder' });
                assert.ok(current && !current.confirmed);
                return {
                  appointment: current.a,
                  stamp: fingerprint(current.a, current.settings.timeZone),
                  recipient: f.platform.telegram.link(org, patient),
                  expiresAt: current.expiresAt,
                };
              });
              // The pure cabinet snapshot has ended; the outer organization
              // transaction still owns these rows and the platform queue write.
              assert.equal(db.transactionIntent, 'QUEUEORG');
              const before = db
                .prepare(
                  'SELECT * FROM telegram_jobs WHERE organization_id=? AND patient_id=? AND fingerprint=?',
                )
                .get(org, patient, prepared.stamp);
              f.platform.telegram.enqueue(
                org,
                patient,
                prepared.appointment,
                prepared.stamp,
                prepared.recipient,
                prepared.expiresAt,
                dueNow,
              );
              const after = db
                .prepare(
                  'SELECT * FROM telegram_jobs WHERE organization_id=? AND patient_id=? AND fingerprint=?',
                )
                .get(org, patient, prepared.stamp);
              enqueueEffects.push({ before, after });
              enqueues++;
            }, org);
          },
        });
        const foreignBefore = db
          .prepare('SELECT * FROM telegram_jobs WHERE organization_id=? ORDER BY id')
          .all(actors[1].organizationId);
        f.database.transaction(() => {
          db.prepare('DELETE FROM notification_schedule_dirty WHERE organization_id=?').run(f.org);
          schedule.markDirty(f.org, 'client', 'synthetic-0');
        });
        assert.equal(scheduler.schedule(), true);
        const job = db
          .prepare(
            'SELECT * FROM telegram_jobs WHERE organization_id=? AND patient_id=? AND fingerprint=?',
          )
          .get(f.org, 'synthetic-0', stamp);
        assert.ok(job);
        assert.equal(job.status, 'pending');
        assert.equal(enqueues, 1);
        f.database.transaction(() => {
          db.prepare(
            "UPDATE telegram_jobs SET status='cancelled',value=? WHERE id=? AND organization_id=?",
          ).run(
            f.database.seal({
              ...f.database.open(job.value),
              serviceFingerprint: 'synthetic-previous-service',
            }),
            job.id,
            f.org,
          );
          const link = db
            .prepare(
              'SELECT chat_hash FROM telegram_links WHERE organization_id=? AND patient_id=?',
            )
            .get(f.org, 'synthetic-0');
          db.prepare('INSERT INTO telegram_confirmations VALUES(?,?,?,?,?)').run(
            f.org,
            'synthetic-0',
            stamp,
            link.chat_hash,
            dueNow,
          );
          schedule.markDirty(f.org, 'client', 'synthetic-0');
        });
        dueNow += 31000;
        assert.equal(scheduler.schedule(), true);
        const restarted = db.prepare('SELECT * FROM telegram_jobs WHERE id=?').get(job.id);
        assert.equal(restarted.status, 'pending');
        assert.equal(restarted.attempts, 0);
        assert.notEqual(restarted.callback_hash, job.callback_hash);
        // Removing a stale receipt dirties this client again. That extra real
        // planner invocation must deduplicate the already restarted job exactly.
        assert.equal(enqueues, 3);
        assert.equal(
          enqueueEffects.filter(({ before, after }) => !isDeepStrictEqual(before, after)).length,
          2,
          'only initial insert and cancelled restart change the queue',
        );
        assert.deepEqual(enqueueEffects[2].before, enqueueEffects[1].after);
        assert.deepEqual(
          enqueueEffects[2].after,
          enqueueEffects[2].before,
          'receipt-triggered planner pass does not rotate callback or ciphertext',
        );
        assert.equal(
          db
            .prepare(
              'SELECT count(*) n FROM telegram_jobs WHERE organization_id=? AND patient_id=? AND fingerprint=?',
            )
            .get(f.org, 'synthetic-0', stamp).n,
          1,
        );
        assert.equal(scheduler.schedule(), true);
        assert.equal(enqueues, 3, 'idle pass at the same clock does not enqueue again');
        assert.deepEqual(
          db.prepare('SELECT * FROM telegram_jobs WHERE id=?').get(job.id),
          restarted,
        );
        assert.equal(
          db
            .prepare(
              'SELECT count(*) n FROM telegram_confirmations WHERE organization_id=? AND patient_id=? AND fingerprint=?',
            )
            .get(f.org, 'synthetic-0', stamp).n,
          0,
        );
        assert.deepEqual(
          db
            .prepare('SELECT * FROM telegram_jobs WHERE organization_id=? ORDER BY id')
            .all(actors[1].organizationId),
          foreignBefore,
        );
      },
    );
    await t.test(
      'actual client worker formats current owned data and starts the injected provider only after sending commit',
      async () => {
        const {
          createNotificationCoordinator,
        } = require('../src/server/modules/notifications/notification-coordinator.cjs');
        const { db } = f.database;
        let sent = 0,
          formatted = 0;
        const coordinator = createNotificationCoordinator({
          platform: f.platform,
          tenantStore: f.context.tenantStore,
          store: f.platform.notificationStore,
          links: f.platform.maxLinks,
          clock: () => f.now + 31000,
          providers: {
            telegram: {
              status: () => ({ configured: true, connected: true, botId: 'synthetic-bot' }),
              acquire: async () => {
                assert.equal(db.transactionIntent, null);
                return true;
              },
              send: async (payload) => {
                assert.equal(db.transactionIntent, null);
                assert.match(payload.text, /13:00/);
                assert.equal(
                  db
                    .prepare(
                      'SELECT status FROM notification_channel_jobs WHERE organization_id=? AND appointment_id=?',
                    )
                    .get(f.org, 'seed-booking-0').status,
                  'sending',
                );
                sent++;
                return { message_id: 321 };
              },
            },
          },
        });
        coordinator.remind(f.org, 'synthetic-0', 'seed-booking-0');
        const identity = f.platform.telegram.messageIdentity;
        f.platform.telegram.messageIdentity = (...args) => {
          assert.equal(db.transactionIntent, 'QUEUEORG');
          assert.equal(db.scopedQueue.organizationId, f.org);
          assert.equal(db.scopedQueue.queueDomain, 'client');
          formatted++;
          return identity(...args);
        };
        try {
          await coordinator.tick(null);
        } finally {
          f.platform.telegram.messageIdentity = identity;
        }
        assert.equal(formatted, 1);
        assert.equal(sent, 1);
        assert.equal(
          db
            .prepare(
              'SELECT status FROM notification_channel_jobs WHERE organization_id=? AND appointment_id=?',
            )
            .get(f.org, 'seed-booking-0').status,
          'sent',
        );
      },
    );
    await t.test(
      'eight real busy organizations cannot keep the ninth organization behind them on the next bounded claim turn',
      async () => {
        const ids = actors.map((actor, n) => seed(f, 'push', actor, now - 1000 + n));
        for (const actor of actors.slice(0, 8)) await hold(actor.organizationId);
        try {
          const store = f.platform.staffPush;
          assert.equal(store.claim(now), null);
          const ninth = store.claim(now);
          assert.equal(ninth.id, ids[8]);
          assert.equal(ninth.organization_id, actors[8].organizationId);
          assert.equal(store.finish(ninth, 'sent'), 1);
          for (const id of ids.slice(0, 8)) assert.equal(status(f, 'push', id), 'pending');
        } finally {
          for (const actor of actors.slice(0, 8)) await release(actor.organizationId);
        }
      },
    );
  },
);
