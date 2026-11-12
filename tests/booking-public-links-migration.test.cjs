const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createPlatformStore } = require('../platform-store.cjs');
const { createStorage } = require('../storage.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const {
  schema,
  validate,
} = require('../src/server/infrastructure/booking-public-links-schema.cjs');
const {
  migrateBookingPublicLinks,
} = require('../src/server/migrations/001-booking-public-links.cjs');
const {
  prepareBookingPublicLinksCopy,
} = require('../src/server/migrations/prepare-booking-public-links.cjs');
const {
  createBackupKey,
  createV2Backup,
  restoreV2Backup,
  verifyV2Backup,
} = require('../src/server/infrastructure/backup/service.cjs');
const {
  dataInventory,
  inventoryFingerprint,
} = require('../src/server/infrastructure/backup/organization-inventory.cjs');
const { organizationRestoreFixture } = require('./helpers/organization-restore-fixture.cjs');
const {
  prepareOrganizationRestore,
} = require('../src/server/infrastructure/backup/organization-restore.cjs');

const markerText = 'booking-public-links-preparation-v1';
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-public-links-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^cartoteca-public-links-/);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  return root;
}
function connection(directory) {
  return new DatabaseSync(path.join(directory, 'platform', 'platform.sqlite'));
}
function mappings(directory) {
  const db = connection(directory);
  try {
    return db
      .prepare('SELECT * FROM booking_public_links ORDER BY code')
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}
function addMapping(db, org, staff = '', code = 'k7m4p9x2') {
  db.prepare(
    'INSERT INTO booking_public_links(code,organization_id,staff_id,created_at) VALUES(?,?,?,?)',
  ).run(code, org, staff, 123);
}
async function fixture(t) {
  const root = temporary(t),
    source = path.join(root, 'source');
  createStorage(source).close();
  const platform = createPlatformStore(path.join(source, 'platform'));
  let owner;
  try {
    owner = await platform.registerOwner({
      email: 'short-link@example.test',
      password: 'Synthetic-short-link-2026',
      displayName: 'Synthetic',
      organizationName: 'Synthetic organization',
    });
  } finally {
    platform.close();
  }
  const keyFile = path.join(root, 'keys', 'backup.key');
  createBackupKey(keyFile);
  return { root, source, keyFile, directory: path.join(root, 'archives'), owner };
}

for (const version of [11, 17, 18])
  test(`component-v1 preserves platform schema ${version} and rollback keeps immutable mappings`, (t) => {
    const root = temporary(t),
      directory = path.join(root, 'platform');
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(root, '.restore-in-progress'), markerText);
    const db = new DatabaseSync(path.join(directory, 'platform.sqlite'));
    db.exec(
      `CREATE TABLE organizations(id TEXT PRIMARY KEY); INSERT INTO organizations VALUES('synthetic-org'); PRAGMA user_version=${version};`,
    );
    db.close();
    assert.equal(migrateBookingPublicLinks(directory).platformVersion, version);
    const prepared = new DatabaseSync(path.join(directory, 'platform.sqlite'));
    try {
      assert.deepEqual(validate(prepared), { version: 1 });
      addMapping(prepared, 'synthetic-org');
      assert.throws(
        () => prepared.prepare("UPDATE booking_public_links SET staff_id='different'").run(),
        /cannot be reassigned/,
      );
      assert.throws(
        () => prepared.prepare('DELETE FROM booking_public_links').run(),
        /must be preserved/,
      );
      for (const code of [
        'ABC12345',
        'short',
        'abcd-123',
        'abcd_123',
        'abcdefgh9',
        'abcdefgh\0tail',
      ])
        assert.throws(() => addMapping(prepared, 'synthetic-org', code, code));
    } finally {
      prepared.close();
    }
    const before = mappings(root),
      rollback = migrateBookingPublicLinks(directory, { rollback: true });
    assert.equal(rollback.platformVersion, version);
    assert.equal(rollback.rollbackPreservesComponent, true);
    assert.equal(rollback.mappingsPreserved, 1);
    assert.deepEqual(mappings(root), before);
  });

test('validation fails closed for missing component registration, bad guards and invalid rows', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      "CREATE TABLE organizations(id TEXT PRIMARY KEY); INSERT INTO organizations VALUES('org');",
    );
    assert.equal(validate(db), null);
    db.exec(schema);
    assert.deepEqual(validate(db), { version: 1 });
    addMapping(db, 'org');
    db.exec('DELETE FROM booking_public_links_schema');
    assert.throws(() => validate(db), /registration mismatch/);
    db.exec(
      'INSERT INTO booking_public_links_schema VALUES(1,1); DROP TRIGGER booking_public_links_no_delete;',
    );
    assert.throws(() => validate(db), /schema mismatch/);
  } finally {
    db.close();
  }
  for (const missing of ['booking_public_links', 'booking_public_links_schema']) {
    const broken = new DatabaseSync(':memory:');
    try {
      broken.exec('CREATE TABLE organizations(id TEXT PRIMARY KEY);' + schema);
      broken.exec('DROP TABLE ' + missing);
      assert.throws(() => validate(broken), /schema mismatch/);
    } finally {
      broken.close();
    }
  }
  const invalid = new DatabaseSync(':memory:');
  try {
    invalid.exec(
      'PRAGMA foreign_keys=OFF; CREATE TABLE organizations(id TEXT PRIMARY KEY);' + schema,
    );
    addMapping(invalid, 'absent-org');
    assert.throws(() => validate(invalid), /Invalid public booking link mapping/);
  } finally {
    invalid.close();
  }
});

test('offline preparation copies and verifies archives; disaster restore and rollback retain every code', async (t) => {
  const f = await fixture(t),
    destination = path.join(f.root, 'prepared');
  const fingerprint = inventoryFingerprint(dataInventory(f.source));
  const prepared = await prepareBookingPublicLinksCopy({ ...f, destination, offline: true });
  assert.equal(inventoryFingerprint(dataInventory(f.source)), fingerprint);
  assert.equal(prepared.sourceUnchanged, true);
  assert.equal(fs.existsSync(path.join(destination, '.restore-in-progress')), false);
  assert.equal((await verifyV2Backup(prepared.preparedArchive, f.keyFile)).organizations, 1);
  const db = connection(destination);
  try {
    addMapping(db, f.owner.organizationId);
    addMapping(db, f.owner.organizationId, f.owner.accountId, 'w4z7r9k2');
  } finally {
    db.close();
  }
  const expected = mappings(destination),
    backup = await createV2Backup({ ...f, source: destination });
  const restored = path.join(f.root, 'restored');
  await restoreV2Backup(backup.file, f.keyFile, restored);
  assert.deepEqual(mappings(restored), expected);
  const rollback = path.join(f.root, 'rollback');
  const rolled = await prepareBookingPublicLinksCopy({
    ...f,
    source: destination,
    destination: rollback,
    offline: true,
    rollback: true,
  });
  assert.equal(rolled.rollbackPreservesComponent, true);
  assert.deepEqual(mappings(rollback), expected);
  assert.equal(inventoryFingerprint(dataInventory(f.source)), fingerprint);
});

test('preparation never mutates source; failure retains the startup barrier', async (t) => {
  const f = await fixture(t),
    destination = path.join(f.root, 'failed');
  await assert.rejects(prepareBookingPublicLinksCopy({ ...f, destination }), /Stop all writers/);
  assert.equal(fs.existsSync(destination), false);
  await assert.rejects(
    prepareBookingPublicLinksCopy({ ...f, destination: f.source, offline: true }),
    /separate/,
  );
  await assert.rejects(
    prepareBookingPublicLinksCopy({ ...f, destination, offline: true, rollback: true }),
    /Unexpected source/,
  );
  assert.equal(fs.readFileSync(path.join(destination, '.restore-in-progress'), 'utf8'), markerText);
  assert.throws(
    () => createMultiServer({ dataDir: destination, telegramBot: null, sendMail: null }),
    /incomplete/,
  );
  const db = connection(f.source);
  try {
    assert.equal(validate(db), null);
  } finally {
    db.close();
  }
});

test('backup refuses a partially missing public-links component without publishing an archive', async (t) => {
  const f = await fixture(t),
    destination = path.join(f.root, 'prepared');
  await prepareBookingPublicLinksCopy({ ...f, destination, offline: true });
  const before = fs.readdirSync(f.directory).sort(),
    db = connection(destination);
  db.exec('DROP TABLE booking_public_links_schema');
  db.close();
  await assert.rejects(createV2Backup({ ...f, source: destination }), /component schema mismatch/);
  assert.deepEqual(fs.readdirSync(f.directory).sort(), before);
});

test('restoring an organization from a pre-component archive preserves current public codes across organizations', async (t) => {
  const f = await organizationRestoreFixture(t);
  const db = connection(f.source);
  try {
    db.exec(schema);
    for (const [index, owner] of f.owners.entries())
      addMapping(db, owner.organizationId, '', 'abcde00' + index);
  } finally {
    db.close();
  }
  const expected = mappings(f.source);
  await prepareOrganizationRestore(f.options);
  assert.deepEqual(mappings(path.join(f.jobDirectory, 'candidate')), expected);
  assert.deepEqual(mappings(f.source), expected);
});

test('schema17 with isolated read-budget1 keeps legacy fallback until explicit preparation and preserves its budget', async (t) => {
  const f = await fixture(t),
    platformDirectory = path.join(f.source, 'platform');
  const database =
    require('../src/server/infrastructure/platform-database.cjs').createPlatformDatabase(
      platformDirectory,
    );
  try {
    for (const [name, method] of [
      ['012-max-connections', 'migrateMaxConnections'],
      ['013-notification-queue', 'migrateNotificationQueue'],
      ['014-notification-channels', 'migrateNotificationChannels'],
      ['015-max-inbox', 'migrateMaxInbox'],
      ['016-staff-max', 'migrateStaffMax'],
      ['017-staff-push', 'migrateStaffPush'],
    ])
      require('../src/server/migrations/' + name + '.cjs')[method](database, platformDirectory);
  } finally {
    database.closeWriter();
    database.db.close();
  }
  const isolated = path.join(f.root, 'isolated');
  await require('../src/server/migrations/prepare-booking-read-budget.cjs').prepareBookingReadBudgetCopy(
    { ...f, destination: isolated, offline: true },
  );
  const mode = { notificationSchema: 17, isolatedReadBudgets: true };
  const legacy = createPlatformStore(path.join(isolated, 'platform'), mode);
  try {
    assert.equal(legacy.bookingShortLinks.available, false);
    assert.equal(
      legacy.bookingShortLinks.path(f.owner.organizationId),
      '/booking.html?organization=' + f.owner.organizationId,
    );
  } finally {
    legacy.close();
  }
  const readBudget = require('../src/server/infrastructure/booking-read-budget-store.cjs');
  const beforeDb = connection(isolated);
  const beforeRegistration = readBudget.registration(beforeDb);
  beforeDb.close();
  const destination = path.join(f.root, 'isolated-short-links');
  await prepareBookingPublicLinksCopy({ ...f, source: isolated, destination, offline: true });
  const prepared = createPlatformStore(path.join(destination, 'platform'), mode);
  try {
    assert.equal(prepared.bookingShortLinks.available, true);
    prepared.bookingShortLinks.ensure(f.owner.organizationId, [f.owner.accountId]);
    assert.match(prepared.bookingShortLinks.path(f.owner.organizationId), /^\/b\/[a-z0-9]{8}$/);
  } finally {
    prepared.close();
  }
  const afterDb = connection(destination);
  try {
    assert.equal(afterDb.prepare('PRAGMA user_version').get().user_version, 17);
    assert.deepEqual(readBudget.registration(afterDb), beforeRegistration);
    assert.deepEqual(validate(afterDb), { version: 1 });
  } finally {
    afterDb.close();
  }
});
