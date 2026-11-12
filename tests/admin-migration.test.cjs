const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { spawn } = require('node:child_process');
const { adminFixture } = require('./helpers/admin-fixture.cjs');
const { migratePlatformAdministration } = require('../src/server/migrations/011-platform-administration.cjs');

function versionTen(f) {
  f.database.db.exec(`DROP TABLE admin_operations; DROP TABLE admin_audit_details;
    DROP TABLE admin_directory_terms; DROP TABLE admin_directory_records;
    DROP TABLE admin_email_jobs; DROP TABLE admin_email_recoveries;
    DROP TABLE support_messages; DROP TABLE support_cases; DROP TABLE admin_resource_versions;
    DROP INDEX platform_audit_actor_time; DROP INDEX platform_audit_org_time;
    DROP INDEX platform_audit_event_id; DROP INDEX admin_organizations_order;
    DROP INDEX admin_accounts_order; DROP INDEX admin_membership_account; PRAGMA user_version=10;`);
}

test('migration 011 snapshots version 10, preserves identities and backfills workflow without reopening blocked organization', async t => {
  const f = await adminFixture(t);
  const before = Buffer.from(f.database.db.prepare('SELECT value FROM accounts WHERE id=?').get(f.owner.accountId).value);
  const receipt = f.store.support.create({ accountId: f.owner.accountId, organizationId: f.owner.organizationId },
    { requestId: f.database.id(), description: 'Прежнее обращение' });
  versionTen(f);
  f.database.db.prepare("UPDATE organizations SET status='suspended' WHERE id=?").run(f.owner.organizationId);
  f.database.db.prepare("UPDATE subscriptions SET status='suspended' WHERE organization_id=?").run(f.owner.organizationId);
  migratePlatformAdministration(f.database, f.platformDirectory);
  assert.equal(f.database.db.prepare('PRAGMA user_version').get().user_version, 11);
  assert.equal(f.database.db.prepare('SELECT state FROM support_cases WHERE request_id=?').get(receipt.id).state, 'new');
  assert.deepEqual(Buffer.from(f.database.db.prepare('SELECT value FROM accounts WHERE id=?').get(f.owner.accountId).value), before);
  assert.equal(f.store.organization(f.owner.organizationId).status, 'suspended');
  assert.equal(f.store.subscription(f.owner.organizationId).status, 'active');
  const backups = fs.readdirSync(path.join(f.platformDirectory, 'migration-backups')).filter(x => x.startsWith('before-011-'));
  assert.equal(backups.length, 1);
  const target = path.join(f.platformDirectory, 'migration-backups', backups[0]);
  const snapshot = new DatabaseSync(path.join(target, 'platform.sqlite'), { readOnly: true });
  try {
    assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 10);
    assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(snapshot.prepare('SELECT status FROM subscriptions WHERE organization_id=?').get(f.owner.organizationId).status, 'suspended');
    assert.deepEqual(fs.readFileSync(path.join(target, 'platform.key')), fs.readFileSync(path.join(f.platformDirectory, 'platform.key')));
  } finally { snapshot.close(); }
  migratePlatformAdministration(f.database, f.platformDirectory);
  assert.equal(fs.readdirSync(path.join(f.platformDirectory, 'migration-backups')).filter(x => x.startsWith('before-011-')).length, 1);
});

test('failed migration rolls back DDL and version; repaired schema migrates without lost accounts', async t => {
  const f = await adminFixture(t);
  versionTen(f);
  f.database.db.exec('CREATE TABLE admin_operations(conflict TEXT);');
  assert.throws(() => migratePlatformAdministration(f.database, f.platformDirectory), /already exists/);
  assert.equal(f.database.db.prepare('PRAGMA user_version').get().user_version, 10);
  assert.equal(f.database.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='admin_resource_versions'").get().n, 0);
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM accounts').get().n, 3);
  f.database.db.exec('DROP TABLE admin_operations;');
  migratePlatformAdministration(f.database, f.platformDirectory);
  assert.deepEqual(f.database.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('two independent processes can migrate the same platform without duplicate schema or partial writes', async t => {
  const f = await adminFixture(t);
  versionTen(f);
  const entry = path.resolve(__dirname, '../platform-store.cjs');
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e',
      "const s=require(process.argv[1]).createPlatformStore(process.argv[2]);s.close();", entry, f.platformDirectory], { windowsHide: true });
    let error = '';
    child.stderr.on('data', text => { error += text; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(Error(error)));
  });
  await Promise.all([run(), run()]);
  assert.equal(f.database.db.prepare('PRAGMA user_version').get().user_version, 11);
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM accounts').get().n, 3);
  assert.deepEqual(f.database.db.prepare('PRAGMA foreign_key_check').all(), []);
});
