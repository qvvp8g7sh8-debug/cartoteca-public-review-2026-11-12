const test = require('node:test');
const assert = require('node:assert/strict');
const { scheduleFixture } = require('./helpers/notification-schedule-fixture.cjs');
const {
  createNotificationScheduleStore,
} = require('../src/server/modules/notifications/notification-schedule-store.cjs');
const { createPlatformStore } = require('../src/server/application/platform.cjs');

test('passive schedule owner skips the whole startup reconciliation while keeping dirty writes and intents active', (t) => {
  const f = scheduleFixture(t),
    db = f.database.db;
  f.link();
  db.prepare('DELETE FROM notification_schedule_dirty').run();
  let scans = 0;
  const context = {
    ...f.context,
    db: {
      get isTransaction() {
        return db.isTransaction;
      },
      prepare: (sql) => db.prepare(sql),
      exec(sql) {
        if (sql.includes('INSERT INTO notification_schedule_dirty')) scans++;
        return db.exec(sql);
      },
    },
  };
  const schedule = createNotificationScheduleStore(context, {
    enabled: true,
    startupReconcile: false,
  });
  assert.equal(schedule.enabled, true);
  assert.equal(scans, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM notification_schedule_dirty').get().n, 0);
  const intent = schedule.beginIntent('org', 'synthetic-passive-operation', f.clock());
  f.database.transaction(() => {
    schedule.assertIntent(intent, f.clock());
    schedule.markDirty('org', 'client', 'p');
    schedule.ackIntent(intent);
  });
  assert.equal(schedule.nextDirty('client').subject, 'p');
  assert.equal(db.prepare('SELECT count(*) n FROM notification_schedule_intents').get().n, 0);
  createNotificationScheduleStore(context, { enabled: true });
  assert.equal(
    scans,
    1,
    'the active/default owner still performs its complete recovery reconciliation',
  );
  assert.ok(
    db
      .prepare(
        "SELECT 1 FROM notification_schedule_dirty WHERE organization_id='org' AND subject=''",
      )
      .get(),
  );
});

test('platform command composition forwards passive startup without disabling the schedule', (t) => {
  const f = scheduleFixture(t),
    db = f.database.db;
  f.link();
  db.prepare('DELETE FROM notification_schedule_dirty').run();
  const platform = createPlatformStore(f.directory, {
    notificationSchema: 18,
    scheduledNotifications: true,
    scheduleStartupReconcile: false,
    notificationChannelProjection: true,
    assistantComposition: false,
  });
  try {
    assert.equal(platform.notificationSchedule.enabled, true);
    assert.equal(db.prepare('SELECT count(*) n FROM notification_schedule_dirty').get().n, 0);
    platform.withWriteLock(() => platform.notificationSchedule.markDirty('org', 'client', 'p'));
    assert.equal(platform.notificationSchedule.nextDirty('client').subject, 'p');
  } finally {
    platform.close();
  }
});
