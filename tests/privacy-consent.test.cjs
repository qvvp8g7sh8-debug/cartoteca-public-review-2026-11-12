const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMultiServer } = require('../multi-server.cjs');
const { createPlatformStore } = require('../platform-store.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { PRIVACY_VERSION } = require('../src/shared/privacy-consent.cjs');
const password = 'Synthetic-privacy-password-2026';
const grant = { privacyConsent: true, privacyConsentVersion: PRIVACY_VERSION };

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-privacy-'));
  const platform = createPlatformStore(path.join(dir, 'platform'));
  const outbox = [];
  const server = createMultiServer({
    dataDir: dir,
    telegramBot: null,
    supportBot: null,
    telegramAutostart: false,
    supportAutostart: false,
    sendMail: async (email, url) => outbox.push({ email, url }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    platform.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('cartoteca-privacy-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function post(route, body) {
    const response = await fetch(base + route, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json', 'X-Cartoteca-Request': '1' },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }
  function account(email) {
    const database = createPlatformDatabase(path.join(dir, 'platform'));
    try {
      const row = database.db
        .prepare('SELECT value FROM accounts WHERE email_hash=?')
        .get(database.emailHash(email));
      return row ? database.open(row.value) : null;
    } finally {
      database.db.close();
    }
  }
  function detachOrganization({ organizationId, accountId }) {
    const database = createPlatformDatabase(path.join(dir, 'platform'));
    try {
      database.db.prepare("UPDATE organizations SET status='suspended' WHERE id=?").run(organizationId);
      database.db.prepare("UPDATE memberships SET status='suspended' WHERE organization_id=? AND account_id=?").run(organizationId, accountId);
    } finally {
      database.db.close();
    }
  }
  return { platform, outbox, base, post, account, detachOrganization };
}

test('registration requires a current affirmative consent before account creation or email delivery', async (t) => {
  const f = await fixture(t);
  const body = {
    email: 'new@privacy.test',
    password,
    displayName: 'Synthetic',
    organizationName: 'Synthetic',
  };
  for (const fields of [
    {},
    { ...grant, privacyConsent: false },
    { ...grant, privacyConsent: { granted: true, at: 1 } },
  ]) {
    assert.equal((await f.post('/api/auth/register', { ...body, ...fields })).status, 400);
    assert.equal(f.account(body.email), null);
    assert.equal(f.outbox.length, 0);
  }
  assert.equal(
    (await f.post('/api/auth/register', { ...body, ...grant, privacyConsentVersion: 'obsolete' }))
      .status,
    409,
  );
  assert.equal(f.account(body.email), null);
  const before = Date.now();
  assert.equal(
    (await f.post('/api/auth/register', { ...body, ...grant, privacyConsentAt: 1 })).status,
    201,
  );
  const consent = f.account(body.email).privacyConsent;
  assert.equal(consent.granted, true);
  assert.equal(consent.version, PRIVACY_VERSION);
  assert.equal(consent.purpose, 'registration');
  assert.ok(consent.at >= before && consent.at <= Date.now());
  assert.equal(f.outbox.length, 1);
});

test('new invitation recipients cannot bypass consent by claiming an existing account', async (t) => {
  const f = await fixture(t);
  const owner = await f.platform.registerOwner({
    email: 'owner@privacy.test',
    password,
    displayName: 'Owner',
    organizationName: 'Organization',
  });
  f.platform.verifyEmail(owner.verificationToken);
  const invitation = f.platform.prepareEmailInvitation({
    organizationId: owner.organizationId,
    actorId: owner.accountId,
    role: 'salon_admin',
    email: 'staff@privacy.test',
  });
  f.platform.finishEmailInvitation(
    {
      organizationId: owner.organizationId,
      actorId: owner.accountId,
      invitationId: invitation.id,
      token: invitation.token,
    },
    true,
  );
  const body = {
    token: invitation.token,
    email: 'staff@privacy.test',
    password,
    passwordConfirmation: password,
    displayName: 'Staff',
    existingAccount: true,
  };
  assert.equal((await f.post('/api/auth/invitations/accept', body)).status, 400);
  assert.equal(f.account(body.email), null);
  assert.equal((await f.post('/api/auth/invitations/accept', { ...body, ...grant })).status, 200);
  assert.equal(f.account(body.email).privacyConsent.version, PRIVACY_VERSION);
  assert.equal(f.platform.memberships(owner.accountId).length, 1);
});

test('an existing account without an active organization can join one without a retroactive consent record', async (t) => {
  const f = await fixture(t);
  const create = async (email) => {
    const owner = await f.platform.registerOwner({
      email,
      password,
      displayName: 'Existing',
      organizationName: 'Organization',
    });
    f.platform.verifyEmail(owner.verificationToken);
    return owner;
  };
  const owner = await create('owner@privacy.test');
  const recipient = await create('existing@privacy.test');
  f.detachOrganization(recipient);
  assert.equal(
    (await f.post('/api/auth/login', { email: 'existing@privacy.test', password })).status,
    200,
  );
  const invitation = f.platform.prepareEmailInvitation({
    organizationId: owner.organizationId,
    actorId: owner.accountId,
    role: 'cosmetologist',
    email: 'existing@privacy.test',
  });
  f.platform.finishEmailInvitation(
    {
      organizationId: owner.organizationId,
      actorId: owner.accountId,
      invitationId: invitation.id,
      token: invitation.token,
    },
    true,
  );
  assert.equal(
    (
      await f.post('/api/auth/invitations/accept', {
        token: invitation.token,
        email: 'existing@privacy.test',
        password,
        displayName: 'Existing',
      })
    ).status,
    200,
  );
  assert.equal(f.platform.memberships(recipient.accountId).length, 2);
  assert.equal(f.platform.availableMemberships(recipient.accountId).length, 1);
  assert.equal(f.platform.availableMemberships(recipient.accountId)[0].organizationId, owner.organizationId);
  assert.equal(f.platform.organization(recipient.organizationId).status, 'suspended');
  assert.equal(f.account('existing@privacy.test').privacyConsent, undefined);
});

test('policy and consent are public before authentication with local no-store resources', async (t) => {
  const f = await fixture(t);
  for (const file of ['privacy.html', 'consent.html', 'legal.css', 'legal.js']) {
    const response = await fetch(f.base + '/' + file);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.doesNotMatch(await response.text(), /\{\{[A-Z_]+\}\}/);
  }
});
