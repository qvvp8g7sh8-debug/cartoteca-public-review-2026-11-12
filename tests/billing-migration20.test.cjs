const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { fixture } = require('./helpers/billing-payment-fixture.cjs');
const { walletSchema } = require('../src/server/modules/billing/wallet-schema.cjs');
const { validatePaidSchema } = require('../src/server/modules/billing/prepared-schema.cjs');
const {
  migrateMultiServiceBilling,
  rollbackEmptyMultiServiceBilling,
} = require('../src/server/migrations/020-multi-service-billing.cjs');
const {
  validateMultiServiceSchema,
} = require('../src/server/modules/billing/multi-service-schema.cjs');
function disk(t) {
  const f = fixture(t),
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-billing20-')),
    key = crypto.randomBytes(32);
  // Migration fixtures must contain the complete schema19, not only checkout tables.
  f.db.exec(walletSchema + 'PRAGMA user_version=19');
  validatePaidSchema(f.db);
  f.packages.grantTrial('admin', f.command({ orgId: 'org-a', packageId: 'voice-start' }));
  const oldGrant = f.db.prepare('SELECT * FROM billing_package_grants').get();
  f.db.exec("VACUUM INTO '" + path.join(temp, 'platform.sqlite').replace(/'/g, "''") + "'");
  fs.writeFileSync(path.join(temp, 'platform.key'), key);
  const db = new DatabaseSync(path.join(temp, 'platform.sqlite'));
  db.exec('PRAGMA foreign_keys=ON');
  const database = {
    db,
    key,
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const v = fn();
        db.exec('COMMIT');
        return v;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
  t.after(() => {
    db.close();
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert.match(path.basename(temp), /^cartoteca-billing20-/);
    fs.rmSync(temp, { recursive: true, force: true });
  });
  return { ...f, db, database, temp, key, oldGrant };
}
test('offline20 creates verified19 snapshot while preserving populated history, sessions and keys', (t) => {
  const f = disk(t),
    accounts = f.db.prepare('SELECT * FROM accounts').all(),
    connections = f.db.prepare('SELECT * FROM billing_service_connections').all();
  const result = migrateMultiServiceBilling(f.database, f.temp, { offline: true });
  validateMultiServiceSchema(f.db);
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 20);
  assert.deepEqual(f.db.prepare('SELECT * FROM accounts').all(), accounts);
  assert.deepEqual(f.db.prepare('SELECT * FROM billing_service_connections').all(), connections);
  const current = f.db.prepare('SELECT * FROM billing_package_grants').get();
  for (const [key, value] of Object.entries(f.oldGrant)) assert.deepEqual(current[key], value);
  assert.deepEqual(fs.readFileSync(path.join(f.temp, 'platform.key')), f.key);
  const snapshot = new DatabaseSync(path.join(result.snapshotDirectory, 'platform.sqlite'), {
    readOnly: true,
  });
  try {
    assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 19);
    assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    snapshot.close();
  }
  assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(
    migrateMultiServiceBilling(f.database, f.temp, { offline: true }).alreadyPrepared,
    true,
  );
});
test('no offline authorization means no snapshot, DDL or data changes', (t) => {
  const f = disk(t);
  assert.throws(() => migrateMultiServiceBilling(f.database, f.temp), /Stop every writer/);
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 19);
  assert.equal(fs.existsSync(path.join(f.temp, 'migration-backups')), false);
});
test('rollback retains historical voice data and refuses to discard a new service', (t) => {
  const f = disk(t);
  migrateMultiServiceBilling(f.database, f.temp, { offline: true });
  rollbackEmptyMultiServiceBilling(f.database);
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 19);
  validatePaidSchema(f.db);
  assert.deepEqual(f.db.prepare('SELECT * FROM billing_package_grants').get(), f.oldGrant);
  migrateMultiServiceBilling(f.database, f.temp, { offline: true });
  f.db.prepare("INSERT INTO billing_services VALUES('reports','Reports',1)").run();
  assert.throws(() => rollbackEmptyMultiServiceBilling(f.database), /Additional services exist/);
});
