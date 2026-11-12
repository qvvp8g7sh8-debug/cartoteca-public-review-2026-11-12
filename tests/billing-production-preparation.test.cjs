const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { DatabaseSync } = require('node:sqlite');
const { staffMaxFixture } = require('./helpers/staff-max-fixture.cjs');
const { createStorage } = require('../storage.cjs');
const { createPlatformStore } = require('../platform-store.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const {
  migrateBookingReadBudget,
} = require('../src/server/migrations/001-booking-read-budget.cjs');
const links = require('../src/server/infrastructure/booking-public-links-schema.cjs');
const {
  dataInventory,
  inventoryFingerprint,
} = require('../src/server/infrastructure/backup/organization-inventory.cjs');
const { verifyV2Backup } = require('../src/server/infrastructure/backup/service.cjs');
const { restoreDrill } = require('../src/server/infrastructure/backup/drill.cjs');
const {
  preparePaidServicesProductionUpgrade,
  MARKER,
} = require('../src/server/migrations/prepare-paid-services-upgrade.cjs');
async function fixture(t) {
  const f = await staffMaxFixture(t, { schema: 17 });
  f.platform.createInvitation({
    organizationId: f.owner.organizationId,
    invitedBy: f.owner.accountId,
    role: 'cosmetologist',
  });
  const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#204060' } })
    .png()
    .toBuffer();
  const tenant = path.join(f.source, 'tenants', f.owner.organizationId),
    store = createStorage(tenant);
  store.write({
    revision: 0,
    services: [],
    patients: [
      {
        id: 'synthetic-client',
        name: 'Synthetic',
        visits: [
          {
            id: 'synthetic-visit',
            date: '2030-01-01',
            procedure: 'Synthetic',
            photos: [{ data: 'data:image/png;base64,' + image.toString('base64') }],
          },
        ],
        appointments: [],
      },
    ],
  });
  store.close();
  fs.writeFileSync(
    path.join(f.platformDirectory, 'assistant-state.enc'),
    f.database.seal(require('../src/server/modules/assistant/access/defaults.cjs').initialState()),
  );
  const setupMarker = path.join(f.source, '.restore-in-progress');
  fs.writeFileSync(setupMarker, 'booking-read-budget-preparation-v1', { flag: 'wx' });
  try {
    migrateBookingReadBudget(f.platformDirectory);
  } finally {
    fs.unlinkSync(setupMarker);
  }
  const connection = createPlatformDatabase(f.platformDirectory, {
    notificationSchema: 17,
    sharedCabinetWrites: true,
    isolatedReadBudgets: true,
  });
  connection.db.exec(links.schema);
  connection.db
    .prepare('INSERT INTO booking_public_links VALUES(?,?,?,?)')
    .run('abcdefgh', f.owner.organizationId, '', Date.now());
  connection.closeWriter();
  connection.db.close();
  const budget = new DatabaseSync(path.join(f.platformDirectory, 'booking-read-budget.sqlite'));
  budget
    .prepare('INSERT INTO login_limits VALUES(?,?,?,?)')
    .run('booking-budget:read-address:synthetic', 7, 1000, 2000);
  budget.close();
  const keyFile = path.join(f.directory, 'synthetic-backup.key');
  fs.writeFileSync(keyFile, crypto.randomBytes(32));
  const args = {
    source: f.source,
    destination: path.join(f.directory, 'paid-copy'),
    directory: path.join(f.directory, 'archives'),
    keyFile,
    offline: true,
  };
  return { ...f, args, tenant, before: inventoryFingerprint(dataInventory(f.source)) };
}
test('official platform-only17→19 preparation preserves source, cabinet1/photos, ciphertext, sessions and registered component identities', async (t) => {
  const f = await fixture(t),
    result = await preparePaidServicesProductionUpgrade(f.args);
  assert.equal(result.previousSchema, 17);
  assert.equal(result.schema, 19);
  assert.equal(result.sourceUnchanged, true);
  assert.equal(result.paymentNetworkEnabled, false);
  assert.equal(result.cabinetSchemaUnchanged, true);
  assert.equal(result.scheduleModeUnchanged, true);
  assert.equal(result.readBudgetVersion, 1);
  assert.equal(result.bookingLinksVersion, 1);
  assert.equal(inventoryFingerprint(dataInventory(f.source)), f.before);
  assert.equal(fs.existsSync(path.join(f.args.destination, '.restore-in-progress')), false);
  const copied = createPlatformStore(path.join(f.args.destination, 'platform'), {
    notificationSchema: 19,
    sharedCabinetWrites: true,
    isolatedReadBudgets: true,
    paymentNetworkEnabled: false,
  });
  try {
    assert.equal(copied.session(f.users[0].token).accountId, f.owner.accountId);
    assert.equal(copied.notificationSchedule.enabled, false);
    assert.equal(copied.billing.payments.publicConfig().ready, false);
    assert.equal(copied.billing.packages.catalog().length, 0);
  } finally {
    copied.close();
  }
  const old = createStorage(f.tenant),
    next = createStorage(path.join(f.args.destination, 'tenants', f.owner.organizationId));
  try {
    assert.deepEqual(next.read(), old.read());
    assert.equal(next.db.prepare('PRAGMA user_version').get().user_version, 1);
    const photoId = next.read().patients[0].visits[0].photos[0].data.split('/').pop();
    assert.deepEqual(next.photo(photoId).buffer, old.photo(photoId).buffer);
  } finally {
    old.close();
    next.close();
  }
  for (const file of [result.beforeArchive, result.preparedArchive])
    assert.equal((await verifyV2Backup(file, f.args.keyFile)).organizations, 1);
  assert.deepEqual(
    await restoreDrill(result.preparedArchive, f.args.keyFile, path.join(f.directory, 'drill')),
    { restored: true, started: true, notificationsPaused: true },
  );
});
for (const collision of ['notification_schedule', 'billing_package_definitions'])
  test(
    'failed ' + collision + ' DDL leaves the official copy gated and source17 unchanged',
    async (t) => {
      const f = await fixture(t);
      f.database.db.exec('CREATE TABLE ' + collision + '(synthetic TEXT)');
      const before = inventoryFingerprint(dataInventory(f.source));
      await assert.rejects(preparePaidServicesProductionUpgrade(f.args));
      assert.equal(inventoryFingerprint(dataInventory(f.source)), before);
      assert.equal(f.database.db.prepare('PRAGMA user_version').get().user_version, 17);
      assert.equal(
        fs.readFileSync(path.join(f.args.destination, '.restore-in-progress'), 'utf8'),
        MARKER,
      );
      await assert.rejects(preparePaidServicesProductionUpgrade(f.args), /must be new/u);
    },
  );
test('production preparation rejects online, overlapping, missing component and already populated destinations', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    preparePaidServicesProductionUpgrade({ ...f.args, offline: false }),
    /Stop every writer/u,
  );
  await assert.rejects(
    preparePaidServicesProductionUpgrade({ ...f.args, destination: f.source }),
    /independent/u,
  );
  fs.mkdirSync(f.args.destination);
  await assert.rejects(preparePaidServicesProductionUpgrade(f.args), /must be new/u);
  f.database.db.exec(
    'DROP TRIGGER booking_public_links_no_delete;DROP TRIGGER booking_public_links_no_reassignment;DROP TABLE booking_public_links;DROP TABLE booking_public_links_schema',
  );
  await assert.rejects(
    preparePaidServicesProductionUpgrade({
      ...f.args,
      destination: path.join(f.directory, 'missing-component'),
    }),
    /components are required/u,
  );
  assert.equal(f.database.db.prepare('PRAGMA user_version').get().user_version, 17);
});
