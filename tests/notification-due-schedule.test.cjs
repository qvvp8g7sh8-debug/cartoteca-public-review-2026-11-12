const test = require('node:test');
const assert = require('node:assert/strict');
const { scheduleFixture } = require('./helpers/notification-schedule-fixture.cjs');

const tasks = (f) =>
  f.database.db
    .prepare("SELECT * FROM notification_schedule WHERE kind='client' ORDER BY subject,entity")
    .all();
const jobs = (f) =>
  f.database.db
    .prepare('SELECT channel,status FROM notification_channel_jobs ORDER BY channel')
    .all()
    .map((row) => ({ ...row }));

test('future client plan reads only changed linked patient once, then indexed due work without scans', async (t) => {
  const f = scheduleFixture(t);
  f.link();
  assert.equal(await f.coordinator.scheduleBatched(), true);
  assert.equal(tasks(f).length, 1);
  assert.equal(tasks(f)[0].due_at, Date.parse('2030-01-02T10:00Z'));
  assert.equal(f.metrics.appointmentReads, 1);
  assert.deepEqual(jobs(f), []);
  for (let i = 0; i < 20; i++) f.coordinator.schedule();
  assert.equal(f.metrics.appointmentReads, 1, 'idle passes must not reopen unchanged calendars');
  assert.equal(f.metrics.profileReads, 0);
  f.setNow(Date.parse('2030-01-02T10:00Z'));
  f.coordinator.schedule();
  assert.equal(jobs(f).length, 2);
  assert.equal(tasks(f).length, 0);
  await f.coordinator.tick();
  assert.deepEqual(f.sent.map((x) => x.channel).sort(), ['max', 'telegram']);
  f.coordinator.schedule();
  await f.coordinator.tick();
  assert.equal(f.sent.length, 2);
});

test('addressed appointment move replaces old deadline and unlink removes the future plan', (t) => {
  const f = scheduleFixture(t);
  f.link();
  f.coordinator.schedule();
  f.appointment.date = '2030-01-05';
  f.dirty();
  f.coordinator.schedule();
  assert.equal(tasks(f)[0].due_at, Date.parse('2030-01-04T10:00Z'));
  f.setNow(Date.parse('2030-01-02T10:00Z'));
  f.coordinator.schedule();
  assert.deepEqual(jobs(f), []);
  f.database.db.prepare('DELETE FROM telegram_links WHERE organization_id=?').run('org');
  f.database.db.prepare('DELETE FROM max_client_links WHERE organization_id=?').run('org');
  const before = f.metrics.appointmentReads;
  f.coordinator.schedule();
  assert.equal(tasks(f).length, 0);
  assert.equal(f.metrics.appointmentReads, before, 'removed bindings need no clinical read');
});

test('deadline changes and suspension/reactivation are recovered through atomic platform triggers', (t) => {
  const f = scheduleFixture(t);
  f.link();
  f.coordinator.schedule();
  f.platform.telegram.saveReminderPeriod('org', 'owner', {
    expectedLeadMinutes: 1440,
    leadMinutes: 60,
  });
  f.coordinator.schedule();
  assert.equal(tasks(f)[0].due_at, Date.parse('2030-01-03T09:00Z'));
  f.database.db
    .prepare("UPDATE subscriptions SET status='paused' WHERE organization_id='org'")
    .run();
  f.coordinator.schedule();
  assert.equal(tasks(f).length, 0);
  f.database.db
    .prepare("UPDATE subscriptions SET status='active' WHERE organization_id='org'")
    .run();
  f.coordinator.schedule();
  assert.equal(tasks(f).length, 1);
  f.database.db
    .prepare("UPDATE organizations SET value=? WHERE id='org'")
    .run(f.database.seal({ name: 'Synthetic', timeZone: 'Europe/Moscow' }));
  f.coordinator.schedule();
  assert.equal(tasks(f)[0].due_at, Date.parse('2030-01-03T06:00Z'));
});

test('paused sibling provider keeps a due task, not a global rescan or duplicate of ready channel', async (t) => {
  const f = scheduleFixture(t);
  f.link();
  f.readiness.max = false;
  f.setNow(Date.parse('2030-01-02T10:00Z'));
  f.coordinator.schedule();
  assert.deepEqual(jobs(f), [{ channel: 'telegram', status: 'pending' }]);
  assert.equal(tasks(f).length, 1);
  await f.coordinator.tick();
  f.readiness.max = true;
  f.advance(31000);
  f.coordinator.schedule();
  await f.coordinator.tick();
  assert.equal(tasks(f).length, 0);
  assert.deepEqual(f.sent.map((x) => x.channel).sort(), ['max', 'telegram']);
  assert.equal(f.metrics.appointmentReads, 1);
});

test('changed or inactive appointment is checked before enqueue even if old plan remains due', async (t) => {
  const f = scheduleFixture(t);
  f.link();
  f.coordinator.schedule();
  // Simulate interrupted projection; the owning data is nevertheless authoritative.
  f.appointment.date = '2030-01-08';
  f.setNow(Date.parse('2030-01-02T10:00Z'));
  f.coordinator.schedule();
  assert.deepEqual(jobs(f), []);
  assert.equal(tasks(f)[0].due_at, Date.parse('2030-01-07T10:00Z'));
  f.appointment.status = 'cancelled';
  f.setNow(Date.parse('2030-01-07T10:00Z'));
  f.coordinator.schedule();
  await f.coordinator.tick();
  assert.equal(tasks(f).length, 0);
  assert.equal(f.sent.length, 0);
});

test('abort/lease loss leaves dirty work durable and a later pass resumes without an overlapping scan', async (t) => {
  const f = scheduleFixture(t);
  f.link();
  assert.equal(await f.coordinator.scheduleBatched({ canRun: () => false }), false);
  assert.equal(f.metrics.appointmentReads, 0);
  assert.ok(f.database.db.prepare('SELECT 1 FROM notification_schedule_dirty').get());
  assert.equal(await f.coordinator.scheduleBatched(), true);
  assert.equal(tasks(f).length, 1);
  assert.equal(
    f.database.db.prepare("SELECT 1 FROM notification_schedule_dirty WHERE kind='client'").get(),
    undefined,
  );
});

test('hot first organization cannot starve a later dirty organization during preparation', async (t) => {
  const f = scheduleFixture(t),
    s = f.platform.notificationSchedule;
  f.database.db.prepare('DELETE FROM notification_schedule_dirty').run();
  f.database.transaction(() => {
    s.markDirty('org', 'client', 'p');
    s.markDirty('other-org', 'client', 'p');
  });
  const seen = [];
  const runner =
    require('../src/server/modules/notifications/notification-due-runner.cjs').createDueRunner({
      schedule: s,
      kind: 'client',
      clock: f.clock,
      rebuild(org) {
        seen.push(org);
        if (org === 'org') s.markDirty('org', 'client', 'p');
      },
      dispatch() {
        throw Error('No due jobs expected');
      },
    });
  let checks = 0;
  assert.equal(await runner.scheduleBatched({ canRun: () => checks++ < 30 }), false);
  assert.ok(
    seen.includes('other-org'),
    'later dirty organization must make progress despite continuous first-org changes',
  );
});

test('enabling after a disabled-mode commit gap reconciles once without resetting delivery history', (t) => {
  const f = scheduleFixture(t);
  const {
    createNotificationScheduleStore,
  } = require('../src/server/modules/notifications/notification-schedule-store.cjs');
  const {
    createNotificationCoordinator,
  } = require('../src/server/modules/notifications/notification-coordinator.cjs');
  f.link();
  f.coordinator.schedule();
  f.platform.notificationSchedule = createNotificationScheduleStore(f.context);
  assert.equal(f.platform.notificationSchedule.enabled, false);
  // Owning tenant commits, then the platform projection transaction rolls back.
  f.appointment.date = '2030-01-10';
  assert.throws(
    () =>
      f.database.transaction(() => {
        f.platform.notificationSchedule.markDirty('org', 'client', 'p');
        throw Error('synthetic disabled-mode platform rollback');
      }),
    /synthetic disabled-mode/,
  );
  assert.equal(
    f.database.db
      .prepare("SELECT count(*) n FROM notification_schedule_dirty WHERE kind='client'")
      .get().n,
    0,
  );
  assert.equal(tasks(f)[0].due_at, Date.parse('2030-01-02T10:00Z'));
  f.device();
  f.database.transaction(() =>
    f.store.enqueue(
      {
        org: 'org',
        patient: 'p',
        appointment: 'historic',
        stamp: 'synthetic-historical-stamp',
        channel: 'telegram',
        recipient: { chatId: '456' },
        expiresAt: f.clock() + 3600000,
      },
      f.clock(),
    ),
  );
  f.database.db.prepare("UPDATE notification_channel_jobs SET status='sent',next_at=12345").run();
  const history = f.database.db.prepare('SELECT * FROM notification_channel_jobs').all();
  f.platform.notificationSchedule = createNotificationScheduleStore(f.context, { enabled: true });
  assert.deepEqual(f.database.db.prepare('SELECT * FROM notification_channel_jobs').all(), history);
  const run = createNotificationCoordinator({
    platform: f.platform,
    tenantStore: f.tenantStore,
    store: f.store,
    links: f.links,
    providers: {
      telegram: { status: () => ({ configured: true, connected: true, botId: '321' }) },
    },
    clock: f.clock,
  });
  run.schedule();
  assert.equal(tasks(f)[0].due_at, Date.parse('2030-01-09T10:00Z'));
  assert.ok(
    f.database.db
      .prepare(
        "SELECT 1 FROM notification_schedule_dirty WHERE kind='workday' AND organization_id='org'",
      )
      .get(),
  );
  const reads = f.metrics.appointmentReads;
  for (let i = 0; i < 20; i++) run.schedule();
  assert.equal(f.metrics.appointmentReads, reads);
  assert.deepEqual(f.database.db.prepare('SELECT * FROM notification_channel_jobs').all(), history);
});

test('reminder opt-out keeps schema18 appointment and profile reads at zero until it is selected again', (t) => {
  const f = scheduleFixture(t);
  f.link();
  const previous = f.platform.telegram.settings('org');
  f.platform.telegram.saveReminderPeriod('org', 'owner', {
    expectedLeadMinutes: previous.leadMinutes,
    leadMinutes: previous.leadMinutes,
    expectedEvents: previous.events,
    events: ['created'],
  });
  for (let pass = 0; pass < 3; pass++) f.coordinator.schedule();
  assert.equal(f.metrics.appointmentReads, 0);
  assert.equal(f.metrics.profileReads, 0);
  assert.deepEqual(jobs(f), []);
  f.platform.telegram.saveReminderPeriod('org', 'owner', {
    expectedLeadMinutes: previous.leadMinutes,
    leadMinutes: previous.leadMinutes,
    expectedEvents: ['created'],
    events: ['reminder'],
  });
  f.coordinator.schedule();
  assert.equal(f.metrics.appointmentReads, 1);
  assert.equal(tasks(f).length, 1);
});
