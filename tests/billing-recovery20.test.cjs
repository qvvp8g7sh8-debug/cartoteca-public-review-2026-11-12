const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { recoveryFixture } = require('./helpers/billing-recovery-fixture.cjs');
const { multiServiceSchema } = require('../src/server/modules/billing/multi-service-schema.cjs');
const { validateRecovered } = require('../src/server/infrastructure/backup/validation.cjs');
const { assertPreparedNotifications } = require('../src/server/application/startup-schema.cjs');
const {
  pauseRestoredPaidServices,
} = require('../src/server/infrastructure/backup/notification-state.cjs');
const {
  prepareMultiServiceBilling,
} = require('../src/server/migrations/prepare-multi-service-billing.cjs');
function fixture(t) {
  const f = recoveryFixture(t, { seed: true });
  f.db.exec(multiServiceSchema + 'PRAGMA user_version=20;');
  f.db
    .prepare(
      "INSERT INTO billing_financial_actions VALUES('action','admin','request','order-paid','refund','uncertain',99000,NULL,'synthetic',999,1,1,?)",
    )
    .run(f.seal({ receiptEmail: 'synthetic@example.test', reason: 'Synthetic reason' }));
  return f;
}

test('schema20 startup and archive validation accept the complete prepared state', async (t) => {
  const f = fixture(t),
    seen = f.manifest();
  assert.doesNotThrow(() => assertPreparedNotifications(f.directory, 20));
  await validateRecovered(f.directory, seen);
});
for (const statement of [
  'ALTER TABLE billing_package_definitions RENAME COLUMN receipt_json TO missing_receipt',
  'DROP TRIGGER billing_financial_frozen',
  'DROP INDEX billing_payment_open_service',
])
  test('schema20 startup rejects missing protection: ' + statement, (t) => {
    const f = fixture(t);
    f.db.exec(statement);
    f.close();
    assert.throws(() => assertPreparedNotifications(f.directory, 20), { status: 503 });
  });

test('schema20 archive validation rejects corrupt encrypted financial action', async (t) => {
  const f = fixture(t);
  f.db
    .prepare('UPDATE billing_financial_actions SET value=?')
    .run(Buffer.from('synthetic plain text'));
  const seen = f.manifest();
  await assert.rejects(() => validateRecovered(f.directory, seen));
});

test('schema20 disaster restore pauses unknown financial intent without deleting its history', (t) => {
  const f = fixture(t);
  pauseRestoredPaidServices(f.db, f.key, f.openBytes, (_, value) => f.seal(value));
  const action = f.db.prepare('SELECT * FROM billing_financial_actions').get();
  assert.equal(action.state, 'review');
  assert.equal(action.amount_kopecks, 99000);
  assert.equal(action.lease_until, 0);
  assert.equal(f.open(action.value).receiptEmail, null);
  assert.equal(
    f.open(
      f.db.prepare("SELECT value FROM billing_payment_orders WHERE id='order-paid'").get().value,
    ).restoredReview,
    true,
  );
});

test('offline preparation produces a verified20 copy and leaves source19 bytes and key unchanged', async (t) => {
  const f = recoveryFixture(t, { seed: true });
  f.close();
  const fingerprint = () =>
    crypto
      .createHash('sha256')
      .update(fs.readFileSync(f.filename))
      .update(fs.readFileSync(path.join(f.platform, 'platform.key')))
      .digest('hex');
  const before = fingerprint(),
    destination = path.join(f.directory, '..', path.basename(f.directory) + '-prepared');
  // Keep all disposable paths under the fixture root for verified cleanup.
  const outer = path.join(f.directory, 'offline-work');
  fs.mkdirSync(outer);
  const data = path.join(outer, 'source');
  fs.mkdirSync(data);
  fs.cpSync(f.platform, path.join(data, 'platform'), { recursive: true });
  const keyFile = path.join(outer, 'archive.key');
  fs.writeFileSync(keyFile, crypto.randomBytes(32));
  const prepared = path.join(outer, 'prepared');
  const result = await prepareMultiServiceBilling({
    source: data,
    destination: prepared,
    directory: path.join(outer, 'archives'),
    keyFile,
    offline: true,
  });
  assert.equal(result.schema, 20);
  assert.equal(result.paymentNetworkEnabled, false);
  assert.equal(fingerprint(), before);
  assert.equal(fs.existsSync(path.join(prepared, '.restore-in-progress')), false);
  assert.deepEqual(fs.readFileSync(path.join(prepared, 'platform/platform.key')), f.key);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(prepared, 'platform/platform.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 20);
    assert.equal(db.prepare('SELECT count(*) n FROM billing_package_grants').get().n, 1);
  } finally {
    db.close();
  }
});
