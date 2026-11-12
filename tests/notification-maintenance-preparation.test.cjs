const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createPlatformStore } = require('../src/server/application/platform.cjs');
const { createMultiServer } = require('../src/server/application/server.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const {
  prepareNotificationMaintenanceCopy,
} = require('../src/server/migrations/prepare-notification-queue-maintenance.cjs');
const {
  migrateNotificationMaintenance,
} = require('../src/server/migrations/001-notification-queue-maintenance.cjs');
const { validate } = require('../src/server/infrastructure/notification-maintenance-schema.cjs');
const {
  createBackupKey,
  createV2Backup,
  verifyV2Backup,
  restoreV2Backup,
} = require('../src/server/infrastructure/backup/service.cjs');
const {
  dataInventory,
  inventoryFingerprint,
} = require('../src/server/infrastructure/backup/organization-inventory.cjs');
async function fixture(t, version = 19) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-nqm-synthetic-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^cartoteca-nqm-synthetic-/);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const source = path.join(root, 'source'),
    platformDirectory = path.join(source, 'platform');
  createStorage(source).close();
  const platform = createPlatformStore(platformDirectory);
  let owner;
  try {
    owner = await platform.registerOwner({
      email: 'nqm@example.test',
      password: 'Synthetic-nqm-password',
      displayName: 'Synthetic',
      organizationName: 'Synthetic',
    });
  } finally {
    platform.close();
  }
  const database = createPlatformDatabase(platformDirectory);
  try {
    for (const [file, method] of [
      ['012-max-connections', 'migrateMaxConnections'],
      ['013-notification-queue', 'migrateNotificationQueue'],
      ['014-notification-channels', 'migrateNotificationChannels'],
      ['015-max-inbox', 'migrateMaxInbox'],
      ['016-staff-max', 'migrateStaffMax'],
      ['017-staff-push', 'migrateStaffPush'],
      ['018-notification-schedule', 'migrateNotificationSchedule'],
      ['019-paid-services', 'migratePaidServices'],
    ])
      require('../src/server/migrations/' + file + '.cjs')[method](database, platformDirectory);
    if (version === 20)
      require('../src/server/migrations/020-multi-service-billing.cjs').migrateMultiServiceBilling(
        database,
        platformDirectory,
        { offline: true },
      );
    database.db
      .prepare(
        "INSERT INTO notification_channel_jobs(id,organization_id,patient_id,appointment_id,stamp,channel,callback_hash,value,status,next_at,expires_at) VALUES(?,?,?,?,?,?,?,?,'pending',?,?)",
      )
      .run(
        'synthetic-job',
        owner.organizationId,
        'synthetic-patient',
        'synthetic-appointment',
        'synthetic-stamp',
        'telegram',
        database.tokenHash('synthetic'),
        database.seal({ callback: 'synthetic', recipient: { chatId: '123' } }),
        Date.now(),
        Date.now() + 600000,
      );
  } finally {
    database.closeWriter();
    database.db.close();
  }
  const keyFile = path.join(root, 'keys', 'backup.key');
  createBackupKey(keyFile);
  return {
    root,
    source,
    keyFile,
    directory: path.join(root, 'archives'),
    destination: path.join(root, 'prepared'),
  };
}
function open(directory, callback) {
  const db = new DatabaseSync(path.join(directory, 'platform', 'platform.sqlite'));
  try {
    return callback(db);
  } finally {
    db.close();
  }
}
for (const version of [19, 20])
  test(`offline complete-copy preparation schema${version}, archive restore and additive rollback preserve data`, async (t) => {
    const f = await fixture(t, version);
    const before = inventoryFingerprint(dataInventory(f.source));
    const result = await prepareNotificationMaintenanceCopy({ ...f, offline: true });
    assert.equal(result.platformVersion, version);
    assert.equal(result.sourceUnchanged, true);
    assert.equal(inventoryFingerprint(dataInventory(f.source)), before);
    assert.equal(fs.existsSync(path.join(f.destination, '.restore-in-progress')), false);
    open(f.destination, (db) => {
      assert.deepEqual(validate(db), { version: 1 });
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, version);
      assert.equal(
        db.prepare("SELECT status FROM notification_channel_jobs WHERE id='synthetic-job'").get()
          .status,
        'pending',
      );
    });
    await verifyV2Backup(result.preparedArchive, f.keyFile);
    const rollback = path.join(f.root, 'rollback');
    const rolled = await prepareNotificationMaintenanceCopy({
      ...f,
      source: f.destination,
      destination: rollback,
      offline: true,
      rollback: true,
    });
    assert.equal(rolled.rollbackPreservesComponent, true);
    const legacy = createPlatformStore(path.join(rollback, 'platform'), {
      notificationSchema: version,
    });
    assert.equal(legacy.notificationMaintenance.enabled, false);
    assert.equal(legacy.notificationSchedule.enabled, false);
    legacy.close();
    const upgraded = createPlatformStore(path.join(f.destination, 'platform'), {
      notificationSchema: version,
      notificationMaintenanceEnabled: true,
    });
    assert.equal(upgraded.notificationMaintenance.enabled, true);
    assert.equal(upgraded.notificationMaintenance.stats().running, false);
    upgraded.close();
    const restored = path.join(f.root, 'restored');
    await restoreV2Backup(result.preparedArchive, f.keyFile, restored);
    open(restored, (db) => {
      assert.deepEqual(validate(db), { version: 1 });
      assert.equal(
        db.prepare("SELECT status FROM notification_channel_jobs WHERE id='synthetic-job'").get()
          .status,
        'failed',
      );
    });
    assert.equal(inventoryFingerprint(dataInventory(f.source)), before);
  });
test('preparation rejects live path, missing offline permission and failed rollback keeps startup marker', async (t) => {
  const f = await fixture(t);
  await assert.rejects(prepareNotificationMaintenanceCopy(f), /Stop all writers/);
  await assert.rejects(
    prepareNotificationMaintenanceCopy({ ...f, destination: f.source, offline: true }),
    /separate/,
  );
  assert.throws(() => migrateNotificationMaintenance(path.join(f.source, 'platform')), /ENOENT/);
  await assert.rejects(
    prepareNotificationMaintenanceCopy({ ...f, offline: true, rollback: true }),
    /Unexpected source/,
  );
  assert.equal(
    fs.readFileSync(path.join(f.destination, '.restore-in-progress'), 'utf8'),
    'notification-queue-maintenance-preparation-v1',
  );
  assert.throws(
    () =>
      createMultiServer({
        dataDir: f.destination,
        notificationSchema: 19,
        sendMail: null,
        telegramBot: null,
        production: false,
        origin: '',
      }),
    /in progress|incomplete|restore/i,
  );
});
test('enabled maintenance runs only after the owning background role lease, never in web or preflight', async (t) => {
  const f = await fixture(t);
  await prepareNotificationMaintenanceCopy({ ...f, offline: true });
  for (const processRole of ['web', 'preflight', 'background']) {
    const server = createMultiServer({
      dataDir: f.destination,
      notificationSchema: 19,
      notificationMaintenanceEnabled: true,
      processRole,
      production: false,
      origin: '',
      sendMail: null,
      telegramBot: null,
      supportDelivery: {},
      telegramAutostart: false,
      telegramIdentityAutostart: false,
      pushAutostart: false,
      maxAutostart: false,
      supportAutostart: false,
      adminEmailAutostart: false,
      bookingPublicationAutostart: false,
    });
    try {
      assert.equal(
        server.requestMetrics.snapshot().resources.notificationMaintenance.running,
        false,
      );
      server.emit('listening');
      assert.equal(
        server.requestMetrics.snapshot().resources.notificationMaintenance.enabled,
        true,
      );
      assert.equal(
        server.requestMetrics.snapshot().resources.notificationMaintenance.running,
        processRole === 'background',
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    assert.equal(server.backgroundStatus().active, false);
  }
});
test('backup and startup reject corrupt maintenance metadata without repairing or weakening billing guards', async (t) => {
  const f = await fixture(t);
  await prepareNotificationMaintenanceCopy({ ...f, offline: true });
  open(f.destination, (db) => db.exec('DROP INDEX nqm_v1_client_ready;'));
  await assert.rejects(createV2Backup({ ...f, source: f.destination }), /component schema/);
  assert.throws(
    () => createPlatformStore(path.join(f.destination, 'platform'), { notificationSchema: 19 }),
    /component schema/,
  );
  // A broken guard91 index is still rejected even before component preparation.
  open(f.source, (db) => db.exec('DROP INDEX billing_entries_wallet'));
  await assert.rejects(
    prepareNotificationMaintenanceCopy({
      ...f,
      destination: path.join(f.root, 'bad-billing'),
      offline: true,
    }),
    /Financial schema index/,
  );
});
