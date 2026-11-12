const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { postgresBusinessFixture } = require('./helpers/postgres-business133-fixture.cjs');
const {
  createNotificationCoordinator,
} = require('../src/server/modules/notifications/notification-coordinator.cjs');
const {
  createWorkdayDueScheduler,
} = require('../src/server/modules/notifications/workday-due-scheduler.cjs');
const { publicSubmit } = require('../src/server/modules/booking/public-service.cjs');
const { fingerprint } = require('../src/server/modules/notifications/appointments.cjs');

test(
  'PG3 real scheduler and coordinator preserve scoped planning, fresh rights and atomic booking effects',
  { timeout: 120000 },
  async (t) => {
    const f = await postgresBusinessFixture(t),
      { db, seal } = f.database;
    let now = f.now;
    const providers = {
      telegram: {
        status: () => ({ configured: true, connected: true, botId: 'synthetic-bot' }),
        send: () => assert.fail('No external delivery during planning'),
      },
    };
    const coordinator = createNotificationCoordinator({
      platform: f.platform,
      tenantStore: f.context.tenantStore,
      store: f.platform.notificationStore,
      links: f.platform.maxLinks,
      providers,
      clock: () => now,
    });
    const jobs = () =>
      db
        .prepare('SELECT * FROM notification_channel_jobs WHERE organization_id=? ORDER BY id')
        .all(f.org);
    const effects = () => ({
      patients: f.storage.read().patients,
      jobs: jobs(),
      staff: db
        .prepare('SELECT * FROM staff_notification_jobs WHERE organization_id=? ORDER BY id')
        .all(f.org),
      push: db
        .prepare('SELECT * FROM staff_push_jobs WHERE organization_id=? ORDER BY id')
        .all(f.org),
      dirty: db
        .prepare(
          'SELECT * FROM notification_schedule_dirty WHERE organization_id=? ORDER BY kind,subject',
        )
        .all(f.org),
    });
    await t.test(
      'client enqueue uses compound journal, cancels only legacy pending and failed fresh authority rolls back both effects',
      () => {
        const a = f.storage.readSelected(['synthetic-0']).patients[0].appointments[0];
        f.database.transaction(() =>
          db
            .prepare(
              "INSERT INTO telegram_jobs(id,organization_id,patient_id,fingerprint,callback_hash,value,status,next_at,expires_at) VALUES(?,?,?,?,?,?,'pending',?,?)",
            )
            .run(
              randomUUID(),
              f.org,
              'synthetic-0',
              fingerprint(a, 'Europe/Moscow'),
              randomUUID(),
              seal({}),
              now,
              now + 86400000,
            ),
        );
        const original = effects();
        assert.throws(
          () =>
            coordinator.remind(f.org, 'synthetic-0', a.id, () => {
              assert.equal(db.transactionIntent, 'COMPOUND');
              throw Object.assign(Error('Synthetic fresh revocation'), { status: 403 });
            }),
          /Synthetic fresh revocation/,
        );
        assert.deepEqual(effects(), original);
        const job = coordinator.remind(f.org, 'synthetic-0', a.id, () =>
          assert.equal(db.transactionIntent, 'COMPOUND'),
        );
        assert.ok(job);
        assert.equal(jobs().length, 1);
        assert.equal(
          db.prepare('SELECT status FROM telegram_jobs WHERE organization_id=?').get(f.org).status,
          'cancelled',
        );
        coordinator.remind(f.org, 'synthetic-0', a.id);
        assert.equal(jobs().length, 1, 'dedupe survives another scoped enqueue');
      },
    );
    await t.test(
      'classic public booking with actual coordinator reuses outer compound transaction and rolls back a late finalizer error',
      () => {
        f.setMode('classic');
        const patient = f.storage.readSelected(['synthetic-0']).patients[0];
        const input = f.input({
          phone: patient.phone,
          firstName: patient.firstName,
          lastName: patient.lastName,
        });
        let bookedCalls = 0;
        const context = {
          ...f.context,
          notificationCoordinator: {
            booked(...args) {
              assert.equal(db.transactionIntent, 'COMPOUND');
              bookedCalls++;
              return coordinator.booked(...args);
            },
          },
        };
        const original = effects(),
          finish = f.platform.bookingRequests.finish;
        let observed = 0;
        f.platform.bookingRequests.finish = (...args) => {
          assert.equal(db.transactionIntent, 'COMPOUND');
          assert.equal(bookedCalls, 1, 'actual coordinator was invoked inside outer transaction');
          assert.equal(
            jobs().length,
            original.jobs.length,
            'dormant automatic classic notice remains disabled',
          );
          observed++;
          throw Error('Synthetic finalizer after coordinator');
        };
        try {
          assert.throws(
            () => publicSubmit(context, f.org, input, now),
            /Synthetic finalizer after coordinator/,
          );
        } finally {
          f.platform.bookingRequests.finish = finish;
        }
        assert.equal(observed, 1);
        assert.deepEqual(
          effects(),
          original,
          'cabinet, notice and staff effects roll back together',
        );
        assert.equal(publicSubmit(context, f.org, input, now).status, 'booked');
        const committed = effects();
        assert.equal(bookedCalls, 2);
        assert.equal(committed.jobs.length, original.jobs.length);
        assert.equal(publicSubmit(context, f.org, input, now + 1).status, 'booked');
        const replayed = effects();
        assert.equal(bookedCalls, 2, 'a completed form does not invoke the coordinator again');
        assert.deepEqual(
          { ...replayed, dirty: undefined },
          { ...committed, dirty: undefined },
          'same public form does not create another appointment or queue effect',
        );
        assert.deepEqual(
          replayed.dirty,
          committed.dirty.map((row) =>
            row.kind === 'client' && row.subject === ''
              ? { ...row, version: row.version + 1, cursor: '' }
              : row,
          ),
          'the existing public receipt deliberately refreshes only its durable planning hint',
        );
      },
    );
    await t.test(
      'expired intent recovery uses organization schedule admission and readonly matching cabinet; callback failure keeps intent',
      () => {
        const schedule = f.platform.notificationSchedule;
        f.database.transaction(() =>
          db
            .prepare('DELETE FROM notification_schedule_intents WHERE organization_id=?')
            .run(f.org),
        );
        const intent = schedule.beginIntent(f.org, 'synthetic-recovery', now - 121000);
        assert.throws(
          () =>
            schedule.recoverExpired(
              () => {
                assert.equal(db.transactionIntent, 'QUEUEORG');
                throw Error('Synthetic recovery rollback');
              },
              now,
              1,
            ),
          /Synthetic recovery rollback/,
        );
        assert.ok(
          db.prepare('SELECT id FROM notification_schedule_intents WHERE id=?').get(intent.id),
        );
        let visited = 0;
        schedule.recoverExpired(
          (org) => {
            assert.equal(org, f.org);
            assert.equal(db.transactionIntent, 'QUEUEORG');
            assert.equal(db.scopedQueue.queueDomain, 'schedule');
            f.storage.readOnlySnapshot(() =>
              assert.equal(f.storage.readSelected(['synthetic-0']).patients.length, 1),
            );
            visited++;
          },
          now,
          1,
        );
        assert.equal(visited, 1);
        assert.equal(
          db.prepare('SELECT id FROM notification_schedule_intents WHERE id=?').get(intent.id),
          undefined,
        );
        assert.ok(
          db
            .prepare(
              "SELECT 1 FROM notification_schedule_dirty WHERE organization_id=? AND kind='client'",
            )
            .get(f.org),
        );
      },
    );
    await t.test(
      'real workday Push planner enqueues under schedule scope, prepares next day and is idempotent without lazy global marker rebuild',
      () => {
        now = f.now + 50 * 60000;
        f.database.transaction(() => {
          const device = db
            .prepare('SELECT * FROM staff_push_devices WHERE id=?')
            .get('synthetic-device');
          db.prepare('UPDATE staff_push_devices SET value=? WHERE id=?').run(
            seal({
              ...f.database.open(device.value),
              preferences: { events: ['reminder'], reminderMode: 'workday', leadMinutes: 15 },
            }),
            device.id,
          );
          db.prepare("DELETE FROM telegram_runtime WHERE key GLOB 'push-interest-v1:*'").run();
          f.platform.notificationSchedule.markDirty(f.org, 'workday', device.id);
        });
        const enqueue = f.platform.staffPush.enqueue;
        let scopes = 0;
        f.platform.staffPush.enqueue = (...args) => {
          assert.equal(db.transactionIntent, 'QUEUEORG');
          assert.equal(db.scopedQueue.organizationId, f.org);
          assert.equal(db.scopedQueue.queueDomain, 'schedule');
          scopes++;
          return enqueue(...args);
        };
        const scheduler = createWorkdayDueScheduler(f.platform, f.platform.staffPush, () => now);
        try {
          scheduler.schedule();
        } finally {
          f.platform.staffPush.enqueue = enqueue;
        }
        assert.equal(scopes, 1);
        const count = () =>
          db
            .prepare('SELECT value FROM staff_push_jobs WHERE organization_id=?')
            .all(f.org)
            .filter((row) => f.database.open(row.value).event === 'reminder').length;
        assert.equal(count(), 1);
        scheduler.schedule();
        assert.equal(count(), 1);
        assert.equal(
          db
            .prepare(
              "SELECT entity FROM notification_schedule WHERE kind='workday' AND organization_id=?",
            )
            .get(f.org).entity,
          '2030-01-02',
        );
      },
    );
  },
);
