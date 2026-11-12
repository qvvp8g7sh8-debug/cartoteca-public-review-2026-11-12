const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const sharp = require('sharp');
const { createStorage } = require('../storage.cjs');
const { createPlatformStore } = require('../platform-store.cjs');
const {
  prepareCabinetRecordsCopy,
} = require('../src/server/migrations/prepare-cabinet-records.cjs');
const {
  createV2Backup,
  verifyV2Backup,
  restoreV2Backup,
  createBackupKey,
} = require('../src/server/infrastructure/backup/service.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const {
  prepareOrganizationRestore,
} = require('../src/server/infrastructure/backup/organization-restore.cjs');
const { DatabaseSync } = require('node:sqlite');
function upgradePlatform(source) {
  const directory = path.join(source, 'platform'),
    database = createPlatformDatabase(directory);
  try {
    for (const [file, method] of [
      ['012-max-connections', 'migrateMaxConnections'],
      ['013-notification-queue', 'migrateNotificationQueue'],
      ['014-notification-channels', 'migrateNotificationChannels'],
      ['015-max-inbox', 'migrateMaxInbox'],
      ['016-staff-max', 'migrateStaffMax'],
      ['017-staff-push', 'migrateStaffPush'],
      ['018-notification-schedule', 'migrateNotificationSchedule'],
    ])
      require('../src/server/migrations/' + file + '.cjs')[method](database, directory);
    return database;
  } catch (error) {
    database.db.close();
    throw error;
  }
}
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-records-backup-'));
  const source = path.join(root, 'data'),
    stores = [];
  t.after(() => {
    for (const store of stores) {
      try {
        store.close();
      } catch {}
    }
    if (
      path.dirname(root) === path.resolve(os.tmpdir()) &&
      /^cartoteca-records-backup-/.test(path.basename(root))
    )
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  });
  const platform = createPlatformStore(path.join(source, 'platform'));
  stores.push(platform);
  const owner = await platform.registerOwner({
    email: 'records@example.test',
    password: 'Synthetic-records-backup-password',
    displayName: 'Synthetic owner',
    organizationName: 'Synthetic organization',
  });
  platform.verifyEmail(owner.verificationToken);
  const original = createStorage(path.join(root, 'old-tenant'));
  stores.push(original);
  const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#203040' } })
    .png()
    .toBuffer();
  original.write({
    revision: 0,
    services: [],
    patients: [
      {
        id: 'p',
        name: 'Synthetic',
        createdBy: owner.accountId,
        visits: [
          {
            id: 'v',
            date: '2020-01-01',
            procedure: 'Synthetic',
            staffId: owner.accountId,
            photos: [{ data: 'data:image/png;base64,' + image.toString('base64') }],
          },
        ],
        appointments: [
          {
            id: 'a',
            date: '2030-01-01',
            time: '10:00',
            duration: 30,
            service: 'Synthetic',
            staffId: owner.accountId,
          },
        ],
      },
    ],
  });
  const expected = original.read(),
    photoId = expected.patients[0].visits[0].photos[0].data.split('/').pop();
  const photo = original.photo(photoId).buffer;
  fs.mkdirSync(path.join(source, 'tenants'), { recursive: true });
  const cabinet = path.join(source, 'tenants', owner.organizationId);
  prepareCabinetRecordsCopy({ source: original.directory, destination: cabinet, offline: true });
  const keyFile = path.join(root, 'archive.key'),
    directory = path.join(root, 'archives');
  createBackupKey(keyFile);
  const open = (dir) => {
    const store = createStorage(dir);
    stores.push(store);
    return store;
  };
  return {
    root,
    source,
    cabinet,
    owner,
    expected,
    photoId,
    photo,
    open,
    options: { source, directory, keyFile },
  };
}

test('full backup verifies canonical ciphertext and restores schema 2 visits, appointments and photos', async (t) => {
  const f = await fixture(t),
    live = f.open(f.cabinet);
  const untouchedPhoto = fs.readFileSync(path.join(live.photoDir, f.photoId + '.enc'));
  const expected = live.read();
  expected.patients[0].appointments[0].duration = 5;
  live.write(expected);
  assert.deepEqual(fs.readFileSync(path.join(live.photoDir, f.photoId + '.enc')), untouchedPhoto);
  const state = live.read(),
    archive = await createV2Backup(f.options);
  assert.equal(archive.verified, true);
  assert.equal((await verifyV2Backup(archive.file, f.options.keyFile)).photos, 1);
  const destination = path.join(f.root, 'restored');
  await restoreV2Backup(archive.file, f.options.keyFile, destination);
  const restored = f.open(path.join(destination, 'tenants', f.owner.organizationId));
  assert.equal(restored.capabilities.cabinetSchemaVersion, 2);
  assert.deepEqual(restored.read(), state);
  assert.deepEqual(restored.photo(f.photoId).buffer, f.photo);
  assert.deepEqual(restored.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('backup rejects a corrupt canonical record instead of validating only the profile', async (t) => {
  const f = await fixture(t),
    live = f.open(f.cabinet);
  live.db
    .prepare("UPDATE cabinet_patient_records SET value=? WHERE kind='visit' AND id='v'")
    .run(Buffer.from('synthetic-corruption'));
  await assert.rejects(createV2Backup(f.options));
});

test('schema 18 organization restore rebuilds only derived notification state from normalized tenant data', async (t) => {
  const f = await fixture(t),
    database = upgradePlatform(f.source),
    org = f.owner.organizationId;
  try {
    database.db
      .prepare('INSERT INTO notification_schedule VALUES(?,?,?,?,?,?,?,?)')
      .run('client', org, 'p', 'a', database.seal({ synthetic: true }), 1, 2, 'old');
    database.db
      .prepare('INSERT INTO notification_schedule_intents VALUES(?,?,?,?)')
      .run('synthetic-intent', org, 3, database.seal({ synthetic: true }));
    database.db.prepare('DELETE FROM notification_schedule_dirty').run();
    database.db
      .prepare(
        "INSERT INTO notification_schedule_dirty(kind,organization_id,subject) VALUES('client',?,'p')",
      )
      .run(org);
  } finally {
    database.db.close();
  }
  const archive = await createV2Backup(f.options),
    live = f.open(f.cabinet),
    next = live.read();
  next.patients[0].appointments[0].duration = 5;
  live.write(next);
  const jobDirectory = path.join(f.root, 'org-restore');
  const result = await prepareOrganizationRestore({
    source: f.source,
    archive: archive.file,
    keyFile: f.options.keyFile,
    jobDirectory,
    organizationId: org,
  });
  assert.equal(result.state, 'prepared');
  const candidate = path.join(jobDirectory, 'candidate');
  const db = new DatabaseSync(path.join(candidate, 'platform/platform.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM notification_schedule').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM notification_schedule_intents').get().n, 0);
    assert.deepEqual(
      db
        .prepare(
          'SELECT kind,subject FROM notification_schedule_dirty WHERE organization_id=? ORDER BY kind',
        )
        .all(org)
        .map((row) => ({ ...row })),
      [
        { kind: 'client', subject: '' },
        { kind: 'workday', subject: '' },
      ],
    );
  } finally {
    db.close();
  }
  const restored = f.open(path.join(candidate, 'tenants', org));
  assert.equal(restored.capabilities.cabinetSchemaVersion, 2);
  assert.equal(restored.readAppointment('p', 'a').duration, 30);
  assert.equal(live.readAppointment('p', 'a').duration, 5);
  const rejected = path.join(f.root, 'invalid-staff');
  const current = live.read();
  current.patients[0].visits[0].staffId = 'removed-synthetic-staff';
  live.write(current);
  const badArchive = await createV2Backup(f.options);
  await assert.rejects(
    prepareOrganizationRestore({
      source: f.source,
      archive: badArchive.file,
      keyFile: f.options.keyFile,
      jobDirectory: rejected,
      organizationId: org,
    }),
    /staff reference/,
  );
});
