const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { recoveryFixture } = require('./helpers/billing-recovery-fixture.cjs');
const { assertPreparedNotifications } = require('../src/server/application/startup-schema.cjs');
const {
  billingTriggers,
} = require('../src/server/modules/billing/prepared-schema.cjs');
const {
  pauseRestoredPaidServices,
} = require('../src/server/infrastructure/backup/notification-state.cjs');
const { validateRecovered } = require('../src/server/infrastructure/backup/validation.cjs');
const {
  organizationContext,
} = require('../src/server/infrastructure/backup/organization-policy.cjs');

const hash = (filename) => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');

test('schema19 prepared startup accepts the complete package/payment schema without writing', (t) => {
  const f = recoveryFixture(t);
  f.close();
  const before = hash(f.filename);
  assert.doesNotThrow(() => assertPreparedNotifications(f.directory, 19));
  assert.equal(hash(f.filename), before);
});

for (const table of [
  'billing_package_definitions', 'billing_package_grants', 'billing_package_tasks',
  'billing_package_operations', 'billing_payment_settings', 'billing_payment_orders',
  'billing_payment_operations',
])
  test('schema19 startup rejects missing ' + table + ' and never repairs it', (t) => {
    const f = recoveryFixture(t);
    f.db.exec('DROP TABLE ' + table);
    f.close();
    const before = hash(f.filename);
    assert.throws(() => assertPreparedNotifications(f.directory, 19), { status: 503 });
    assert.equal(hash(f.filename), before);
  });

for (const [trigger] of billingTriggers)
  test('schema19 startup requires immutable history trigger ' + trigger, (t) => {
    const f = recoveryFixture(t);
    f.db.exec('DROP TRIGGER ' + trigger);
    f.close();
    assert.throws(() => assertPreparedNotifications(f.directory, 19), { status: 503 });
  });

test('schema19 startup rejects a missing encrypted payment column', (t) => {
  const f = recoveryFixture(t);
  f.db.exec('ALTER TABLE billing_payment_orders RENAME COLUMN value TO untrusted');
  f.close();
  assert.throws(() => assertPreparedNotifications(f.directory, 19), { status: 503 });
});

test('public archive validation reads every valid package/payment encrypted record', async (t) => {
  const f = recoveryFixture(t, { seed: true }), seen = f.manifest();
  const result = await validateRecovered(f.directory, seen);
  assert.deepEqual(result.counts, {
    accounts: 2, organizations: 1, cabinets: 0, patients: 0, photos: 0,
  });
});

for (const table of [
  'billing_package_operations', 'billing_payment_settings', 'billing_payment_orders',
  'billing_payment_operations',
])
  test('public archive validation rejects corrupt ciphertext in ' + table, async (t) => {
    const f = recoveryFixture(t, { seed: true });
    f.db.prepare('UPDATE ' + table + ' SET value=?').run(Buffer.from('synthetic plaintext'));
    const seen = f.manifest();
    await assert.rejects(() => validateRecovered(f.directory, seen));
  });

test('full financial restore pauses capabilities and old orders without rewriting money or task quota', (t) => {
  const f = recoveryFixture(t, { seed: true });
  const tables = [
    'billing_wallets', 'billing_entries', 'billing_package_definitions',
    'billing_package_grants', 'billing_package_tasks', 'billing_package_operations',
    'billing_payment_operations',
  ];
  const before = new Map(tables.map((table) => [
    table, f.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all(),
  ]));
  const paymentColumns = 'id,organization_id,account_id,request_id,package_id,price_kopecks,' +
    'provider_payment_id,provider_status,receipt_status,config_revision,shop_id,test_mode,' +
    'created_at,paid_confirmed_at,fulfilled_at';
  const orderHistory = f.db.prepare('SELECT ' + paymentColumns + ' FROM billing_payment_orders ORDER BY id').all();
  const beforePaid = f.open(f.db.prepare("SELECT value FROM billing_payment_orders WHERE state='paid'").get().value);
  f.db.exec('BEGIN IMMEDIATE');
  pauseRestoredPaidServices(f.db, f.key, f.openBytes, (_, value) => f.seal(value));
  f.db.exec('COMMIT');
  for (const table of tables)
    assert.deepEqual(f.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all(), before.get(table), table);
  assert.deepEqual(
    f.db.prepare('SELECT ' + paymentColumns + ' FROM billing_payment_orders ORDER BY id').all(),
    orderHistory,
  );
  const connection = f.db.prepare('SELECT * FROM billing_service_connections').get();
  assert.equal(connection.enabled, 0);
  assert.equal(connection.key_id, null);
  assert.equal(connection.credential_hash, null);
  assert.equal(f.open(connection.value).credential, null);
  const config = f.db.prepare('SELECT * FROM billing_payment_settings').get();
  assert.equal(config.configured, 0);
  assert.equal(config.revision, 5);
  assert.equal(f.open(config.value).secretKey, null);
  for (const order of f.db.prepare('SELECT * FROM billing_payment_orders ORDER BY id').all()) {
    const value = f.open(order.value);
    assert.equal(value.restoredReview, true);
    assert.equal(value.seller.secretKey, null);
    assert.equal(order.lease_until, 0);
    assert.equal(order.lease_id, null);
    if (order.id === 'order-pending') {
      assert.equal(order.state, 'review');
      assert.equal(value.receiptEmail, null);
      assert.equal(value.confirmationUrl, null);
    }
    if (order.id === 'order-paid') {
      assert.equal(order.state, 'paid');
      assert.equal(value.receiptEmail, beforePaid.receiptEmail);
      assert.equal(value.confirmationUrl, beforePaid.confirmationUrl);
    }
  }
  assert.throws(() => f.db.exec("UPDATE billing_package_grants SET task_limit=999"));
  assert.throws(() => f.db.exec("DELETE FROM billing_package_grants"));
  assert.throws(() => f.db.exec("DELETE FROM billing_entries"));
});

test('organization-only recovery classifies grants, tasks and orders as preserved current state', (t) => {
  const f = recoveryFixture(t, { seed: true });
  f.close();
  const historical = path.join(f.directory, 'historical');
  fs.mkdirSync(path.join(historical, 'platform'), { recursive: true });
  for (const name of ['platform.sqlite', 'platform.key'])
    fs.copyFileSync(path.join(f.platform, name), path.join(historical, 'platform', name));
  for (const root of [f.directory, historical]) {
    const folder = path.join(root, 'tenants', 'org');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'encryption.key'), f.key);
    const cabinet = new DatabaseSync(path.join(folder, 'cabinet.sqlite'));
    cabinet.exec('CREATE TABLE patients(id TEXT PRIMARY KEY,value BLOB)');
    cabinet.close();
  }
  const before = hash(f.filename);
  const context = organizationContext(f.directory, historical, 'org');
  for (const table of [
    'billing_wallets', 'billing_entries', 'billing_package_grants',
    'billing_package_tasks', 'billing_payment_orders',
  ])
    assert.equal(context.policy.find(({ name }) => name === table)?.mode, 'preserve', table);
  assert.equal(hash(f.filename), before);
  const db = new DatabaseSync(f.filename);
  db.exec('CREATE TABLE unclassified_paid_feature(organization_id TEXT)');
  db.close();
  assert.throws(() => organizationContext(f.directory, historical, 'org'), /Unclassified/);
});
