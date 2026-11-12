const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPlatformStore } = require('../platform-store.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { deliverInvitation } = require('../src/server/modules/organizations/invitation-delivery.cjs');
const { pruneRevokedInvitations } = require('../src/server/modules/organizations/invitation-revocation.cjs');

const password = 'Synthetic-revocation-password-2026';
const email = 'recipient@revocation.test';
const identityTables = ['accounts', 'organizations', 'memberships', 'subscriptions',
  'password_resets', 'email_verifications', 'platform_sessions'];

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-invitation-revocation-'));
  const platformDir = path.join(dir, 'platform'), platform = createPlatformStore(platformDir);
  t.after(() => {
    platform.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('cartoteca-invitation-revocation-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const owner = await platform.registerOwner({ email: 'owner@revocation.test', password,
    displayName: 'Synthetic owner', organizationName: 'Synthetic organization' });
  platform.verifyEmail(owner.verificationToken);
  function raw(callback) {
    const database = createPlatformDatabase(platformDir);
    try { return callback(database); } finally { database.db.close(); }
  }
  const scope = { organizationId: owner.organizationId, actorId: owner.accountId };
  function prepare(overrides = {}) {
    return platform.prepareEmailInvitation({ ...scope, email, role: 'cosmetologist', ...overrides });
  }
  function finish(invitation, delivered = true, overrides = {}) {
    return platform.finishEmailInvitation({ ...scope, invitationId: invitation.id,
      token: invitation.token, ...overrides }, delivered);
  }
  function revoke(invitation, overrides = {}) {
    return platform.revokeEmailInvitation({ ...scope, invitationId: invitation.id, ...overrides });
  }
  const list = () => platform.emailInvitations(owner.organizationId, owner.accountId);
  const identities = () => raw(({ db }) => JSON.stringify(Object.fromEntries(identityTables
    .map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY 1').all()]))));
  function assertGone(invitation) {
    raw(({ db, tokenHash }) => {
      assert.equal(db.prepare('SELECT 1 FROM invitations WHERE token_hash=?').get(tokenHash(invitation.token)), undefined);
      assert.equal(db.prepare('SELECT 1 FROM email_invitations WHERE id=?').get(invitation.id), undefined);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    });
  }
  function revokedAudit(invitation, actorId = owner.accountId) {
    const rows = raw(({ db }) => db.prepare("SELECT actor_id,organization_id,detail FROM platform_audit WHERE event='invitation_revoked'").all());
    assert.ok(rows.some(row => row.actor_id === actorId && row.organization_id === owner.organizationId &&
      JSON.parse(row.detail).invitationId === invitation.id));
    assert.ok(!JSON.stringify(rows).includes(email));
    assert.ok(!JSON.stringify(rows).includes(invitation.token));
  }
  async function assertInvalid(invitation) {
    assert.throws(() => platform.emailInvitationInfo(invitation.token), { status: 400 });
    await assert.rejects(platform.acceptEmailInvitation({ token: invitation.token, email, password,
      passwordConfirmation: password, displayName: 'Synthetic recipient' }), { status: 400 });
  }
  const expireMinute = () => raw(({ db }) => db.prepare("UPDATE login_limits SET blocked_until=? WHERE key LIKE 'public:invitation:email-pause:%'").run(Date.now() - 1));
  const budgets = () => raw(({ db }) => db.prepare("SELECT * FROM login_limits WHERE key LIKE 'public:invitation:%' ORDER BY key").all());
  return { platform, owner, scope, raw, prepare, finish, revoke, list, identities,
    assertGone, revokedAudit, assertInvalid, expireMinute, budgets };
}

for (const status of ['pending', 'sent', 'failed', 'expired'])
  test('revoking an unaccepted ' + status + ' invitation removes both records and its visible row', async t => {
    const f = await fixture(t), before = f.identities(), invitation = f.prepare();
    if (status !== 'pending') f.finish(invitation, status !== 'failed');
    if (status === 'expired') f.raw(({ db, tokenHash }) => db.prepare('UPDATE invitations SET expires_at=? WHERE token_hash=?')
      .run(Date.now() - 1, tokenHash(invitation.token)));
    assert.equal(f.list()[0].status, status);
    f.revoke(invitation);
    f.assertGone(invitation); assert.deepEqual(f.list(), []);
    assert.equal(f.identities(), before); f.revokedAudit(invitation);
    await f.assertInvalid(invitation);
    assert.equal(f.identities(), before);
  });

test('revocation preserves a pre-existing unfinished account, original organization and password material', async t => {
  const f = await fixture(t);
  const recipient = await f.platform.registerOwner({ email, password,
    displayName: 'Existing unfinished recipient', organizationName: 'Original unfinished organization' });
  const invitation = f.prepare(); f.finish(invitation);
  const before = f.identities(); f.revoke(invitation);
  f.assertGone(invitation); await f.assertInvalid(invitation);
  assert.equal(f.identities(), before);
  assert.equal(f.platform.memberships(recipient.accountId).length, 1);
  assert.equal(f.platform.memberships(recipient.accountId)[0].organizationId, recipient.organizationId);
});

test('a new issuance after revocation has a new link but retains minute and hourly mail budgets', async t => {
  const f = await fixture(t), first = f.prepare(); f.finish(first);
  const before = f.budgets(); f.revoke(first);
  assert.deepEqual(f.budgets(), before);
  assert.throws(() => f.prepare(), { status: 429 });
  f.expireMinute(); const second = f.prepare();
  assert.notEqual(second.id, first.id); assert.notEqual(second.token, first.token);
  f.finish(second); f.revoke(second); f.expireMinute();
  const third = f.prepare(); f.finish(third); f.revoke(third); f.expireMinute();
  assert.throws(() => f.prepare(), { status: 429 });
  assert.deepEqual(f.list(), []);
  for (const invitation of [first, second, third]) await f.assertInvalid(invitation);
});

test('an accepted invitation cannot remove a member or account through revocation', async t => {
  const f = await fixture(t), invitation = f.prepare(); f.finish(invitation);
  await f.platform.acceptEmailInvitation({ token: invitation.token, email, password,
    passwordConfirmation: password, displayName: 'Accepted synthetic recipient' });
  const before = f.identities();
  assert.throws(() => f.revoke(invitation), { status: 409 });
  assert.equal(f.identities(), before); assert.equal(f.list()[0].status, 'accepted');
});

test('revocation is restricted to the invitation organization and permitted role', async t => {
  const f = await fixture(t), provision = async (address, role) => {
    const invitation = f.platform.createInvitation({ organizationId: f.owner.organizationId,
      invitedBy: f.owner.accountId, role });
    return f.platform.acceptInvitation({ token: invitation.token, email: address, password,
      displayName: 'Synthetic member' });
  };
  const admin = await provision('admin@revocation.test', 'salon_admin');
  const staff = await provision('staff@revocation.test', 'cosmetologist');
  const other = await f.platform.registerOwner({ email: 'other@revocation.test', password,
    displayName: 'Other owner', organizationName: 'Other organization' });
  const invitation = f.prepare({ role: 'salon_admin' }), before = f.identities();
  assert.throws(() => f.revoke(invitation, { organizationId: other.organizationId, actorId: other.accountId }), { status: 404 });
  assert.throws(() => f.revoke(invitation, { actorId: admin.accountId }), { status: 403 });
  assert.throws(() => f.revoke(invitation, { actorId: staff.accountId }), { status: 403 });
  assert.equal(f.identities(), before); assert.equal(f.list().length, 1);
  const staffInvitation = f.prepare({ email: 'next@revocation.test', actorId: admin.accountId });
  f.revoke(staffInvitation, { actorId: admin.accountId }); f.assertGone(staffInvitation);
  f.revoke(invitation); f.assertGone(invitation);
});

test('revocation during SMTP delivery cannot restore the deleted invitation', async t => {
  const f = await fixture(t); let invitation, release;
  const sent = new Promise(resolve => { release = resolve; });
  const sending = deliverInvitation({ platform: f.platform,
    current: { organizationId: f.owner.organizationId, accountId: f.owner.accountId },
    assertMailAvailable() {}, assertCurrent() {},
    sendInvitation(value) { invitation = value; return sent; },
  }, { email, role: 'cosmetologist' });
  assert.ok(invitation); const before = f.identities();
  f.revoke(invitation); release();
  await assert.rejects(sending, { status: 409 });
  f.assertGone(invitation); assert.deepEqual(f.list(), []);
  assert.equal(f.identities(), before); await f.assertInvalid(invitation);
});

test('revocation while a new password is hashing cannot create an account or membership', async t => {
  const f = await fixture(t), invitation = f.prepare(); f.finish(invitation);
  const before = f.identities();
  const accepting = f.platform.acceptEmailInvitation({ token: invitation.token, email, password,
    passwordConfirmation: password, displayName: 'Synthetic recipient' });
  f.revoke(invitation);
  await assert.rejects(accepting, { status: 400 });
  f.assertGone(invitation); assert.equal(f.identities(), before);
});

for (const invalidation of ['suspended inviter', 'inactive organization'])
  test('SMTP completion deletes and audits an invitation invalidated by ' + invalidation, async t => {
    const f = await fixture(t), invitation = f.prepare();
    f.raw(({ db }) => invalidation === 'suspended inviter'
      ? db.prepare("UPDATE memberships SET status='suspended' WHERE organization_id=? AND account_id=?").run(f.owner.organizationId, f.owner.accountId)
      : db.prepare("UPDATE organizations SET status='suspended' WHERE id=?").run(f.owner.organizationId));
    const before = f.identities(), result = f.finish(invitation);
    assert.equal(result.error.status, 403); f.assertGone(invitation);
    f.revokedAudit(invitation); assert.equal(f.identities(), before);
    assert.throws(() => f.finish(invitation), { status: 409 });
    await f.assertInvalid(invitation);
  });

test('cleanup deletes only legacy revoked unaccepted records inside the exact requested organization', async t => {
  const f = await fixture(t), other = await f.platform.registerOwner({ email: 'cleanup-other@revocation.test',
    password, displayName: 'Other cleanup owner', organizationName: 'Other cleanup organization' });
  const revoked = f.prepare(), pending = f.prepare({ email: 'pending@revocation.test' });
  const accepted = f.prepare({ email: 'accepted@revocation.test' }); f.finish(accepted);
  await f.platform.acceptEmailInvitation({ token: accepted.token, email: 'accepted@revocation.test',
    password, passwordConfirmation: password, displayName: 'Accepted cleanup recipient' });
  const foreign = f.prepare({ organizationId: other.organizationId, actorId: other.accountId,
    email: 'foreign@revocation.test' });
  f.raw(({ db }) => {
    for (const invitation of [revoked, accepted, foreign])
      db.prepare("UPDATE email_invitations SET status='revoked' WHERE id=?").run(invitation.id);
  });
  const before = f.identities();
  const result = f.raw(database => pruneRevokedInvitations(database, { organizationId: f.owner.organizationId }));
  assert.deepEqual(result, { deleted: 1 }); f.assertGone(revoked);
  f.raw(({ db }) => {
    for (const invitation of [pending, accepted, foreign])
      assert.ok(db.prepare('SELECT 1 FROM email_invitations WHERE id=?').get(invitation.id));
    const audit = db.prepare("SELECT actor_id,organization_id,detail FROM platform_audit WHERE event='invitation_revoked_cleanup'").all();
    assert.deepEqual(audit.map(row => ({ ...row })), [{ actor_id: null,
      organization_id: f.owner.organizationId, detail: JSON.stringify({ deleted: 1 }) }]);
  });
  assert.equal(f.identities(), before);
  assert.deepEqual(f.raw(database => pruneRevokedInvitations(database, { organizationId: f.owner.organizationId })), { deleted: 0 });
  assert.equal(f.raw(({ db }) => db.prepare("SELECT COUNT(*) n FROM platform_audit WHERE event='invitation_revoked_cleanup'").get().n), 1);
});

test('cleanup and its audit are atomic when an audit insert fails', async t => {
  const f = await fixture(t), invitation = f.prepare();
  f.raw(({ db }) => {
    db.prepare("UPDATE email_invitations SET status='revoked' WHERE id=?").run(invitation.id);
    db.exec("CREATE TRIGGER synthetic_cleanup_failure BEFORE INSERT ON platform_audit WHEN NEW.event='invitation_revoked_cleanup' BEGIN SELECT RAISE(ABORT,'Synthetic cleanup failure'); END");
  });
  const before = f.raw(({ db }) => JSON.stringify(Object.fromEntries(['invitations', 'email_invitations', 'platform_audit']
    .map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY 1').all()]))));
  assert.throws(() => f.raw(database => pruneRevokedInvitations(database)), /Synthetic cleanup failure/);
  assert.equal(f.raw(({ db }) => JSON.stringify(Object.fromEntries(['invitations', 'email_invitations', 'platform_audit']
    .map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY 1').all()])))), before);
});

test('all-organization cleanup preserves a mismatched mail-row scope and mail budgets', async t => {
  const f = await fixture(t), other = await f.platform.registerOwner({ email: 'scope-other@revocation.test',
    password, displayName: 'Other scope owner', organizationName: 'Other scope organization' });
  const own = f.prepare(), foreign = f.prepare({ organizationId: other.organizationId,
    actorId: other.accountId, email: 'scope-foreign@revocation.test' });
  const mismatched = f.prepare({ email: 'scope-mismatch@revocation.test' });
  f.raw(({ db }) => {
    db.prepare("UPDATE email_invitations SET status='revoked'").run();
    db.prepare('UPDATE email_invitations SET organization_id=? WHERE id=?').run(other.organizationId, mismatched.id);
  });
  const before = f.budgets(), identity = f.identities();
  assert.deepEqual(f.raw(database => pruneRevokedInvitations(database)), { deleted: 2 });
  f.assertGone(own); f.assertGone(foreign);
  f.raw(({ db, tokenHash }) => {
    assert.ok(db.prepare('SELECT 1 FROM invitations WHERE token_hash=?').get(tokenHash(mismatched.token)));
    assert.ok(db.prepare('SELECT 1 FROM email_invitations WHERE id=?').get(mismatched.id));
    const row = db.prepare("SELECT actor_id,organization_id,detail FROM platform_audit WHERE event='invitation_revoked_cleanup'").get();
    assert.equal(row.actor_id, null); assert.equal(row.organization_id, null);
    assert.deepEqual(JSON.parse(row.detail), { deleted: 2 });
  });
  assert.equal(f.identities(), identity); assert.deepEqual(f.budgets(), before);
});

test('revocation does not partially delete records if its audit cannot be committed', async t => {
  const f = await fixture(t), invitation = f.prepare(); f.finish(invitation);
  f.raw(({ db }) => db.exec("CREATE TRIGGER synthetic_revoke_failure BEFORE INSERT ON platform_audit WHEN NEW.event='invitation_revoked' BEGIN SELECT RAISE(ABORT,'Synthetic revocation failure'); END"));
  const before = f.identities();
  assert.throws(() => f.revoke(invitation), /Synthetic revocation failure/);
  f.raw(({ db, tokenHash }) => {
    assert.ok(db.prepare('SELECT 1 FROM invitations WHERE token_hash=?').get(tokenHash(invitation.token)));
    assert.ok(db.prepare('SELECT 1 FROM email_invitations WHERE id=?').get(invitation.id));
  });
  assert.equal(f.list()[0].status, 'sent'); assert.equal(f.identities(), before);
  assert.equal(f.platform.emailInvitationInfo(invitation.token).email, email);
});
