const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { adminFixture } = require('./helpers/admin-fixture.cjs');
const { createPlatformStore } = require('../platform-store.cjs');
const { createStorage } = require('../storage.cjs');
const { organizationUsage } = require('../src/server/infrastructure/organization-usage.cjs');

test('platform directory searches encrypted metadata and paginates without clinical fields', async t => {
  const f = await adminFixture(t, { extraAccounts: 44 });
  const admin = f.store.admin, actor = f.admin.accountId;
  assert.throws(() => f.store.adminOverview(), { status: 403 });
  assert.throws(() => admin.organizations(f.owner.accountId), { status: 403 });
  const overview = admin.overview(actor);
  assert.equal(overview.accountsTotal, 47);
  assert.equal(overview.organizationsTotal, 2);
  assert.equal('accounts' in overview, false);
  const first = admin.accounts(actor, {});
  assert.equal(first.items.length, 20);
  const second = admin.accounts(actor, { cursor: first.nextCursor });
  const third = admin.accounts(actor, { cursor: second.nextCursor });
  assert.equal(new Set([...first.items, ...second.items, ...third.items].map(x => x.id)).size, 47);
  assert.equal(third.nextCursor, null);
  assert.throws(() => admin.accounts(actor, { q: 'Анна', cursor: first.nextCursor }), { status: 400 });
  assert.throws(() => admin.accounts(actor, { cursor: 'tampered' }), { status: 400 });
  assert.deepEqual(admin.organizations(actor, { q: 'Каз Анна' }).items.map(x => x.id), [f.owner.organizationId]);
  for (const q of ['89181234567', '+79181234567', 'owner@admin.test'])
    assert.equal(admin.organizations(actor, { q }).items[0].id, f.owner.organizationId);
  assert.equal(admin.accounts(actor, { q: 'владелец Казань' }).items[0].id, f.owner.accountId);
  assert.doesNotMatch(JSON.stringify(first.items), /passwordHash|salt|patients|visits|photos/);
  for (const row of f.database.db.prepare('SELECT term_hash FROM admin_directory_terms').all())
    assert.match(row.term_hash, /^admin-search:[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(path.join(f.directory, 'tenants')), false);
});

test('profile, access and subscription are independent versioned commands', async t => {
  const f = await adminFixture(t), admin = f.store.admin, actor = f.admin.accountId, org = f.owner.organizationId;
  const profile = f.command('organization', org, { changes: { city: 'Тула', name: 'Новая студия' } });
  const result = admin.updateProfile(actor, org, profile);
  assert.deepEqual(admin.updateProfile(actor, org, profile), result);
  assert.throws(() => admin.updateProfile(actor, org, { ...profile, changes: { name: 'Другой текст' } }), { status: 409 });
  assert.throws(() => admin.updateProfile(actor, org, { ...profile, requestId: f.database.id() }), { status: 409 });
  const blocked = f.command('organization', org, { status: 'suspended' });
  admin.updateOrganizationAccess(actor, org, blocked);
  assert.equal(f.store.subscription(org).status, 'active');
  assert.equal(admin.organization(actor, org).status, 'suspended');
  const subscription = f.command('subscription', org, { plan: 'paid', limits: {
    patients: 250, photos: 5000, publicBooking: false, automaticNotifications: true } });
  admin.updateSubscription(actor, org, subscription);
  const detail = admin.organization(actor, org);
  assert.equal(detail.revision, 2);
  assert.equal(detail.subscriptionRevision, 1);
  assert.equal(detail.status, 'suspended');
  assert.equal(detail.subscriptionTerms.paymentVerified, false);
  assert.equal(detail.limits.publicBooking, false);
  assert.equal(admin.organizations(actor, { q: 'Тула' }).items[0].id, org);
  assert.equal(f.store.organization(f.other.organizationId).status, 'active');
  assert.throws(() => admin.updateOrganizationAccess(actor, org, { ...f.command('organization', org), status: 'active', plan: 'paid' }), { status: 400 });
});

test('all platform mutations require operator, reason, current version and canonical operation id', async t => {
  const f = await adminFixture(t), target = f.owner.accountId, admin = f.store.admin;
  const command = f.command('account', target, { status: 'suspended' });
  assert.throws(() => admin.updateAccountAccess(f.other.accountId, target, command), { status: 403 });
  assert.throws(() => admin.updateAccountAccess(f.admin.accountId, target, { ...command, reason: ' ' }), { status: 400 });
  assert.throws(() => admin.updateAccountAccess(f.admin.accountId, target, { ...command, requestId: '-'.repeat(36) }), { status: 400 });
  assert.throws(() => admin.revokeSessions(f.admin.accountId, f.admin.accountId, f.command('account', f.admin.accountId)), { status: 403 });
  admin.updateAccountAccess(f.admin.accountId, target, command);
  assert.equal(f.store.session(f.ownerSession.token), null);
  assert.equal(admin.account(f.admin.accountId, target).status, 'suspended');
  assert.equal(admin.operation(f.admin.accountId, command.requestId).result.ok, true);
  assert.throws(() => admin.operation(f.other.accountId, command.requestId), { status: 403 });
});

test('audit failure rolls back mutation, revision and receipt atomically', async t => {
  const f = await adminFixture(t), org = f.owner.organizationId;
  const before = f.store.admin.organization(f.admin.accountId, org);
  const command = f.command('organization', org, { changes: { name: 'Не должно сохраниться' } });
  f.database.db.exec("CREATE TRIGGER fail_admin_detail BEFORE INSERT ON admin_audit_details BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;");
  try {
    assert.throws(() => f.store.admin.updateProfile(f.admin.accountId, org, command), /synthetic audit failure/);
    assert.equal(f.store.admin.organization(f.admin.accountId, org).name, before.name);
    assert.equal(f.store.admin.organization(f.admin.accountId, org).revision, before.revision);
    assert.equal(f.store.admin.operation(f.admin.accountId, command.requestId).result, null);
  } finally { f.database.db.exec('DROP TRIGGER fail_admin_detail'); }
});

test('separate platform connections reject competing stale writes and preserve durable receipts', async t => {
  const f = await adminFixture(t), second = createPlatformStore(f.platformDirectory);
  f.cleanup(() => second.close());
  const org = f.owner.organizationId, command = f.command('organization', org, { changes: { city: 'Омск' } });
  const competitor = { ...command, requestId: f.database.id(), changes: { city: 'Пермь' } };
  const result = f.store.admin.updateProfile(f.admin.accountId, org, command);
  assert.throws(() => second.admin.updateProfile(f.admin.accountId, org, competitor), { status: 409 });
  assert.deepEqual(second.admin.updateProfile(f.admin.accountId, org, command), result);
  assert.equal(second.admin.organizations(f.admin.accountId, { q: 'Омск' }).items[0].id, org);
});

test('audit decrypts only new administrative details and searches targets without returning legacy arbitrary payload', async t => {
  const f = await adminFixture(t), org = f.owner.organizationId;
  f.database.audit('legacy_synthetic', f.owner.accountId, org, { token: 'PRIVATE LEGACY TOKEN', notes: 'CLINICAL SECRET' });
  const command = f.command('account', f.owner.accountId, { status: 'suspended', reason: 'Проверка причины' });
  f.store.admin.updateAccountAccess(f.admin.accountId, f.owner.accountId, command);
  const page = f.store.admin.audit(f.admin.accountId, { q: 'Анна' });
  const item = page.items.find(x => x.event === 'account_access_admin_updated');
  assert.equal(item.targetId, f.owner.accountId);
  assert.equal(item.detail.reason, 'Проверка причины');
  assert.equal(item.detail.before.status, 'active');
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE LEGACY|CLINICAL SECRET/);
  const raw = f.database.db.prepare('SELECT detail FROM platform_audit WHERE event=?').get('account_access_admin_updated').detail;
  assert.doesNotMatch(raw, /Проверка причины|Анна|admin.test/);
});

test('quota usage reads counters without opening tenant values, keys or new tenant files', async t => {
  const f = await adminFixture(t), org = f.owner.organizationId;
  assert.deepEqual(organizationUsage(f.directory, f.store.organization(org)), { available: true, patients: 0, photos: 0, initialized: false });
  const directory = path.join(f.directory, 'tenants', org), storage = createStorage(directory);
  storage.write({ revision: 0, services: [], patients: [{ id: 'synthetic-p', name: 'ONLY SYNTHETIC', visits: [], appointments: [] }] });
  storage.close();
  fs.renameSync(path.join(directory, 'encryption.key'), path.join(directory, 'unavailable.key'));
  assert.equal(organizationUsage(f.directory, f.store.organization(org)).patients, 1);
  assert.equal(fs.existsSync(path.join(directory, 'encryption.key')), false);
  assert.equal(organizationUsage(f.directory, { id: '../escape' }).available, false);
});
