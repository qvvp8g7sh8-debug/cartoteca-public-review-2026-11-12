const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPlatformStore } = require('../platform-store.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { PRIVACY_VERSION } = require('../src/shared/privacy-consent.cjs');

const originalPassword = 'Original-synthetic-invitation-password';
const replacementPassword = 'Replacement-synthetic-invitation-password';
const email = 'unfinished@invitation.test';
const grant = { privacyConsent: true, privacyConsentVersion: PRIVACY_VERSION };

async function fixture(t, { existing = true, sameName = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-first-invitation-'));
  const platformDir = path.join(dir, 'platform');
  const platform = createPlatformStore(platformDir);
  const owner = await platform.registerOwner({ email: 'owner@invitation.test', password: originalPassword,
    displayName: 'Synthetic owner', organizationName: 'Inviting organization' });
  platform.verifyEmail(owner.verificationToken);
  const recipient = existing ? await platform.registerOwner({ email, password: originalPassword,
    displayName: sameName ? 'Synthetic owner' : 'Unfinished recipient', organizationName: 'Original organization' }) : null;
  const invitation = platform.prepareEmailInvitation({ organizationId: owner.organizationId,
    actorId: owner.accountId, role: 'salon_admin', email });
  platform.finishEmailInvitation({ organizationId: owner.organizationId, actorId: owner.accountId,
    invitationId: invitation.id, token: invitation.token }, true);
  const server = createMultiServer({ dataDir: dir, telegramBot: null, supportBot: null,
    telegramAutostart: false, supportAutostart: false, sendMail: async () => {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function post(route, body) {
    const response = await fetch(base + route, { method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json', 'X-Cartoteca-Request': '1' },
      body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  function raw(callback) {
    const database = createPlatformDatabase(platformDir);
    try { return callback(database); } finally { database.db.close(); }
  }
  const form = { token: invitation.token, email, password: replacementPassword,
    passwordConfirmation: replacementPassword, displayName: 'Completed recipient', ...grant };
  const info = () => post('/api/auth/invitations/info', { token: invitation.token });
  const accept = (overrides = {}) => post('/api/auth/invitations/accept', { ...form, ...overrides });
  const direct = (overrides = {}) => platform.acceptEmailInvitation({ ...form, ...overrides });
  const account = () => raw(({ db, open }) => {
    const row = db.prepare('SELECT * FROM accounts WHERE id=?').get(recipient.accountId);
    return { ...row, value: open(row.value) };
  });
  function alterAccount(change) {
    raw(({ db, open, seal }) => {
      const row = db.prepare('SELECT value FROM accounts WHERE id=?').get(recipient.accountId);
      db.prepare('UPDATE accounts SET value=? WHERE id=?').run(seal(change(open(row.value))), recipient.accountId);
    });
  }
  // Wrong current passwords may record anonymous failures/budgets, but must not
  // change identity, membership, recovery material or acceptance audit entries.
  const snapshot = () => raw(({ db }) => JSON.stringify(Object.fromEntries([
    'accounts', 'organizations', 'memberships', 'subscriptions', 'invitations', 'email_invitations',
    'password_resets', 'email_verifications', 'platform_sessions', 'platform_audit',
  ].map(table => [table, db.prepare('SELECT * FROM ' + table +
    (table === 'platform_audit' ? " WHERE event<>'login_failed'" : '') + ' ORDER BY 1').all()]))));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve)); platform.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('cartoteca-first-invitation-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { platform, owner, recipient, invitation, info, accept, direct, post, raw, account,
    alterAccount, snapshot, form };
}

function ownerState(f) {
  return f.raw(({ db }) => JSON.stringify({
    account: db.prepare('SELECT * FROM accounts WHERE id=?').get(f.owner.accountId),
    organization: db.prepare('SELECT * FROM organizations WHERE id=?').get(f.owner.organizationId),
    memberships: db.prepare('SELECT * FROM memberships WHERE account_id=? ORDER BY organization_id').all(f.owner.accountId),
    subscription: db.prepare('SELECT * FROM subscriptions WHERE organization_id=?').get(f.owner.organizationId),
  }));
}

for (const existing of [false, true]) test('first invitation requires matching confirmation and consent: existing=' + existing, async t => {
  const f = await fixture(t, { existing }), before = f.snapshot();
  const info = await f.info();
  assert.equal(info.status, 200); assert.equal(info.data.existingAccount, existing);
  assert.equal(info.data.passwordSetupRequired, true);
  assert.doesNotMatch(JSON.stringify(info.data), /passwordHash|salt|verificationToken|accountId/);
  for (const overrides of [
    { passwordConfirmation: undefined }, { passwordConfirmation: 'Another-synthetic-password' },
    { privacyConsent: false }, { privacyConsentVersion: undefined },
  ]) {
    const response = await f.accept(overrides);
    assert.ok([400, 409].includes(response.status)); assert.equal(f.snapshot(), before);
  }
  assert.equal((await f.accept()).status, 200);
});

for (const existing of [false, true]) test('first-password setup requires a fresh name and never uses the same-name inviter identity: existing=' + existing, async t => {
  const f = await fixture(t, { existing, sameName: true });
  const otherInvite = f.platform.prepareEmailInvitation({ organizationId: f.owner.organizationId,
    actorId: f.owner.accountId, role: 'cosmetologist', email: 'other-recipient@invitation.test' });
  f.platform.finishEmailInvitation({ organizationId: f.owner.organizationId, actorId: f.owner.accountId,
    invitationId: otherInvite.id, token: otherInvite.token }, true);
  if (existing) {
    assert.equal(f.account().value.displayName, 'Synthetic owner');
    assert.notEqual(f.recipient.accountId, f.owner.accountId);
  }
  const ownerBefore = ownerState(f), before = f.snapshot(), info = await f.info();
  assert.equal(info.status, 200); assert.equal(info.data.existingAccount, existing);
  assert.equal(info.data.passwordSetupRequired, true); assert.equal(info.data.displayName, '');
  for (const displayName of [undefined, '', '   ']) {
    assert.equal((await f.accept({ displayName })).status, 400);
    assert.equal(f.snapshot(), before); assert.equal(ownerState(f), ownerBefore);
  }
  for (const overrides of [
    { email: 'owner@invitation.test' },
    { token: otherInvite.token },
  ]) {
    assert.equal((await f.accept(overrides)).status, 403);
    assert.equal(f.snapshot(), before); assert.equal(ownerState(f), ownerBefore);
  }
  const accepted = await f.accept({ displayName: 'Fresh invited person', accountId: f.owner.accountId,
    userId: f.owner.accountId, organizationId: f.recipient?.organizationId || 'unrelated-synthetic-organization' });
  assert.equal(accepted.status, 200); assert.notEqual(accepted.data.accountId, f.owner.accountId);
  if (existing) assert.equal(accepted.data.accountId, f.recipient.accountId);
  assert.equal(accepted.data.organizationId, f.owner.organizationId);
  f.raw(({ db, open, emailHash }) => {
    const account = db.prepare('SELECT * FROM accounts WHERE email_hash=?').get(emailHash(email));
    assert.equal(account.id, accepted.data.accountId); assert.equal(open(account.value).email, email);
    assert.equal(open(account.value).displayName, 'Fresh invited person');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM accounts').get().n, 2);
  });
  assert.equal(ownerState(f), ownerBefore);
  assert.deepEqual(f.platform.availableMemberships(accepted.data.accountId).map(member =>
    [member.organizationId, member.role]), [[f.owner.organizationId, 'salon_admin']]);
});

test('an unfinished registration keeps its identity and retires its unused owner cabinet atomically', async t => {
  const f = await fixture(t), originalMemberships = f.platform.memberships(f.recipient.accountId);
  const originalOrganization = f.platform.organization(f.recipient.organizationId);
  const reset = f.platform.requestPasswordReset(email), old = f.account();
  const response = await f.accept(); assert.equal(response.status, 200);
  assert.equal(response.data.accountId, f.recipient.accountId);
  assert.equal(response.data.organizationId, f.owner.organizationId); assert.equal(response.data.role, 'salon_admin');
  const current = f.account(); assert.equal(current.created_at, old.created_at);
  assert.equal(current.value.emailVerified, true); assert.equal(current.value.displayName, 'Completed recipient');
  assert.equal(current.value.privacyConsent.version, PRIVACY_VERSION);
  assert.equal(current.value.privacyConsent.purpose, 'registration');
  assert.notEqual(current.value.passwordHash, old.value.passwordHash);
  assert.deepEqual(f.platform.organization(f.recipient.organizationId), { ...originalOrganization, status: 'suspended' });
  const memberships = f.platform.memberships(f.recipient.accountId);
  assert.equal(memberships.length, 2);
  assert.deepEqual(memberships.find(m => m.organizationId === f.recipient.organizationId),
    { ...originalMemberships[0], status: 'suspended' });
  assert.equal(memberships.find(m => m.organizationId === f.owner.organizationId).role, 'salon_admin');
  assert.equal(memberships.find(m => m.organizationId === f.owner.organizationId).status, 'active');
  f.raw(({ db }) => {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM accounts').get().n, 2);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM organizations').get().n, 2);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM memberships m JOIN organizations o ON o.id=m.organization_id WHERE m.account_id=? AND m.status='active' AND o.status='active'").get(f.recipient.accountId).n, 1);
    const retired = db.prepare("SELECT organization_id,detail FROM platform_audit WHERE actor_id=? AND event='invitation_unfinished_organization_retired'").all(f.recipient.accountId);
    assert.equal(retired.length, 1); assert.equal(retired[0].organization_id, f.recipient.organizationId);
    assert.equal(JSON.parse(retired[0].detail).invitedOrganizationId, f.owner.organizationId);
    for (const table of ['email_verifications', 'password_resets'])
      assert.equal(db.prepare('SELECT COUNT(*) n FROM ' + table + ' WHERE account_id=? AND used_at IS NULL').get(f.recipient.accountId).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM platform_sessions WHERE account_id=?').get(f.recipient.accountId).n, 0);
    const audit = db.prepare('SELECT event,detail FROM platform_audit WHERE actor_id=? AND organization_id=? ORDER BY id').all(f.recipient.accountId, f.owner.organizationId);
    assert.deepEqual(audit.map(row => row.event), ['invitation_password_created', 'invitation_accepted']);
    assert.equal(JSON.parse(audit[0].detail).registrationCompleted, true);
    assert.doesNotMatch(JSON.stringify(audit), /passwordHash|salt|Replacement-synthetic|Original-synthetic/);
  });
  assert.throws(() => f.platform.verifyEmail(f.recipient.verificationToken), { status: 400 });
  await assert.rejects(f.platform.resetPassword(reset, originalPassword), { status: 400 });
  assert.equal((await f.accept()).status, 400);
  await assert.rejects(f.platform.login(email, originalPassword), { status: 401 });
  const logged = await f.platform.login(email, replacementPassword);
  assert.equal(logged.account.id, f.recipient.accountId);
  assert.equal(f.platform.session(logged.token).organizationId, f.owner.organizationId);
  assert.equal(f.platform.session(logged.token).role, 'salon_admin');
});

test('password, retired cabinet and owner link, acceptance and audit roll back together if final audit cannot commit', async t => {
  const f = await fixture(t), before = f.snapshot();
  f.raw(({ db }) => db.exec("CREATE TRIGGER synthetic_acceptance_failure BEFORE INSERT ON platform_audit WHEN NEW.event='invitation_accepted' BEGIN SELECT RAISE(ABORT,'Synthetic audit failure'); END"));
  await assert.rejects(f.direct(), /Synthetic audit failure/);
  assert.equal(f.snapshot(), before);
  assert.equal(f.platform.organization(f.recipient.organizationId).status, 'active');
  assert.equal(f.platform.memberships(f.recipient.accountId)[0].status, 'active');
});

const retainedPasswordCases = {
  'verified account': f => f.platform.verifyEmail(f.recipient.verificationToken),
  'recorded verification despite a false flag': f => f.raw(({ db }) => db.prepare("INSERT INTO platform_audit(time,actor_id,organization_id,event,detail) VALUES(?,?,?,'email_verified','{}')").run(Date.now(), f.recipient.accountId, f.recipient.organizationId)),
  'previous login': f => f.raw(({ db }) => db.prepare("INSERT INTO platform_audit(time,actor_id,organization_id,event,detail) VALUES(?,?,?,'login_succeeded','{}')").run(Date.now(), f.recipient.accountId, f.recipient.organizationId)),
  'previous accepted invitation': f => f.raw(({ db }) => db.prepare("INSERT INTO platform_audit(time,actor_id,organization_id,event,detail) VALUES(?,?,?,'invitation_accepted','{}')").run(Date.now(), f.recipient.accountId, f.recipient.organizationId)),
  'legacy account': f => f.raw(({ db }) => db.prepare("UPDATE platform_audit SET event='legacy_owner_imported' WHERE actor_id=? AND event='owner_registered'").run(f.recipient.accountId)),
  'global administrator': f => f.raw(({ db }) => db.prepare('UPDATE accounts SET global_admin=1 WHERE id=?').run(f.recipient.accountId)),
  'suspended account': f => f.raw(({ db }) => db.prepare("UPDATE accounts SET status='suspended' WHERE id=?").run(f.recipient.accountId)),
  'missing registration provenance': f => f.raw(({ db }) => db.prepare("DELETE FROM platform_audit WHERE actor_id=? AND event='owner_registered'").run(f.recipient.accountId)),
  'duplicate registration provenance': f => f.raw(({ db }) => db.prepare("INSERT INTO platform_audit(time,actor_id,organization_id,event,detail) VALUES(?,?,?,'owner_registered','{}')").run(Date.now(), f.recipient.accountId, f.recipient.organizationId)),
  'different membership creation time': f => f.raw(({ db }) => db.prepare('UPDATE memberships SET created_at=created_at+1 WHERE account_id=?').run(f.recipient.accountId)),
  'different organization creation time': f => f.raw(({ db }) => db.prepare('UPDATE organizations SET created_at=created_at+1 WHERE id=?').run(f.recipient.organizationId)),
  'suspended original membership': f => f.raw(({ db }) => db.prepare("UPDATE memberships SET status='suspended' WHERE account_id=?").run(f.recipient.accountId)),
  'inactive original organization': f => f.raw(({ db }) => db.prepare("UPDATE organizations SET status='suspended' WHERE id=?").run(f.recipient.organizationId)),
  'unproven email identity': f => f.alterAccount(value => ({ ...value, email: 'different@invitation.test' })),
  'unknown verification state': f => f.alterAccount(value => { const rest = { ...value }; delete rest.emailVerified; return rest; }),
  'multiple memberships': f => f.raw(({ db }) => db.prepare("INSERT INTO memberships(organization_id,account_id,role,created_at) VALUES(?,?,'cosmetologist',?)").run(f.owner.organizationId, f.recipient.accountId, Date.now())),
  'a stored session even without login audit': f => f.raw(({ db, seal }) => db.prepare('INSERT INTO platform_sessions(token_hash,id,account_id,organization_id,value,expires_at) VALUES(?,?,?,?,?,?)').run('synthetic-session-hash', 'synthetic-session-id', f.recipient.accountId, f.recipient.organizationId, seal({ createdAt: Date.now() }), Date.now() + 60000)),
};
for (const [name, change] of Object.entries(retainedPasswordCases)) test('first-password setup never replaces the password of ' + name, async t => {
  const f = await fixture(t); change(f);
  const noActiveOrganization = ['suspended original membership', 'inactive original organization'].includes(name);
  const info = await f.info(); assert.equal(info.status, noActiveOrganization ? 200 : 409);
  if (noActiveOrganization) {
    assert.equal(info.data.existingAccount, true); assert.equal(info.data.passwordSetupRequired, false);
  } else assert.match(info.data.error, /другой.*почт/i);
  const before = f.snapshot(); assert.equal((await f.accept()).status, noActiveOrganization ? 401 : 409);
  assert.equal(f.snapshot(), before);
});

test('an established recipient cannot add a second active organization even with the correct password', async t => {
  const f = await fixture(t); f.platform.verifyEmail(f.recipient.verificationToken);
  const before = f.snapshot();
  const accepted = await f.accept({ password: originalPassword, passwordConfirmation: undefined,
    privacyConsent: undefined, privacyConsentVersion: undefined, displayName: 'Do not replace' });
  assert.equal(accepted.status, 409); assert.match(accepted.data.error, /другой.*почт/i);
  assert.equal(f.snapshot(), before); assert.equal(f.platform.memberships(f.recipient.accountId).length, 1);
  assert.equal((await f.platform.login(email, originalPassword)).account.id, f.recipient.accountId);
  await assert.rejects(f.platform.login(email, replacementPassword), { status: 401 });
});

for (const displayName of [undefined, 'Do not replace']) test('an established same-name recipient joins without trusting invitation name: supplied=' + (displayName === undefined ? 'missing' : 'other name'), async t => {
  const f = await fixture(t, { sameName: true }); f.platform.verifyEmail(f.recipient.verificationToken);
  f.raw(({ db }) => db.prepare("UPDATE organizations SET status='suspended' WHERE id=?").run(f.recipient.organizationId));
  const before = f.account(), originalMember = f.platform.memberships(f.recipient.accountId)[0], ownerBefore = ownerState(f);
  const info = await f.info(); assert.equal(info.status, 200); assert.equal(info.data.passwordSetupRequired, false);
  assert.equal(info.data.displayName, 'Synthetic owner');
  const accepted = await f.accept({ password: originalPassword, passwordConfirmation: undefined,
    privacyConsent: undefined, privacyConsentVersion: undefined, displayName, accountId: f.owner.accountId });
  assert.equal(accepted.status, 200); assert.deepEqual(f.account(), before);
  assert.equal(accepted.data.accountId, f.recipient.accountId); assert.notEqual(accepted.data.accountId, f.owner.accountId);
  assert.equal(ownerState(f), ownerBefore);
  assert.deepEqual(f.platform.memberships(f.recipient.accountId).find(member => member.organizationId === f.recipient.organizationId), originalMember);
  assert.equal(f.platform.organization(f.recipient.organizationId).status, 'suspended');
  f.raw(({ db }) => assert.equal(db.prepare("SELECT COUNT(*) n FROM memberships m JOIN organizations o ON o.id=m.organization_id WHERE m.account_id=? AND m.status='active' AND o.status='active'").get(f.recipient.accountId).n, 1));
  const logged = await f.platform.login(email, originalPassword);
  assert.equal(f.platform.session(logged.token).organizationId, f.owner.organizationId);
});

test('a recipient name changing during password work cannot be overwritten by a stale setup form', async t => {
  const f = await fixture(t, { sameName: true }), ownerBefore = ownerState(f);
  const accepting = f.direct({ displayName: 'Stale entered name' });
  f.alterAccount(value => ({ ...value, displayName: 'Updated recipient name' }));
  const afterChange = f.snapshot();
  await assert.rejects(accepting, { status: 409 });
  assert.equal(f.snapshot(), afterChange); assert.equal(ownerState(f), ownerBefore);
  assert.equal(f.account().value.displayName, 'Updated recipient name');
});

test('an unverified account with prior use cannot bypass the one-organization rule', async t => {
  const f = await fixture(t); retainedPasswordCases['previous login'](f);
  const before = f.snapshot();
  const accepted = await f.accept({ password: originalPassword, passwordConfirmation: undefined,
    privacyConsent: undefined, privacyConsentVersion: undefined, displayName: 'Do not replace' });
  assert.equal(accepted.status, 409);
  assert.equal(f.snapshot(), before); assert.equal(f.account().value.emailVerified, false);
  assert.equal(f.platform.memberships(f.recipient.accountId).length, 1);
});

const forbiddenInvitationCases = {
  revoked: f => f.platform.revokeEmailInvitation({ organizationId: f.owner.organizationId, actorId: f.owner.accountId, invitationId: f.invitation.id }),
  expired: f => f.raw(({ db }) => db.prepare('UPDATE invitations SET expires_at=?').run(Date.now() - 1)),
  undelivered: f => f.raw(({ db }) => db.prepare("UPDATE email_invitations SET status='pending',sent_at=NULL WHERE id=?").run(f.invitation.id)),
  'inviter without access': f => f.raw(({ db }) => db.prepare("UPDATE memberships SET status='suspended' WHERE organization_id=? AND account_id=?").run(f.owner.organizationId, f.owner.accountId)),
  'inactive inviting organization': f => f.raw(({ db }) => db.prepare("UPDATE organizations SET status='suspended' WHERE id=?").run(f.owner.organizationId)),
};
for (const [name, change] of Object.entries(forbiddenInvitationCases)) test('a ' + name + ' invitation cannot initialize a password', async t => {
  const f = await fixture(t); change(f); const before = f.snapshot();
  assert.ok([400, 403].includes((await f.info()).status));
  assert.ok([400, 403].includes((await f.accept()).status)); assert.equal(f.snapshot(), before);
});

test('a delivered invitation is bound to its recipient address and internal provisioning cannot override unfinished passwords', async t => {
  const f = await fixture(t), before = f.snapshot();
  assert.equal((await f.accept({ email: 'wrong@invitation.test' })).status, 403);
  assert.equal(f.snapshot(), before);
  const manual = f.platform.createInvitation({ organizationId: f.owner.organizationId,
    invitedBy: f.owner.accountId, role: 'cosmetologist', email });
  const pending = f.account();
  await assert.rejects(f.platform.acceptInvitation({ ...f.form, token: manual.token }), { status: 409 });
  assert.deepEqual(f.account(), pending); assert.equal(f.platform.memberships(f.recipient.accountId).length, 1);
});

test('unfinished registration becoming established during password work requires a retry', async t => {
  const f = await fixture(t);
  const accepting = f.direct();
  f.alterAccount(value => ({ ...value, emailVerified: true }));
  const afterChange = f.snapshot();
  await assert.rejects(accepting, { status: 409 }); assert.equal(f.snapshot(), afterChange);
});

test('a new active organization link appearing during hashing cannot retire the original cabinet or accept the invitation', async t => {
  const f = await fixture(t);
  const third = await f.platform.registerOwner({ email: 'third@invitation.test', password: originalPassword,
    displayName: 'Third synthetic owner', organizationName: 'Third synthetic organization' });
  const accepting = f.direct();
  f.raw(({ db }) => db.prepare("INSERT INTO memberships(organization_id,account_id,role,created_at) VALUES(?,?,'cosmetologist',?)")
    .run(third.organizationId, f.recipient.accountId, Date.now()));
  const afterChange = f.snapshot();
  await assert.rejects(accepting, { status: 409 }); assert.equal(f.snapshot(), afterChange);
  assert.equal(f.platform.organization(f.recipient.organizationId).status, 'active');
  assert.equal(f.account().value.emailVerified, false);
});

for (const activity of ['another member', 'an outgoing invitation'])
  test('an original cabinet becoming used during hashing cannot be retired: ' + activity, async t => {
    const f = await fixture(t), accepting = f.direct();
    if (activity === 'another member')
      f.raw(({ db }) => db.prepare("INSERT INTO memberships(organization_id,account_id,role,created_at) VALUES(?,?,'cosmetologist',?)")
        .run(f.recipient.organizationId, f.owner.accountId, Date.now()));
    else f.platform.createInvitation({ organizationId: f.recipient.organizationId,
      invitedBy: f.recipient.accountId, role: 'cosmetologist', email: 'outgoing@invitation.test' });
    const afterChange = f.snapshot();
    await assert.rejects(accepting, { status: 409 }); assert.equal(f.snapshot(), afterChange);
    assert.equal(f.platform.organization(f.recipient.organizationId).status, 'active');
    assert.equal(f.platform.memberships(f.recipient.accountId)[0].status, 'active');
    assert.equal(f.account().value.emailVerified, false);
  });

test('a session appearing during hashing cannot become a silently revoked established session', async t => {
  const f = await fixture(t), accepting = f.direct();
  retainedPasswordCases['a stored session even without login audit'](f); const afterChange = f.snapshot();
  await assert.rejects(accepting, { status: 409 }); assert.equal(f.snapshot(), afterChange);
});

for (const name of ['missing registration provenance', 'suspended original membership', 'global administrator'])
  test('eligibility lost during hashing cannot complete first-password setup: ' + name, async t => {
    const f = await fixture(t), accepting = f.direct();
    retainedPasswordCases[name](f); const afterChange = f.snapshot();
    await assert.rejects(accepting, { status: 409 }); assert.equal(f.snapshot(), afterChange);
  });

for (const name of ['revoked', 'expired', 'inviter without access', 'inactive inviting organization'])
  test('invitation restrictions are rechecked after hashing: ' + name, async t => {
    const f = await fixture(t), accepting = f.direct();
    forbiddenInvitationCases[name](f); const afterChange = f.snapshot();
    await assert.rejects(accepting, { status: ['revoked', 'expired'].includes(name) ? 400 : 403 });
    assert.equal(f.snapshot(), afterChange);
  });

test('a delivery address changing during hashing cannot rebind the invitation to another mailbox', async t => {
  const f = await fixture(t), accepting = f.direct();
  f.raw(({ db, seal }) => db.prepare('UPDATE email_invitations SET value=? WHERE id=?')
    .run(seal({ email: 'different-delivery@invitation.test' }), f.invitation.id));
  const afterChange = f.snapshot();
  await assert.rejects(accepting, { status: 403 });
  assert.equal(f.snapshot(), afterChange);
  assert.equal(f.account().value.emailVerified, false);
  assert.equal(f.platform.memberships(f.recipient.accountId).length, 1);
});

test('an account email index changing during hashing cannot create a replacement identity', async t => {
  const f = await fixture(t), accepting = f.direct();
  f.raw(({ db, emailHash }) => db.prepare('UPDATE accounts SET email_hash=? WHERE id=?')
    .run(emailHash('changed-index@invitation.test'), f.recipient.accountId));
  const afterChange = f.snapshot();
  await assert.rejects(accepting, { status: 409 });
  assert.equal(f.snapshot(), afterChange);
  assert.equal(f.account().value.emailVerified, false);
  assert.equal(f.platform.memberships(f.recipient.accountId).length, 1);
});

test('an inviter demoted during hashing cannot finish granting another administrator access', async t => {
  const f = await fixture(t), accepting = f.direct();
  f.raw(({ db }) => db.prepare("UPDATE memberships SET role='salon_admin' WHERE organization_id=? AND account_id=?")
    .run(f.owner.organizationId, f.owner.accountId));
  const afterChange = f.snapshot();
  await assert.rejects(accepting, { status: 403 });
  assert.equal(f.snapshot(), afterChange);
  assert.equal(f.account().value.emailVerified, false);
  assert.equal(f.platform.memberships(f.recipient.accountId).length, 1);
});
