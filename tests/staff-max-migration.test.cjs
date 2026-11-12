const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { staffMaxFixture } = require('./helpers/staff-max-fixture.cjs');
const {
  migrateStaffMax,
  rollbackEmptyStaffMax,
} = require('../src/server/migrations/016-staff-max.cjs');
const { prepareStaffMaxUpgrade } = require('../src/server/migrations/prepare-staff-max.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { createPlatformStore } = require('../src/server/application/platform.cjs');
const {
  assertPreparedNotifications,
  createConfiguredMultiServer,
} = require('../src/server/application/max-startup.cjs');
const {
  createV2Backup,
  verifyV2Backup,
  restoreV2Backup,
  createBackupKey,
} = require('../src/server/infrastructure/backup/service.cjs');

test('schema 16 requires explicit preparation, preserves existing ciphertext, and empty rollback returns to 15', async (t) => {
  const f = await staffMaxFixture(t, { schema: 15 });
  f.connectTelegram(f.users[2], 2);
  const before = f.database.db.prepare('SELECT value FROM staff_telegram_links').get().value;
  assert.throws(() => assertPreparedNotifications(f.source, 16), { status: 503 });
  const result = migrateStaffMax(f.database, f.platformDirectory);
  assert.deepEqual(
    f.database.db.prepare('SELECT value FROM staff_telegram_links').get().value,
    before,
  );
  const snapshot = new DatabaseSync(path.join(result.snapshotDirectory, 'platform.sqlite'), {
    readOnly: true,
  });
  try {
    assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 15);
    assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(snapshot.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    snapshot.close();
  }
  assertPreparedNotifications(f.source, 16);
  assert.throws(() => createPlatformDatabase(f.platformDirectory), /schema|version|верси|схем/i);
  assert.throws(() => assertPreparedNotifications(f.source), { status: 503 });
  rollbackEmptyStaffMax(f.database);
  assert.equal(f.database.db.prepare('PRAGMA user_version').get().user_version, 15);
  assertPreparedNotifications(f.source, 15);
});

test('rollback refuses nonempty staff MAX and failed DDL cannot partly change schema', async (t) => {
  const f = await staffMaxFixture(t);
  f.connect(f.users[2], 2);
  assert.throws(() => rollbackEmptyStaffMax(f.database), /data exists/);
  assert.equal(f.database.db.prepare('PRAGMA user_version').get().user_version, 16);
  const other = await staffMaxFixture(t, { schema: 15 });
  other.database.db.exec('CREATE TABLE staff_max_jobs(bad TEXT)');
  assert.throws(() => migrateStaffMax(other.database, other.platformDirectory));
  assert.equal(other.database.db.prepare('PRAGMA user_version').get().user_version, 15);
  assert.equal(
    other.database.db.prepare("SELECT 1 FROM sqlite_master WHERE name='staff_max_links'").get(),
    undefined,
  );
});

test('invalid explicit MAX schema is rejected before reading bot configuration or calling provider', async (t) => {
  const f = await staffMaxFixture(t);
  let calls = 0;
  await assert.rejects(
    () =>
      createConfiguredMultiServer(
        { dataDir: f.source, maxEnabled: true },
        {
          environment: { CARTOTECA_MAX_SCHEMA: '016', MAX_PROTECTED_CONFIG: 'must-not-be-read' },
          fetchImpl: async () => {
            calls++;
            throw Error('Must not call provider');
          },
        },
      ),
    { status: 503 },
  );
  assert.equal(calls, 0);
});

test('offline 15→16 preparation keeps source/session/Telegram unchanged and verifies full separate archives', async (t) => {
  const f = await staffMaxFixture(t, { schema: 15 });
  f.connectTelegram(f.users[2], 2);
  const directory = path.join(f.directory, 'archives'),
    keyFile = path.join(f.directory, 'keys', 'backup.key');
  createBackupKey(keyFile);
  const destination = path.join(f.directory, 'prepared');
  const before = f.database.db.prepare('SELECT value FROM staff_telegram_links').get().value;
  const result = await prepareStaffMaxUpgrade({
    source: f.source,
    destination,
    directory,
    keyFile,
  });
  assert.equal(result.schema, 16);
  assert.equal(result.sourceUnchanged, true);
  assert.equal(result.sessionsRevoked, false);
  assert.equal(f.database.db.prepare('PRAGMA user_version').get().user_version, 15);
  assert.deepEqual(
    f.database.db.prepare('SELECT value FROM staff_telegram_links').get().value,
    before,
  );
  assert.equal(f.platform.session(f.users[2].token).accountId, f.users[2].accountId);
  await verifyV2Backup(result.beforeArchive, keyFile);
  await verifyV2Backup(result.preparedArchive, keyFile);
  const copy = createPlatformStore(path.join(destination, 'platform'), { notificationSchema: 16 });
  try {
    assert.equal(copy.session(f.users[2].token).accountId, f.users[2].accountId);
    assert.equal(copy.staffNotifications.status(f.users[2].token).enabled, true);
  } finally {
    copy.close();
  }
  assert.equal(fs.existsSync(path.join(destination, '.restore-in-progress')), false);
  await assert.rejects(
    () => prepareStaffMaxUpgrade({ source: f.source, destination: f.source, directory, keyFile }),
    /separate/,
  );
  await assert.rejects(
    () => prepareStaffMaxUpgrade({ source: f.source, destination, directory, keyFile }),
    /new destination/,
  );
});

test('schema 16 disaster restore revokes start links, pauses staff delivery and rotates binding independently', async (t) => {
  const f = await staffMaxFixture(t);
  const issued = f.connect(f.users[2], 2);
  f.create();
  f.platform.staffMaxNotifications.issue(f.users[3].token, '123', f.clock());
  const binding = f.platform.staffMaxNotifications.status(f.users[2].token, '123').bindingId;
  const directory = path.join(f.directory, 'archives'),
    keyFile = path.join(f.directory, 'keys', 'backup.key');
  createBackupKey(keyFile);
  const backup = await createV2Backup({ source: f.source, directory, keyFile });
  assert.equal(backup.verified, true);
  await verifyV2Backup(backup.file, keyFile);
  const destination = path.join(f.directory, 'recovered');
  const result = await restoreV2Backup(backup.file, keyFile, destination);
  assert.equal(result.sessionsRevoked, true);
  assert.equal(result.notificationsPaused, true);
  const restored = createPlatformDatabase(path.join(destination, 'platform'), {
    notificationSchema: 16,
  });
  const platform = createPlatformStore(path.join(destination, 'platform'), {
    notificationSchema: 16,
  });
  try {
    assert.equal(platform.session(f.users[2].token), null);
    assert.equal(restored.db.prepare('SELECT count(*) n FROM staff_max_tokens').get().n, 0);
    const link = restored.open(
      restored.db.prepare('SELECT value FROM staff_max_links').get().value,
    );
    assert.equal(link.enabled, false);
    assert.notEqual(link.bindingId, binding);
    assert.equal(restored.db.prepare('SELECT status FROM staff_max_jobs').get().status, 'failed');
    assert.throws(
      () =>
        platform.staffMaxNotifications.consume(issued.token, '123', '1002', f.clock(), f.clock()),
      { status: 400 },
    );
    assert.equal(restored.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    platform.close();
    restored.db.close();
  }
  assert.equal(f.platform.staffMaxNotifications.status(f.users[2].token, '123').enabled, true);
});
