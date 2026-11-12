const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { scheduleFixture } = require('./helpers/notification-schedule-fixture.cjs');
const { staffMaxFixture } = require('./helpers/staff-max-fixture.cjs');
const {
  migrateNotificationSchedule,
  rollbackNotificationSchedule,
} = require('../src/server/migrations/018-notification-schedule.cjs');
const {
  prepareNotificationScheduleUpgrade,
} = require('../src/server/migrations/prepare-notification-schedule.cjs');
const { createPlatformStore } = require('../src/server/application/platform.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const {
  createV2Backup,
  restoreV2Backup,
} = require('../src/server/infrastructure/backup/service.cjs');

test('schema18 snapshots schema17, keeps authoritative ciphertext and permits derived rollback only without intents', (t) => {
  const f = scheduleFixture(t, { migrate: false }),
    db = f.database.db;
  const before = db.prepare('SELECT * FROM accounts ORDER BY id').all();
  const result = migrateNotificationSchedule(f.database, f.directory);
  const snapshot = new DatabaseSync(path.join(result.snapshotDirectory, 'platform.sqlite'), {
    readOnly: true,
  });
  try {
    assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 17);
    assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(snapshot.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(snapshot.prepare('SELECT * FROM accounts ORDER BY id').all(), before);
  } finally {
    snapshot.close();
  }
  assert.deepEqual(
    fs.readFileSync(path.join(result.snapshotDirectory, 'platform.key')),
    f.database.key,
  );
  const s =
    require('../src/server/modules/notifications/notification-schedule-store.cjs').createNotificationScheduleStore(
      f.context,
    );
  assert.equal(s.enabled, false);
  const intent = s.beginIntent('org', 'synthetic');
  assert.throws(() => rollbackNotificationSchedule(f.database), /Unsettled/);
  f.database.transaction(() => {
    s.ackIntent(intent);
    s.markDirty('org');
  });
  rollbackNotificationSchedule(f.database);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 17);
  assert.deepEqual(db.prepare('SELECT * FROM accounts ORDER BY id').all(), before);
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'notification_schedule%'")
      .get().n,
    0,
  );
});

test('failed schema18 DDL rolls back completely and platform dirty events roll back with their writers', (t) => {
  const f = scheduleFixture(t, { migrate: false }),
    db = f.database.db;
  db.exec('DROP TABLE work_schedule_profiles');
  assert.throws(
    () => migrateNotificationSchedule(f.database, f.directory),
    /work_schedule_profiles/,
  );
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 17);
  assert.equal(
    db.prepare("SELECT 1 FROM sqlite_master WHERE name='notification_schedule'").get(),
    undefined,
  );
});

test('dirty trigger is transactional and schema18 startup does not activate its new scheduler implicitly', (t) => {
  const f = scheduleFixture(t),
    db = f.database.db;
  db.prepare('DELETE FROM notification_schedule_dirty').run();
  assert.throws(
    () =>
      f.database.transaction(() => {
        db.prepare("UPDATE organizations SET status='paused' WHERE id='org'").run();
        throw Error('synthetic rollback');
      }),
    /synthetic rollback/,
  );
  assert.equal(db.prepare('SELECT count(*) n FROM notification_schedule_dirty').get().n, 0);
  const p = createPlatformStore(f.directory, { notificationSchema: 18 });
  try {
    assert.equal(p.notificationSchedule.enabled, false);
    assert.ok(p.staffPush);
  } finally {
    p.close();
  }
});

test('complete copy preparation preserves source17, restores schema18 paused and does not retain stale projection/intents', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  const keyFile = path.join(f.directory, 'synthetic-backup.key');
  fs.writeFileSync(keyFile, crypto.randomBytes(32));
  const directory = path.join(f.directory, 'archives'),
    destination = path.join(f.directory, 'schedule-copy');
  const result = await prepareNotificationScheduleUpgrade({
    source: f.source,
    destination,
    directory,
    keyFile,
  });
  assert.equal(result.schema, 18);
  assert.equal(result.sourceUnchanged, true);
  assert.equal(result.scheduleEnabledByDefault, false);
  assert.equal(f.database.db.prepare('PRAGMA user_version').get().user_version, 17);
  const p = createPlatformStore(path.join(destination, 'platform'), { notificationSchema: 18 });
  try {
    p.notificationSchedule.beginIntent(f.owner.organizationId, 'synthetic-interrupted');
    p.withWriteLock(() =>
      p.notificationSchedule.replaceTasks('client', f.owner.organizationId, 'synthetic-patient', [
        {
          entity: 'synthetic-appointment',
          dueAt: 1,
          expiresAt: 2,
          value: { stamp: 'synthetic-stamp' },
        },
      ]),
    );
  } finally {
    p.close();
  }
  const archive = await createV2Backup({ source: destination, directory, keyFile });
  const recovered = path.join(f.directory, 'recovered-schedule');
  await restoreV2Backup(archive.file, keyFile, recovered);
  const db = createPlatformDatabase(path.join(recovered, 'platform'), { notificationSchema: 18 });
  try {
    assert.equal(db.db.prepare('SELECT count(*) n FROM notification_schedule').get().n, 0);
    assert.equal(db.db.prepare('SELECT count(*) n FROM notification_schedule_intents').get().n, 0);
    assert.equal(db.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    db.db.close();
  }
  await assert.rejects(
    () =>
      prepareNotificationScheduleUpgrade({
        source: f.source,
        destination: f.source,
        directory,
        keyFile,
      }),
    /separate/,
  );
});
