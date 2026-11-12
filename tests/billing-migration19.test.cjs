const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  migratePaidServices,
  rollbackEmptyPaidServices,
} = require('../src/server/migrations/019-paid-services.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-migration19-')),
    source = path.join(root, 'source'),
    clone = path.join(root, 'prepared'),
    key = crypto.randomBytes(32);
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'platform.key'), key);
  fs.writeFileSync(path.join(source, 'business-settings.bin'), crypto.randomBytes(128));
  const encrypt = (value) => {
    const nonce = crypto.randomBytes(12),
      cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), bytes]);
  };
  const original = new DatabaseSync(path.join(source, 'platform.sqlite'));
  original.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE accounts(id TEXT PRIMARY KEY,global_admin INTEGER,status TEXT,value BLOB);
    CREATE TABLE organizations(id TEXT PRIMARY KEY,status TEXT,value BLOB);
    CREATE TABLE memberships(organization_id TEXT,account_id TEXT,role TEXT,status TEXT);
    CREATE TABLE subscriptions(organization_id TEXT PRIMARY KEY,status TEXT,limits BLOB);
    CREATE TABLE synthetic_business_settings(id TEXT PRIMARY KEY,value BLOB);
    PRAGMA user_version=18;`);
  original
    .prepare("INSERT INTO accounts VALUES('owner',0,'active',?)")
    .run(encrypt({ displayName: 'Synthetic owner' }));
  original
    .prepare("INSERT INTO organizations VALUES('org','active',?)")
    .run(encrypt({ name: 'Synthetic organization' }));
  original.exec("INSERT INTO memberships VALUES('org','owner','owner','active')");
  original
    .prepare("INSERT INTO subscriptions VALUES('org','active',?)")
    .run(encrypt({ visits: 99 }));
  original
    .prepare("INSERT INTO synthetic_business_settings VALUES('schedule',?)")
    .run(encrypt({ start: '08:00', end: '20:00' }));
  const baseline = business(original);
  original.close();
  const originalProof = fileProof(source);
  fs.cpSync(source, clone, { recursive: true, errorOnExist: true, force: false });
  const db = new DatabaseSync(path.join(clone, 'platform.sqlite'));
  db.exec('PRAGMA foreign_keys=ON');
  const database = {
    db,
    key,
    transaction(callback) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = callback();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  t.after(() => {
    db.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^cartoteca-migration19-/);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { source, clone, db, database, key, baseline, originalProof };
}
function business(db) {
  return [
    'accounts',
    'organizations',
    'memberships',
    'subscriptions',
    'synthetic_business_settings',
  ].map((name) => ({ name, rows: db.prepare('SELECT * FROM ' + name + ' ORDER BY rowid').all() }));
}
function fileProof(directory) {
  return fs
    .readdirSync(directory)
    .sort()
    .map((name) => ({
      name,
      hash: crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(directory, name)))
        .digest('hex'),
    }));
}
test('real offline 18→19 migration preserves synthetic accounts, settings and keys while original copy stays byte-identical', (t) => {
  const f = fixture(t),
    result = migratePaidServices(f.database, f.clone);
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 19);
  assert.equal(f.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual(business(f.db), f.baseline);
  assert.deepEqual(fileProof(f.source), f.originalProof);
  assert.ok(fs.readFileSync(path.join(f.clone, 'platform.key')).equals(f.key));
  assert.ok(fs.readFileSync(path.join(result.snapshotDirectory, 'platform.key')).equals(f.key));
  const snapshot = new DatabaseSync(path.join(result.snapshotDirectory, 'platform.sqlite'), {
    readOnly: true,
  });
  try {
    assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 18);
    assert.deepEqual(business(snapshot), f.baseline);
  } finally {
    snapshot.close();
  }
  assert.equal(f.db.prepare('SELECT configured FROM billing_settings').get().configured, 0);
  for (const name of [
    'billing_package_definitions',
    'billing_package_grants',
    'billing_payment_settings',
    'billing_payment_orders',
    'billing_service_connections',
  ])
    assert.equal(f.db.prepare('SELECT count(*) n FROM ' + name).get().n, 0);
  assert.equal(migratePaidServices(f.database, f.clone), undefined);
});
test('empty financial migration rolls back completely to 18 without touching business ciphertext', (t) => {
  const f = fixture(t);
  migratePaidServices(f.database, f.clone);
  rollbackEmptyPaidServices(f.database);
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 18);
  assert.deepEqual(business(f.db), f.baseline);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'billing_%'").get().n,
    0,
  );
  assert.deepEqual(fileProof(f.source), f.originalProof);
});
for (const kind of ['package', 'payment-settings'])
  test('rollback refuses to discard ' + kind + ' history and keeps version 19 atomically', (t) => {
    const f = fixture(t);
    migratePaidServices(f.database, f.clone);
    if (kind === 'package')
      f.db.exec(
        "INSERT INTO billing_package_definitions VALUES('trial','Synthetic trial',100,1,1,1,1)",
      );
    else
      f.db
        .prepare('INSERT INTO billing_payment_settings VALUES(1,1,0,1,?)')
        .run(Buffer.from('synthetic encrypted settings placeholder'));
    assert.throws(() => rollbackEmptyPaidServices(f.database), /history or connections/u);
    assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 19);
    assert.deepEqual(business(f.db), f.baseline);
    assert.deepEqual(fileProof(f.source), f.originalProof);
  });
test('failed real DDL migration restores schema18 and preserves the verified pre-migration snapshot', (t) => {
  const f = fixture(t);
  f.db.exec('CREATE TABLE billing_package_definitions(synthetic TEXT)');
  assert.throws(() => migratePaidServices(f.database, f.clone), /already exists/u);
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 18);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='billing_wallets'").get().n,
    0,
  );
  assert.deepEqual(business(f.db), f.baseline);
  const snapshots = fs.readdirSync(path.join(f.clone, 'migration-backups'));
  assert.equal(snapshots.length, 1);
  assert.ok(
    fs
      .readFileSync(path.join(f.clone, 'migration-backups', snapshots[0], 'platform.key'))
      .equals(f.key),
  );
});
