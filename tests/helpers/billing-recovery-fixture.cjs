const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { walletSchema } = require('../../src/server/modules/billing/wallet-schema.cjs');
const { serviceConnectionSchema } = require('../../src/server/modules/billing/entitlements-schema.cjs');
const { packageSchema } = require('../../src/server/modules/billing/package-schema.cjs');
const { paymentSchema } = require('../../src/server/modules/billing/payment-schema.cjs');
const { notificationBlobs } = require('../../src/server/infrastructure/backup/notification-state.cjs');

// Stub support tables serve archive validation only. Financial DDL is canonical.
function recoveryFixture(t, { seed = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-billing-recovery-')),
    platform = path.join(directory, 'platform'), key = crypto.randomBytes(32);
  fs.mkdirSync(platform);
  fs.writeFileSync(path.join(platform, 'platform.key'), key);
  const filename = path.join(platform, 'platform.sqlite'), db = new DatabaseSync(filename);
  let closed = false;
  const close = () => { if (!closed) { db.close(); closed = true; } };
  t.after(() => {
    close();
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.match(path.basename(target), /^cartoteca-billing-recovery-/);
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const seal = (value) => {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  };
  const openBytes = (rawKey, value) => {
    const bytes = Buffer.from(value),
      cipher = crypto.createDecipheriv('aes-256-gcm', rawKey, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
  };
  const open = (value) => JSON.parse(openBytes(key, value).toString('utf8'));
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE accounts(id TEXT PRIMARY KEY,value BLOB NOT NULL,global_admin INTEGER DEFAULT 0,status TEXT DEFAULT 'active');
    CREATE TABLE organizations(id TEXT PRIMARY KEY,value BLOB NOT NULL,status TEXT DEFAULT 'active');
    CREATE TABLE memberships(organization_id TEXT,account_id TEXT,role TEXT,status TEXT,created_at INTEGER);
    CREATE TABLE subscriptions(organization_id TEXT PRIMARY KEY,status TEXT,limits BLOB NOT NULL);`);
  db.exec(walletSchema + serviceConnectionSchema + packageSchema + paymentSchema);
  const blobs = {
    platform_sessions: 'value', telegram_settings: 'value', telegram_links: 'value',
    telegram_jobs: 'value', telegram_runtime: 'value', appointment_manual_confirmations: 'value',
    support_requests: 'value', work_schedule_profiles: 'value', work_schedule_days: 'value',
    email_invitations: 'value', booking_requests: 'value', staff_telegram_links: 'value',
    staff_notification_jobs: 'value', admin_operations: 'value', admin_audit_details: 'value',
    admin_directory_records: 'source_value', admin_email_recoveries: 'value',
    admin_email_jobs: 'value', support_messages: 'value', ...notificationBlobs(19),
  };
  for (const [table, column] of Object.entries(blobs))
    db.exec('CREATE TABLE ' + table + '(' + column + ' BLOB NOT NULL)');
  db.exec('CREATE TABLE max_runtime_leases(synthetic INTEGER); CREATE TABLE notification_schedule_dirty(synthetic INTEGER); PRAGMA user_version=19');
  const now = 1792400000000;
  if (seed) {
    db.prepare("INSERT INTO accounts(id,value,global_admin) VALUES('admin',?,1),('owner',?,0)")
      .run(seal({ displayName: 'Synthetic admin' }), seal({ displayName: 'Synthetic owner' }));
    db.prepare("INSERT INTO organizations(id,value) VALUES('org',?)")
      .run(seal({ name: 'Synthetic organization', timeZone: 'Europe/Moscow' }));
    db.exec("INSERT INTO memberships VALUES('org','owner','owner','active',1)");
    db.prepare("INSERT INTO subscriptions VALUES('org','active',?)").run(seal({}));
    db.exec("UPDATE billing_settings SET configured=1,revision=2");
    db.exec(`INSERT INTO billing_wallets(id,organization_id,balance_microrub,reserved_microrub)
      VALUES('org:org','org',100000000,1000000)`);
    db.prepare(`INSERT INTO billing_entries(id,wallet_id,organization_id,kind,amount_microrub,
      balance_after_microrub,actor_id,idempotency_key,fingerprint,created_at,value)
      VALUES('credit','org:org','org','credit',100000000,100000000,'admin','synthetic','hash',?,?)`)
      .run(now, seal({ reason: 'Synthetic history' }));
    db.prepare(`INSERT INTO billing_service_connections VALUES('org','voice-assistant',1,1,
      'synthetic-key-id','synthetic-hash',?,?)`)
      .run(seal({ credential: 'synthetic-credential' }), now);
    db.prepare("INSERT INTO billing_package_definitions VALUES('package','Synthetic package',99000,5,1,1,?)")
      .run(now);
    db.prepare(`INSERT INTO billing_package_grants(id,organization_id,package_id,package_version,title,
      source,source_order_id,price_kopecks,task_limit,starts_at,ends_at,actor_id,created_at)
      VALUES('grant','org','package',1,'Synthetic package','paid','order-paid',99000,5,?,?,'admin',?)`)
      .run(now, now + 2678400000, now);
    for (const [index, state] of ['reserved', 'accepted', 'uncertain'].entries())
      db.prepare(`INSERT INTO billing_package_tasks(id,grant_id,organization_id,account_id,
        session_hash,request_id,payload_hash,state,created_at) VALUES(?,'grant','org','owner','session',?,'hash',?,?)`)
        .run('task-' + index, 'request-' + index, state, now);
    db.prepare("INSERT INTO billing_package_operations VALUES('admin','package-op','hash',?,?)")
      .run(seal({ grantId: 'grant' }), now);
    db.prepare("INSERT INTO billing_payment_settings VALUES(1,4,1,?,?)")
      .run(now, seal({ shopId: '123', secretKey: 'synthetic-secret-key', testMode: true }));
    for (const state of ['pending', 'paid', 'canceled']) {
      const data = {
        order: { organizationId: 'org', accountId: 'owner', packageId: 'package' },
        seller: { shopId: '123', secretKey: 'synthetic-frozen-key' },
        receiptEmail: 'synthetic@example.test',
        confirmationUrl: 'https://yoomoney.ru/synthetic/' + state,
      };
      db.prepare(`INSERT INTO billing_payment_orders(id,organization_id,account_id,request_id,
        package_id,price_kopecks,state,provider_payment_id,provider_status,receipt_status,
        config_revision,shop_id,test_mode,created_at,changed_at,paid_confirmed_at,fulfilled_at,
        lease_until,lease_id,value)
        VALUES(?,'org','owner',?,'package',99000,?,?,'synthetic','pending',4,'123',1,?,?,?,?,99,'lease',?)`)
        .run('order-' + state, 'payment-request-' + state, state, 'provider-' + state,
          now, now, state === 'paid' ? now : null, state === 'paid' ? now : null, seal(data));
    }
    db.prepare("INSERT INTO billing_payment_operations VALUES('admin','payment-op','hash',?,?)")
      .run(seal({ revision: 4 }), now);
  }
  function manifest() {
    const organizations = db.prepare('SELECT id FROM organizations').all().map(({ id }) => ({
      id, root: 'tenants/' + id, initialized: false,
    }));
    close();
    const files = ['platform/platform.sqlite', 'platform/platform.key'].map((name) => {
      const value = fs.readFileSync(path.join(directory, name));
      return { name, size: value.length, sha256: crypto.createHash('sha256').update(value).digest('hex') };
    });
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
      format: 2, cabinets: [], organizations, files,
    }));
    return new Set(['manifest.json', ...files.map(({ name }) => name)]);
  }
  return { directory, platform, filename, db, key, now, seal, open, openBytes, close, manifest };
}
module.exports = { recoveryFixture };
