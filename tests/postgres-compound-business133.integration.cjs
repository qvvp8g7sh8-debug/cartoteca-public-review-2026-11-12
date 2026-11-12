const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { postgresBusinessFixture } = require('./helpers/postgres-business133-fixture.cjs');
const { saveMutation } = require('../src/server/modules/cabinet/mutations.cjs');
const {
  routes: confirmationRoutes,
} = require('../src/server/modules/cabinet/confirmation-routes.cjs');
const { publicSubmit } = require('../src/server/modules/booking/public-service.cjs');
const { acceptRequest } = require('../src/server/modules/booking/acceptance.cjs');
const { readOperationStatus } = require('../src/server/infrastructure/mutation-receipts.cjs');
const { fingerprint } = require('../src/server/modules/notifications/appointments.cjs');
function command(f, changes) {
  const state = f.storage.readSelected(['synthetic-0']),
    appointment =
      state.patients[0].appointments.find((value) => value.status === 'scheduled') ||
      state.patients[0].appointments[0];
  return {
    revision: state.revision,
    patientId: 'synthetic-0',
    changes: [{ id: appointment.id, before: appointment, after: { ...appointment, ...changes } }],
  };
}
function snapshot(f) {
  const result = {
    cabinet: f.storage.read(),
    journal: f.storage.get('appointment-notification-events-v1'),
  };
  for (const table of [
    'appointment_manual_confirmations',
    'telegram_jobs',
    'staff_push_jobs',
    'staff_notification_jobs',
    'notification_schedule_dirty',
  ])
    result[table] = f.database.db
      .prepare(`SELECT * FROM ${table} WHERE organization_id=?`)
      .all(f.org)
      .sort((a, b) =>
        JSON.stringify([
          a.id || '',
          a.patient_id || '',
          a.appointment_id || '',
          a.kind || '',
          a.subject || '',
        ]).localeCompare(
          JSON.stringify([
            b.id || '',
            b.patient_id || '',
            b.appointment_id || '',
            b.kind || '',
            b.subject || '',
          ]),
        ),
      );
  return result;
}
function seedReceiptAndTelegram(f) {
  const a = f.storage.readSelected(['synthetic-0']).patients[0].appointments[0];
  f.database.transaction(() => {
    const { db, seal } = f.database;
    db.prepare('INSERT OR REPLACE INTO appointment_manual_confirmations VALUES(?,?,?,?)').run(
      f.org,
      'synthetic-0',
      a.id,
      seal({
        stamp: f.platform.appointmentConfirmations.stamp(a, 'Europe/Moscow'),
        actorId: f.owner.accountId,
        confirmedAt: Date.now(),
      }),
    );
    db.prepare(
      "INSERT INTO telegram_jobs(id,organization_id,patient_id,fingerprint,callback_hash,value,status,next_at,expires_at) VALUES(?,?,?,?,?,?,'pending',?,?)",
    ).run(
      randomUUID(),
      f.org,
      'synthetic-0',
      fingerprint(a, 'Europe/Moscow'),
      randomUUID(),
      seal({}),
      Date.now(),
      Date.now() + 86400000,
    );
    db.prepare('DELETE FROM notification_schedule_dirty WHERE organization_id=?').run(f.org);
    db.prepare("DELETE FROM telegram_runtime WHERE key GLOB 'push-interest-v1:*'").run();
  });
}
test(
  'actual v3 compound business saves, booking and confirmations retain one atomic transaction and fresh authority',
  { timeout: 120000 },
  async (t) => {
    const f = await postgresBusinessFixture(t);
    assert.equal(f.storage.db.revisionProfile, 3);
    seedReceiptAndTelegram(f);
    await t.test(
      'error after cabinet, journal, dirty, confirmation and queue effects rolls everything back, including trusted marker and receipt',
      async () => {
        const original = snapshot(f),
          body = command(f, { status: 'cancelled' });
        const operation = randomUUID();
        f.context.req.headers['x-cartoteca-operation'] = operation;
        let written = 0;
        await assert.rejects(
          saveMutation(f.context, body, {
            appointmentCommand: true,
            trustedCommit: {
              assert() {
                assert.equal(f.database.db.transactionIntent, 'COMPOUND');
              },
              written(storage) {
                written++;
                storage.set('assistant-created:synthetic-compound', true);
                throw Error('Synthetic post-effects failure');
              },
            },
          }),
          /Synthetic post-effects failure/,
        );
        assert.equal(written, 1, 'no automatic mutation retry');
        assert.deepEqual(snapshot(f), original);
        assert.equal(f.storage.get('assistant-created:synthetic-compound'), null);
        assert.equal(
          readOperationStatus(f.storage, f.context.current, operation).status,
          'unknown',
        );
        assert.equal(
          f.database.db
            .prepare("SELECT 1 FROM telegram_runtime WHERE key='push-interest-v1:ready'")
            .get(),
          undefined,
          'a first compound Push read must not create global planning markers',
        );
      },
    );
    await t.test(
      'failure after cabinet savepoint release rolls back physical transaction; successful retry and same operation replay commit once',
      async () => {
        const original = snapshot(f),
          body = command(f, { status: 'cancelled' });
        const operation = randomUUID();
        f.context.req.headers['x-cartoteca-operation'] = operation;
        const ack = f.platform.notificationSchedule.ackIntent;
        f.platform.notificationSchedule.ackIntent = () => {
          throw Error('Synthetic after-savepoint failure');
        };
        try {
          await assert.rejects(
            saveMutation(f.context, body, { appointmentCommand: true }),
            /Synthetic after-savepoint failure/,
          );
        } finally {
          f.platform.notificationSchedule.ackIntent = ack;
        }
        assert.deepEqual(snapshot(f), original);
        assert.equal(
          readOperationStatus(f.storage, f.context.current, operation).status,
          'unknown',
        );
        const trustedCommit = {
          assert() {},
          written(storage) {
            storage.set('assistant-created:synthetic-compound', true);
          },
          committed() {},
        };
        const saved = await saveMutation(f.context, body, {
          appointmentCommand: true,
          trustedCommit,
        });
        assert.equal(f.storage.get('assistant-created:synthetic-compound'), true);
        assert.equal(
          f.database.db
            .prepare(
              'SELECT count(*) n FROM appointment_manual_confirmations WHERE organization_id=?',
            )
            .get(f.org).n,
          0,
        );
        assert.equal(
          f.database.db
            .prepare('SELECT status FROM telegram_jobs WHERE organization_id=?')
            .get(f.org).status,
          'cancelled',
        );
        assert.ok(
          f.database.db
            .prepare('SELECT count(*) n FROM staff_push_jobs WHERE organization_id=?')
            .get(f.org).n > 0,
        );
        assert.ok(
          f.database.db
            .prepare('SELECT count(*) n FROM notification_schedule_dirty WHERE organization_id=?')
            .get(f.org).n > 0,
        );
        assert.ok(
          f.storage.get('appointment-notification-events-v1').length >= 2,
          'client and staff journals remain durable',
        );
        const after = snapshot(f);
        const replay = await saveMutation(f.context, body, {
          appointmentCommand: true,
          trustedCommit,
        });
        assert.equal(replay.revision, saved.revision);
        assert.deepEqual(snapshot(f), after);
        assert.equal(
          readOperationStatus(f.storage, f.context.current, operation).status,
          'committed',
        );
      },
    );
    await t.test(
      'manual confirmation atomically inserts receipt, staff Telegram and Push effects under owned scope',
      async () => {
        f.context.req.headers['x-cartoteca-operation'] = randomUUID();
        const state = f.storage.readSelected(['synthetic-0']);
        const closed = state.patients[0].appointments[0];
        const a = { ...closed, id: randomUUID(), time: '14:00', status: 'scheduled' };
        delete a.outcomeAt;
        delete a.outcomeBy;
        await saveMutation(
          f.context,
          {
            revision: state.revision,
            patientId: 'synthetic-0',
            changes: [{ id: a.id, before: null, after: a }],
          },
          { appointmentCommand: true },
        );
        assert.deepEqual(
          f.storage
            .readSelected(['synthetic-0'])
            .patients[0].appointments.find((value) => value.id === closed.id),
          closed,
          'a permanent cancellation is retained instead of reopening a closed appointment',
        );
        const staffBefore = f.database.db
          .prepare('SELECT count(*) n FROM staff_notification_jobs WHERE organization_id=?')
          .get(f.org).n;
        const pushBefore = f.database.db
          .prepare('SELECT count(*) n FROM staff_push_jobs WHERE organization_id=?')
          .get(f.org).n;
        const values = {
          patientId: 'synthetic-0',
          appointmentId: a.id,
          confirmed: true,
          expectedFingerprint: f.platform.appointmentConfirmations.stamp(a, 'Europe/Moscow'),
        };
        const route = confirmationRoutes.find((r) => r.path === '/api/appointments/confirmation');
        const result = await route.handle({
          ...f.context,
          readBody: async () => values,
          json: (_res, status, body) => ({ status, body }),
        });
        assert.equal(result.status, 200);
        assert.ok(result.body.manualConfirmedAt);
        assert.equal(
          f.database.db
            .prepare(
              'SELECT count(*) n FROM appointment_manual_confirmations WHERE organization_id=?',
            )
            .get(f.org).n,
          1,
        );
        assert.ok(
          f.database.db
            .prepare('SELECT count(*) n FROM staff_notification_jobs WHERE organization_id=?')
            .get(f.org).n > staffBefore,
        );
        assert.ok(
          f.database.db
            .prepare('SELECT count(*) n FROM staff_push_jobs WHERE organization_id=?')
            .get(f.org).n > pushBefore,
        );
      },
    );
    await t.test(
      'approval acceptance finalizer failure does not commit a client or appointment; later acceptance remains idempotent',
      async () => {
        const values = f.input({ time: '09:00', phone: '+79999999991' });
        assert.equal(publicSubmit(f.context, f.org, values, f.now).status, 'pending');
        const record = f.platform.bookingRequests.byKey(f.org, values.key, f.now),
          before = f.storage.read();
        const finish = f.platform.bookingRequests.finish;
        f.platform.bookingRequests.finish = () => {
          throw Error('Synthetic booking finalizer failure');
        };
        try {
          await assert.rejects(
            acceptRequest(f.context, { id: record.id, revision: record.revision }, f.now),
            /Synthetic booking finalizer failure/,
          );
        } finally {
          f.platform.bookingRequests.finish = finish;
        }
        assert.deepEqual(f.storage.read(), before);
        assert.notEqual(f.platform.bookingRequests.get(f.org, record.id, f.now).status, 'accepted');
        const accepted = await acceptRequest(
          f.context,
          { id: record.id, revision: record.revision },
          f.now,
        );
        assert.equal(accepted.status, 'accepted');
        const saved = f.storage.read();
        assert.equal(
          (await acceptRequest(f.context, { id: record.id, revision: record.revision }, f.now))
            .status,
          'accepted',
        );
        assert.deepEqual(f.storage.read(), saved);
      },
    );
    await t.test(
      'public classic booking rolls back cabinet and platform finalizer together, then repeated form creates one appointment',
      () => {
        f.setMode('classic');
        const values = f.input({ time: '10:00', phone: '+79999999992' }),
          before = f.storage.read();
        const finish = f.platform.bookingRequests.finish;
        f.platform.bookingRequests.finish = () => {
          throw Error('Synthetic classic finalizer failure');
        };
        try {
          assert.throws(
            () => publicSubmit(f.context, f.org, values, f.now),
            /Synthetic classic finalizer failure/,
          );
        } finally {
          f.platform.bookingRequests.finish = finish;
        }
        assert.deepEqual(f.storage.read(), before);
        assert.equal(f.platform.bookingRequests.byKey(f.org, values.key, f.now), null);
        const result = publicSubmit(f.context, f.org, values, f.now);
        assert.equal(result.status, 'booked');
        const saved = f.storage.read();
        assert.deepEqual(publicSubmit(f.context, f.org, values, f.now + 1000), result);
        assert.deepEqual(f.storage.read(), saved);
      },
    );
    await t.test(
      'revocation during asynchronous preparation rejects the original operation before effects',
      async () => {
        const before = snapshot(f),
          prepare = f.storage.prepareImages;
        const stages = [];
        f.context.recordStage = (stage) => stages.push(stage);
        const operation = randomUUID();
        f.context.req.headers['x-cartoteca-operation'] = operation;
        f.storage.prepareImages = async (...args) => {
          const result = await prepare(...args);
          await f.admin.query(
            "UPDATE cartoteca_platform.memberships SET status='suspended' WHERE _store_id=$1 AND organization_id=$2 AND account_id=$3",
            [f.database.db.scope.storeId, f.org, f.owner.accountId],
          );
          return result;
        };
        try {
          await assert.rejects(
            saveMutation(f.context, command(f, { notes: 'Synthetic revoked change' }), {
              appointmentCommand: true,
            }),
            { status: 403 },
          );
        } finally {
          f.storage.prepareImages = prepare;
          delete f.context.recordStage;
          await f.admin.query(
            "UPDATE cartoteca_platform.memberships SET status='active' WHERE _store_id=$1 AND organization_id=$2 AND account_id=$3",
            [f.database.db.scope.storeId, f.org, f.owner.accountId],
          );
        }
        const after = snapshot(f);
        const expected = {
          ...before,
          notification_schedule_dirty: before.notification_schedule_dirty.map((row) =>
            row.subject === '' ? { ...row, version: row.version + 2, cursor: '' } : row,
          ),
        };
        assert.deepEqual(
          after,
          expected,
          'only the separately committed suspend/restore dirty triggers may change',
        );
        assert.equal(
          stages.includes('save-write'),
          false,
          'revocation rejects before the clinical effect callback',
        );
        assert.equal(
          readOperationStatus(f.storage, f.context.current, operation).status,
          'unknown',
        );
      },
    );
  },
);
