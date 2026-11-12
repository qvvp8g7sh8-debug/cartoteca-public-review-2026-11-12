const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const { scheduleTables } = require('../src/server/migrations/notification-schedule-schema.cjs');
const {
  createNotificationScheduleStore,
} = require('../src/server/modules/notifications/notification-schedule-store.cjs');
const {
  createDueRunner,
} = require('../src/server/modules/notifications/notification-due-runner.cjs');
const {
  createNotificationDiagnostics,
  markNotificationPhase,
} = require('../src/server/modules/notifications/notification-diagnostics140.cjs');
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE organizations(id TEXT PRIMARY KEY);
    CREATE TABLE telegram_links(organization_id TEXT,patient_id TEXT);
    CREATE TABLE max_client_links(organization_id TEXT,patient_id TEXT);
    CREATE TABLE staff_push_devices(id TEXT,organization_id TEXT);
    ${scheduleTables} PRAGMA user_version=18;`);
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
  const schedule = createNotificationScheduleStore(
    {
      db,
      id: randomUUID,
      seal: (v) => Buffer.from(JSON.stringify(v)),
      open: (v) => JSON.parse(Buffer.from(v)),
      transaction,
      organizationQueueTransaction: (work) => transaction(work),
    },
    { enabled: true, startupReconcile: false },
  );
  function seed(org, count) {
    db.prepare('INSERT INTO organizations VALUES(?)').run(org);
    for (let n = 0; n < count; n++)
      db.prepare('INSERT INTO telegram_links VALUES(?,?)').run(
        org,
        'p' + String(n).padStart(3, '0'),
      );
    transaction(() => schedule.markDirty(org, 'client'));
  }
  const state = () => ({
    dirty: db
      .prepare('SELECT * FROM notification_schedule_dirty ORDER BY organization_id,subject')
      .all(),
    tasks: db
      .prepare('SELECT * FROM notification_schedule ORDER BY organization_id,subject,entity')
      .all(),
  });
  return { db, transaction, schedule, seed, state };
}
test('first real due task does not wait for discovery of every organization and still leaves the 25-subject page durable', async (t) => {
  const f = fixture(t),
    rebuilt = [],
    sent = [];
  f.seed('org-000', 28);
  for (let n = 1; n < 200; n++) f.seed('org-' + String(n).padStart(3, '0'), 1);
  f.transaction(() => f.schedule.markDirty('org-000', 'client', 'p000'));
  const runner = createDueRunner({
    schedule: f.schedule,
    kind: 'client',
    clock: () => 100,
    rebuild(org, subject) {
      rebuilt.push([org, subject]);
      f.schedule.replaceTasks('client', org, subject, [
        { entity: 'a', dueAt: 100, expiresAt: 200, value: { synthetic: true } },
      ]);
    },
    dispatch(task, admit) {
      admit((entered) =>
        f.schedule.transaction(() => {
          entered();
          sent.push([task.organization_id, task.subject]);
          f.schedule.finishTask(task);
        }, task.organization_id),
      );
    },
  });
  assert.equal(await runner.scheduleBatched({ canRun: () => sent.length === 0 }), false);
  assert.deepEqual(rebuilt, [['org-000', 'p000']]);
  assert.deepEqual(sent, [['org-000', 'p000']]);
  assert.equal(
    f.schedule.subjectDirty('client', 'org-000', 'p000'),
    undefined,
    'coalesce captured pre-existing dirty subject',
  );
  const first = f.state().dirty.filter((r) => r.organization_id === 'org-000');
  assert.equal(first.length, 25, 'one org marker plus the remaining 24 subjects');
  assert.equal(first[0].cursor, 'p024');
  assert.equal(f.state().dirty.filter((r) => r.organization_id !== 'org-000').length, 199);
  assert.equal(await runner.scheduleBatched(), true);
  assert.deepEqual(rebuilt[1], ['org-001', 'p000'], 'cursor moves fairly to the next organization');
  assert.equal(
    rebuilt.filter(([org, subject]) => org === 'org-000' && subject === 'p000').length,
    1,
  );
  assert.equal(rebuilt.length, 227);
  assert.equal(f.state().dirty.length, 0);
  assert.equal(f.state().tasks.length, 0);
});
test('failed inline rebuild rolls back task ciphertext, all sibling dirty marks and discovery cursor', async (t) => {
  const f = fixture(t);
  f.seed('org-a', 26);
  f.seed('org-b', 1);
  f.transaction(() =>
    f.schedule.replaceTasks('client', 'org-a', 'p000', [
      { entity: 'old', dueAt: 99, expiresAt: 200, value: { preserve: 'ciphertext' } },
    ]),
  );
  const before = f.state(),
    failure = Error('synthetic rollback');
  const runner = createDueRunner({
    schedule: f.schedule,
    kind: 'client',
    clock: () => 100,
    rebuild(org, subject) {
      f.schedule.replaceTasks('client', org, subject, [
        { entity: 'new', dueAt: 100, expiresAt: 200, value: { new: true } },
      ]);
      throw failure;
    },
    dispatch: () => assert.fail('failed rebuild never dispatches'),
  });
  await assert.rejects(runner.scheduleBatched(), (e) => e === failure);
  assert.deepEqual(f.state(), before);
});
test('a new dirty generation during inline rebuild survives the captured subject CAS', async (t) => {
  const f = fixture(t);
  f.seed('org-a', 1);
  f.transaction(() => f.schedule.markDirty('org-a', 'client', 'p000'));
  let rebuilt = false;
  const runner = createDueRunner({
    schedule: f.schedule,
    kind: 'client',
    clock: () => 100,
    rebuild(org, subject) {
      f.schedule.markDirty(org, 'client', subject);
      rebuilt = true;
    },
    dispatch: () => assert.fail('no tasks'),
  });
  assert.equal(await runner.scheduleBatched({ canRun: () => !rebuilt }), false);
  assert.equal(f.schedule.subjectDirty('client', 'org-a', 'p000').version, 2);
});
test('notification diagnostics retain only closed phase/code/outcome fields and never the error payload', () => {
  const d = createNotificationDiagnostics();
  const e = Object.assign(Error('secret message'), {
    code: 'secret-code',
    postgresCode: 'POSTGRES_BUSY',
    status: 503,
    retryableBeforeBegin: true,
    patient: 'secret-patient',
  });
  markNotificationPhase(e, 'rebuild');
  d.record('planning', e);
  assert.deepEqual(d.snapshot(), {
    failures: 1,
    last: {
      phase: 'rebuild',
      code: 'POSTGRES_BUSY',
      status: 503,
      retryableBeforeBegin: true,
      outcomeUnknown: false,
      channelPoisoned: false,
    },
  });
  const saved = d.snapshot();
  saved.last.code = 'changed';
  assert.equal(d.snapshot().last.code, 'POSTGRES_BUSY');
  assert.equal(JSON.stringify(d.snapshot()).includes('secret'), false);
  d.record('secret-phase', { code: 'secret-code' });
  assert.equal(d.snapshot().last.code, 'UNCLASSIFIED');
  assert.equal(d.snapshot().last.phase, 'planning');
  assert.doesNotThrow(() =>
    d.record(
      'lease',
      Object.defineProperty({}, 'code', {
        get() {
          throw Error('secret getter');
        },
      }),
    ),
  );
});

const { scheduleFixture } = require('./helpers/notification-schedule-fixture.cjs');
const turn = () => new Promise((resolve) => setImmediate(resolve));
test(
  'due reminder reaches enqueue while an independent lifecycle lane is paused outside any transaction',
  { timeout: 5000 },
  async (t) => {
    const f = scheduleFixture(t);
    f.link();
    const prior = f.platform.telegram.settings('org');
    f.platform.telegram.saveReminderPeriod('org', 'owner', {
      expectedLeadMinutes: prior.leadMinutes,
      leadMinutes: 1440,
      expectedEvents: prior.events,
      events: ['reminder', 'created'],
    });
    assert.deepEqual(f.platform.telegram.settings('org').events, ['reminder', 'created']);
    f.setNow(Date.parse('2030-01-02T10:00:00Z'));
    let release,
      paused = false;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const pending = f.coordinator.scheduleBatched({
      runWork(work, org) {
        if (org === 'org' && !paused) {
          paused = true;
          assert.equal(f.database.db.isTransaction, false);
          return gate.then(work);
        }
        return work();
      },
    });
    let before;
    try {
      for (let n = 0; n < 10; n++) await turn();
      before = f.database.db.prepare('SELECT count(*) n FROM notification_channel_jobs').get().n;
      assert.equal(
        before,
        2,
        'independent lifecycle backlog must not block ready client reminders',
      );
    } finally {
      release();
      await pending;
    }
    assert.equal(
      f.database.db.prepare('SELECT count(*) n FROM notification_channel_jobs').get().n,
      2,
    );
  },
);

test(
  'lane failure aborts sibling before its next transaction and waits for both lane lifetimes',
  { timeout: 5000 },
  async (t) => {
    const f = scheduleFixture(t);
    f.link();
    const prior = f.platform.telegram.settings('org');
    f.platform.telegram.saveReminderPeriod('org', 'owner', {
      expectedLeadMinutes: prior.leadMinutes,
      leadMinutes: 1440,
      expectedEvents: prior.events,
      events: ['reminder', 'created'],
    });
    f.setNow(Date.parse('2030-01-02T10:00:00Z'));
    let failLifecycle,
      releaseDue,
      scopeCalls = 0;
    const fail = new Promise((_, reject) => {
      failLifecycle = reject;
    });
    const hold = new Promise((resolve) => {
      releaseDue = resolve;
    });
    const error = Object.assign(Error('synthetic unknown outcome'), {
      outcomeUnknown: true,
      channelPoisoned: true,
    });
    const pending = f.coordinator.scheduleBatched({
      runWork(work, org) {
        if (org === 'org' && ++scopeCalls === 1) return fail;
        if (org === 'org' && scopeCalls === 2) return hold.then(work);
        return work();
      },
    });
    let settled = false;
    const observed = pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    for (let n = 0; n < 10; n++) await turn();
    assert.equal(scopeCalls, 2);
    assert.equal(f.coordinator.schedule(), false, 'no overlapping composite pass');
    failLifecycle(error);
    for (let n = 0; n < 3; n++) await turn();
    assert.equal(settled, false, 'rejection does not abandon the pending sibling lifetime');
    releaseDue();
    await assert.rejects(pending, (e) => e === error);
    await observed;
    assert.equal(f.database.db.isTransaction, false);
    assert.equal(
      f.database.db.prepare('SELECT count(*) n FROM notification_channel_jobs').get().n,
      0,
      'aborted sibling starts no transaction/enqueue',
    );
    assert.ok(
      f.database.db.prepare('SELECT 1 FROM notification_schedule_dirty').get(),
      'durable dirty work remains',
    );
    assert.equal(
      await f.coordinator.scheduleBatched(),
      true,
      'closed failed pass releases the composite mutex',
    );
    assert.equal(
      f.database.db.prepare('SELECT count(*) n FROM notification_channel_jobs').get().n,
      2,
    );
  },
);

test(
  'lifecycle-enabled reminder eligibility is rechecked after successful lifecycle work',
  { timeout: 5000 },
  async (t) => {
    const f = scheduleFixture(t);
    f.link();
    let prior = f.platform.telegram.settings('org');
    f.platform.telegram.saveReminderPeriod('org', 'owner', {
      expectedLeadMinutes: prior.leadMinutes,
      leadMinutes: 1440,
      expectedEvents: prior.events,
      events: ['created'],
    });
    f.database.transaction(() =>
      f.database.db.prepare('DELETE FROM notification_schedule_dirty').run(),
    );
    assert.equal(f.store.hasReminderRecipients('', ['telegram', 'max']), false);
    assert.equal(f.platform.notificationSchedule.nextDirty('client'), undefined);
    f.setNow(Date.parse('2030-01-02T10:00:00Z'));
    let enabled = false;
    assert.equal(
      await f.coordinator.scheduleBatched({
        runWork(work, org) {
          if (org === 'org' && !enabled) {
            enabled = true;
            prior = f.platform.telegram.settings('org');
            f.platform.telegram.saveReminderPeriod('org', 'owner', {
              expectedLeadMinutes: prior.leadMinutes,
              leadMinutes: 1440,
              expectedEvents: prior.events,
              events: ['reminder', 'created'],
            });
          }
          return work();
        },
      }),
      true,
    );
    assert.equal(enabled, true);
    assert.equal(
      f.database.db.prepare('SELECT count(*) n FROM notification_channel_jobs').get().n,
      2,
      'newly eligible reminders are not postponed to a later timer pass',
    );
  },
);
