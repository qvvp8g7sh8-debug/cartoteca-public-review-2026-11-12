const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createPlatformStore } = require('../platform-store.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { PRIVACY_VERSION } = require('../src/shared/privacy-consent.cjs');
const { authContextHeaders } = require('./helpers/account-context.cjs');
const password = 'Synthetic-single-organization-password';

async function fixture(t, { unverifiedRecipient = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-auth-organizations-'));
  const directory = path.join(dir, 'platform');
  const platform = createPlatformStore(directory);
  async function owner(email, organizationName, verified = true) {
    const created = await platform.registerOwner({
      email,
      password,
      displayName: 'Synthetic person ' + email.split('@')[0],
      organizationName,
    });
    if (verified) platform.verifyEmail(created.verificationToken);
    return created;
  }
  const recipient = await owner(
    'recipient@organizations.test',
    'Original organization',
    !unverifiedRecipient,
  );
  const inviter = await owner('inviter@organizations.test', 'Inviting organization');
  const admin = await platform.bootstrapGlobalAdmin({
    email: 'global@organizations.test',
    password,
    displayName: 'Global administrator',
  });
  const server = createMultiServer({
    dataDir: dir,
    sendMail: null,
    telegramBot: null,
    supportBot: null,
    telegramAutostart: false,
    supportAutostart: false,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const contexts = new Map();
  async function request(route, body, cookie = '', expected = contexts.get(cookie)) {
    const response = await fetch(base + route, {
      method: body ? 'POST' : 'GET',
      headers: {
        Origin: base,
        Cookie: cookie,
        'Content-Type': 'application/json',
        'X-Cartoteca-Request': '1',
        ...(route === '/api/auth/session' ? {} : expected),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json(),
      issued = response.headers.get('set-cookie')?.split(';')[0];
    if (route === '/api/auth/login' && response.ok && issued)
      contexts.set(issued, authContextHeaders(data));
    return {
      status: response.status,
      data,
      cookie: issued,
    };
  }
  const login = () =>
    request('/api/auth/login', { email: 'recipient@organizations.test', password });
  function raw(callback) {
    const database = createPlatformDatabase(directory);
    try {
      return callback(database);
    } finally {
      database.db.close();
    }
  }
  function legacyLink(status = 'active') {
    raw(({ db }) =>
      db
        .prepare(
          'INSERT INTO memberships(organization_id,account_id,role,status,created_at) VALUES(?,?,?,?,?)',
        )
        .run(inviter.organizationId, recipient.accountId, 'salon_admin', status, Date.now()),
    );
  }
  const snapshot = () =>
    raw(({ db }) =>
      JSON.stringify(
        Object.fromEntries(
          [
            'memberships',
            'organizations',
            'platform_sessions',
            'platform_audit',
            'admin_operations',
            'admin_resource_versions',
            'admin_audit_details',
          ].map((table) => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY 1').all()]),
        ),
      ),
    );
  function clearSelected(cookie) {
    raw(({ db, tokenHash }) =>
      db
        .prepare('UPDATE platform_sessions SET organization_id=NULL WHERE token_hash=?')
        .run(tokenHash(cookie.slice(cookie.indexOf('=') + 1))),
    );
  }
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    platform.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('cartoteca-auth-organizations-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    platform,
    recipient,
    inviter,
    admin,
    request,
    login,
    raw,
    legacyLink,
    snapshot,
    clearSelected,
  };
}

test('one available organization is selected automatically without exposing any organization list', async (t) => {
  const f = await fixture(t),
    logged = await f.login();
  assert.equal(logged.status, 200);
  assert.equal(logged.data.organizationId, f.recipient.organizationId);
  assert.deepEqual(
    logged.data.memberships.map((row) => row.organizationId),
    [f.recipient.organizationId],
  );
  const session = await f.request(
    '/api/auth/session?accountId=' + f.inviter.accountId,
    null,
    logged.cookie,
  );
  assert.equal(session.data.user.organizationId, f.recipient.organizationId);
  assert.equal(Object.hasOwn(session.data, 'memberships'), false);
  assert.equal(Object.hasOwn(session.data, 'organizationAccess'), false);
  assert.equal((await f.request('/api/cabinet/bootstrap', null, logged.cookie)).status, 200);
  const before = f.snapshot();
  assert.equal(
    (
      await f.request(
        '/api/auth/select-organization',
        { organizationId: f.inviter.organizationId },
        logged.cookie,
      )
    ).status,
    403,
  );
  assert.equal(f.snapshot(), before);
});

for (const restriction of ['membership', 'organization'])
  test(
    'suspended ' + restriction + ' does not block the only available organization',
    async (t) => {
      const f = await fixture(t);
      f.legacyLink(restriction === 'membership' ? 'suspended' : 'active');
      if (restriction === 'organization')
        f.raw(({ db }) =>
          db
            .prepare("UPDATE organizations SET status='suspended' WHERE id=?")
            .run(f.inviter.organizationId),
        );
      const logged = await f.login();
      assert.equal(logged.status, 200);
      assert.equal(logged.data.organizationId, f.recipient.organizationId);
      assert.equal(f.platform.memberships(f.recipient.accountId).length, 2);
      assert.equal(f.platform.availableMemberships(f.recipient.accountId).length, 1);
    },
  );

test('legacy multiple active organizations reject login and cannot be selected through the old endpoint', async (t) => {
  const f = await fixture(t),
    logged = await f.login();
  f.legacyLink();
  f.clearSelected(logged.cookie);
  const before = f.snapshot();
  const denied = await f.login();
  assert.equal(denied.status, 409);
  assert.match(denied.data.error, /отдельную учётную запись/);
  assert.equal(denied.cookie, undefined);
  assert.equal(f.snapshot(), before);
  const session = await f.request('/api/auth/session', null, logged.cookie);
  assert.equal(session.data.user.organizationId, null);
  assert.equal(session.data.organizationAccess, 'conflict');
  assert.equal(Object.hasOwn(session.data, 'memberships'), false);
  assert.doesNotMatch(JSON.stringify(session.data), /Original organization|Inviting organization/);
  const expected = authContextHeaders(session.data);
  assert.equal(
    (await f.request('/api/cabinet/bootstrap', null, logged.cookie, expected)).status,
    403,
  );
  assert.equal(
    (
      await f.request(
        '/api/auth/select-organization',
        { organizationId: f.inviter.organizationId },
        logged.cookie,
        expected,
      )
    ).status,
    409,
  );
  assert.equal(f.snapshot(), before);
});

test('a no-organization session heals only after exactly one link remains and persists the repaired session', async (t) => {
  const f = await fixture(t),
    logged = await f.login();
  f.legacyLink();
  f.clearSelected(logged.cookie);
  f.raw(({ db }) =>
    db
      .prepare("UPDATE memberships SET status='suspended' WHERE organization_id=? AND account_id=?")
      .run(f.recipient.organizationId, f.recipient.accountId),
  );
  for (let reload = 0; reload < 2; reload++) {
    const session = await f.request('/api/auth/session', null, logged.cookie);
    assert.equal(session.data.user.organizationId, f.inviter.organizationId);
    assert.equal(session.data.user.role, 'salon_admin');
    assert.equal(Object.hasOwn(session.data, 'organizationAccess'), false);
    assert.equal(
      (
        await f.request(
          '/api/cabinet/bootstrap',
          null,
          logged.cookie,
          authContextHeaders(session.data),
        )
      ).status,
      200,
    );
  }
  f.raw(({ db }) => {
    const rows = db
      .prepare(
        "SELECT detail FROM platform_audit WHERE actor_id=? AND event='organization_selected'",
      )
      .all(f.recipient.accountId);
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0].detail).automatic, true);
  });
});

test('no available organization returns a neutral none state without choices or clinical access', async (t) => {
  const f = await fixture(t);
  f.raw(({ db }) =>
    db
      .prepare("UPDATE memberships SET status='suspended' WHERE account_id=?")
      .run(f.recipient.accountId),
  );
  const logged = await f.login();
  assert.equal(logged.status, 200);
  assert.equal(logged.data.organizationId, null);
  const session = await f.request('/api/auth/session', null, logged.cookie);
  assert.equal(session.data.organizationAccess, 'none');
  assert.equal(Object.hasOwn(session.data, 'memberships'), false);
  assert.equal((await f.request('/api/cabinet/bootstrap', null, logged.cookie)).status, 403);
  const anonymous = await f.request('/api/auth/session');
  assert.equal(anonymous.data.user, null);
  assert.equal(Object.hasOwn(anonymous.data, 'organizationAccess'), false);
});

test('restoring a member cannot add a second active organization or change any audit/session state', async (t) => {
  const f = await fixture(t);
  f.legacyLink('suspended');
  const before = f.snapshot();
  assert.throws(
    () =>
      f.platform.updateMembership({
        organizationId: f.inviter.organizationId,
        actorId: f.inviter.accountId,
        accountId: f.recipient.accountId,
        role: 'salon_admin',
        status: 'active',
      }),
    { status: 409 },
  );
  assert.equal(f.snapshot(), before);
});

test('reactivating an organization refuses an active member with another organization, then permits a safe retry', async (t) => {
  const f = await fixture(t);
  f.legacyLink();
  f.raw(({ db }) =>
    db
      .prepare("UPDATE organizations SET status='suspended' WHERE id=?")
      .run(f.inviter.organizationId),
  );
  const before = f.snapshot();
  const command = {
    status: 'active',
    expectedRevision: 0,
    requestId: randomUUID(),
    reason: 'Synthetic access restoration',
  };
  assert.throws(
    () =>
      f.platform.admin.updateOrganizationAccess(
        f.admin.accountId,
        f.inviter.organizationId,
        command,
      ),
    { status: 409 },
  );
  assert.equal(f.snapshot(), before);
  f.raw(({ db }) =>
    db
      .prepare("UPDATE memberships SET status='suspended' WHERE organization_id=? AND account_id=?")
      .run(f.recipient.organizationId, f.recipient.accountId),
  );
  assert.equal(
    f.platform.admin.updateOrganizationAccess(f.admin.accountId, f.inviter.organizationId, command)
      .ok,
    true,
  );
  assert.equal(f.platform.availableMemberships(f.recipient.accountId).length, 1);
});

test('administrative subscription terms do not turn an unused unverified registration into a used account', async (t) => {
  const f = await fixture(t, { unverifiedRecipient: true });
  const subscription = f.platform.subscription(f.recipient.organizationId);
  const revision = f.platform.admin.organization(
    f.admin.accountId,
    f.recipient.organizationId,
  ).subscriptionRevision;
  f.platform.admin.updateSubscription(f.admin.accountId, f.recipient.organizationId, {
    plan: subscription.plan,
    limits: { ...subscription.limits, patients: subscription.limits.patients + 1 },
    expectedRevision: revision,
    requestId: randomUUID(),
    reason: 'Synthetic administrative limits adjustment',
  });
  const invitation = f.platform.prepareEmailInvitation({
    organizationId: f.inviter.organizationId,
    actorId: f.inviter.accountId,
    role: 'salon_admin',
    email: 'recipient@organizations.test',
  });
  f.platform.finishEmailInvitation(
    {
      organizationId: f.inviter.organizationId,
      actorId: f.inviter.accountId,
      invitationId: invitation.id,
      token: invitation.token,
    },
    true,
  );
  const info = await f.request('/api/auth/invitations/info', { token: invitation.token });
  assert.equal(info.status, 200);
  assert.equal(info.data.existingAccount, true);
  assert.equal(info.data.passwordSetupRequired, true);
  const replacement = 'Synthetic-first-password-after-admin-terms';
  const accepted = await f.request('/api/auth/invitations/accept', {
    token: invitation.token,
    email: 'recipient@organizations.test',
    displayName: 'Invited administrator',
    password: replacement,
    passwordConfirmation: replacement,
    privacyConsent: true,
    privacyConsentVersion: PRIVACY_VERSION,
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.accountId, f.recipient.accountId);
  assert.equal(f.platform.organization(f.recipient.organizationId).status, 'suspended');
  const memberships = f.platform.memberships(f.recipient.accountId);
  assert.equal(memberships.length, 2);
  assert.equal(
    memberships.find((row) => row.organizationId === f.recipient.organizationId).status,
    'suspended',
  );
  assert.deepEqual(
    f.platform.availableMemberships(f.recipient.accountId).map((row) => row.organizationId),
    [f.inviter.organizationId],
  );
  const logged = await f.request('/api/auth/login', {
    email: 'recipient@organizations.test',
    password: replacement,
  });
  assert.equal(logged.status, 200);
  assert.equal(logged.data.organizationId, f.inviter.organizationId);
  f.raw(({ db }) =>
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM platform_audit WHERE organization_id=? AND event='subscription_terms_admin_updated'",
        )
        .get(f.recipient.organizationId).n,
      1,
    ),
  );
});
