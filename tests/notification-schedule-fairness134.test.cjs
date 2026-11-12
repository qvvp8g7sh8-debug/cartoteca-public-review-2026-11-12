const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const { scheduleTables } = require('../src/server/migrations/notification-schedule-schema.cjs');
const {
  createNotificationScheduleStore,
} = require('../src/server/modules/notifications/notification-schedule-store.cjs');
const {
  createClientDueScheduler,
} = require('../src/server/modules/notifications/client-due-scheduler.cjs');
const NOW = Date.parse('2030-01-01T08:00:00Z');
const busy = () =>
  Object.assign(Error('Synthetic known admission BUSY.'), {
    code: 'ERR_SQLITE_ERROR',
    postgresCode: 'POSTGRES_BUSY',
    retryableBeforeBegin: true,
    transactionOpen: false,
    outcomeUnknown: false,
    channelPoisoned: false,
  });
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE organizations(id TEXT PRIMARY KEY);
    CREATE TABLE telegram_links(organization_id TEXT,patient_id TEXT);
    CREATE TABLE max_client_links(organization_id TEXT,patient_id TEXT);
    CREATE TABLE staff_push_devices(id TEXT,organization_id TEXT);
    ${scheduleTables} PRAGMA user_version=18;`);
  const blocked = new Set(),
    admissions = [],
    planned = [],
    sent = [],
    queued = new Set();
  let dispatcherScope = '',
    owningOrg = '',
    readFailure = null,
    enqueueFailure = null,
    admissionFailure = null;
  const transaction = (work) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const context = {
    db,
    id: randomUUID,
    seal: (v) => Buffer.from(JSON.stringify(v)),
    open: (v) => JSON.parse(Buffer.from(v).toString()),
    transaction,
    fail: (status, message) => Object.assign(Error(message), { status }),
    organizationQueueTransaction(work, cap) {
      const org = cap.organizationId;
      admissions.push({ org, scope: dispatcherScope });
      if (admissionFailure) throw admissionFailure;
      if (blocked.has(org)) throw busy();
      return transaction(() => {
        owningOrg = org;
        try {
          return work();
        } finally {
          owningOrg = '';
        }
      });
    },
  };
  const schedule = createNotificationScheduleStore(context, {
    enabled: true,
    startupReconcile: false,
  });
  const settings = { enabled: true, events: ['reminder'], timeZone: 'UTC', leadMinutes: 60 };
  const appointment = (patient) => ({
    id: 'appointment-' + patient,
    date: '2030-01-01',
    time: '08:30',
    duration: 30,
    status: 'scheduled',
  });
  const platform = {
    notificationSchedule: schedule,
    telegram: {
      settings(org) {
        if (readFailure) throw readFailure;
        return settings;
      },
      link: () => ({ chatId: 'synthetic' }),
      delivery: () => null,
    },
    subscription: () => ({ status: 'active', limits: { automaticNotifications: true } }),
    organization: () => ({ status: 'active' }),
    appointmentConfirmations: { stamp: (a) => 'stamp-' + a.id },
    notificationChannels: { enabled: (channel) => channel === 'telegram' },
  };
  const store = {
    hasReminderRecipients: () => true,
    linkedPatients: (_org, ids) => new Set(ids),
    list: (org, patient) =>
      queued.has(org + ':' + patient) ? [{ channel: 'telegram', status: 'pending' }] : [],
  };
  const runner = createClientDueScheduler({
    platform,
    store,
    links: { link: () => null },
    clock: () => NOW,
    tenantStore: (org) => ({
      readOnlySnapshot: (work) => work(),
      readPatientAppointments(patient) {
        assert.equal(owningOrg, org, 'planning reads belong to the admitted row organization');
        planned.push({ org, patient });
        return [appointment(patient)];
      },
    }),
    policy: {
      configuredChannels: () => ['telegram'],
      readyChannels: () => ['telegram'],
      current: (_org, patient) => ({
        a: appointment(patient),
        stamp: 'stamp-appointment-' + patient,
        settings,
        expiresAt: NOW + 30 * 60000,
        confirmed: false,
      }),
    },
    enqueue(org, patient, _appointment, authorize) {
      context.organizationQueueTransaction(
        () => {
          authorize();
          if (enqueueFailure) throw enqueueFailure;
          queued.add(org + ':' + patient);
          sent.push({ org, patient });
        },
        { queueDomain: 'schedule', organizationId: org },
      );
    },
  });
  const subject = (org, patient) => {
    db.prepare('INSERT OR IGNORE INTO organizations VALUES(?)').run(org);
    db.prepare('INSERT INTO telegram_links VALUES(?,?)').run(org, patient);
  };
  return {
    db,
    schedule,
    blocked,
    admissions,
    planned,
    sent,
    dirty(org, patient) {
      subject(org, patient);
      transaction(() => schedule.markDirty(org, 'client', patient));
    },
    due(org, patient, dueAt = NOW) {
      subject(org, patient);
      transaction(() =>
        schedule.replaceTasks('client', org, patient, [
          {
            entity: 'appointment-' + patient,
            dueAt,
            expiresAt: NOW + 30 * 60000,
            value: { stamp: 'stamp-appointment-' + patient },
          },
        ]),
      );
    },
    run: () =>
      runner.scheduleBatched({
        runWork(work, org) {
          dispatcherScope = org;
          try {
            return work();
          } finally {
            dispatcherScope = '';
          }
        },
      }),
    setReadFailure: (e) => {
      readFailure = e;
    },
    setEnqueueFailure: (e) => {
      enqueueFailure = e;
    },
    setAdmissionFailure: (e) => {
      admissionFailure = e;
    },
  };
}
test('real SQLite client planner rotates organizations instead of draining one dirty or due backlog', async (t) => {
  const f = fixture(t);
  for (let n = 0; n < 12; n++) f.dirty('org-a', 'patient-' + String(n).padStart(2, '0'));
  f.dirty('org-b', 'patient-b');
  assert.equal(await f.run(), true);
  assert.deepEqual(
    f.planned.slice(0, 2).map((row) => row.org),
    ['org-a', 'org-b'],
  );
  assert.deepEqual(
    f.sent.slice(0, 2).map((row) => row.org),
    ['org-a', 'org-b'],
  );
  assert.equal(f.planned.length, 13);
  assert.equal(
    f.admissions.every((row) => row.org === row.scope),
    true,
    'every owning transaction uses its row organization dispatcher scope',
  );
  f.sent.length = 0;
  f.admissions.length = 0;
  f.due('org-a', 'later', NOW - 10);
  f.due('org-a', 'oldest', NOW - 30);
  f.due('org-b', 'other', NOW - 1);
  await f.run();
  assert.deepEqual(f.sent, [
    // The preceding run last served A; its bounded cursor correctly resumes B.
    { org: 'org-b', patient: 'other' },
    { org: 'org-a', patient: 'oldest' },
    { org: 'org-a', patient: 'later' },
  ]);
  assert.equal(
    f.admissions.every((row) => row.org === row.scope),
    true,
  );
});
test('eight clean refused organizations are bounded per call and the ninth free cabinet progresses next call', async (t) => {
  const f = fixture(t);
  for (let n = 1; n <= 9; n++) {
    const org = 'org-' + n;
    f.dirty(org, 'patient');
    if (n <= 8) f.blocked.add(org);
  }
  await f.run();
  assert.equal(f.admissions.length, 8);
  assert.equal(f.planned.length, 0);
  const before = f.admissions.length;
  await f.run();
  assert.equal(f.admissions[before].org, 'org-9');
  assert.deepEqual(f.planned, [{ org: 'org-9', patient: 'patient' }]);
  assert.equal(
    f.db
      .prepare("SELECT count(*) n FROM notification_schedule_dirty WHERE organization_id<>'org-9'")
      .get().n,
    8,
  );
});
test('lookalike BUSY from real planner and enqueue callbacks, pre-enqueue reads and unknown outcomes never skip to another cabinet', async (t) => {
  await t.test('planning callback BUSY propagates after real transaction admission', async (t) => {
    const f = fixture(t),
      error = busy();
    f.dirty('org-a', 'one');
    f.dirty('org-b', 'two');
    f.setReadFailure(error);
    await assert.rejects(f.run(), (e) => e === error);
    assert.equal(f.admissions.length, 1);
    assert.equal(f.sent.length, 0);
  });
  for (const origin of ['pre-enqueue-read', 'enqueue-callback', 'unknown-admission'])
    await t.test(origin, async (t) => {
      const f = fixture(t),
        error = busy();
      f.due('org-a', 'one');
      f.due('org-b', 'two');
      if (origin === 'pre-enqueue-read') f.setReadFailure(error);
      if (origin === 'enqueue-callback') f.setEnqueueFailure(error);
      if (origin === 'unknown-admission') {
        error.outcomeUnknown = true;
        f.setAdmissionFailure(error);
      }
      await assert.rejects(f.run(), (e) => e === error);
      assert.equal(f.sent.length, 0);
      assert.equal(
        f.admissions.some((row) => row.org === 'org-b'),
        false,
      );
      assert.equal(f.db.prepare('SELECT count(*) n FROM notification_schedule').get().n, 2);
    });
});
