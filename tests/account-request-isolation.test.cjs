const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { JSDOM } = require('jsdom');
const { createPlatformStore } = require('../platform-store.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const { PRIVACY_VERSION } = require('../src/shared/privacy-consent.cjs');

const password = 'Synthetic-request-isolation-password';
async function fixture(t, { sameName = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-request-isolation-'));
  const platform = createPlatformStore(path.join(directory, 'platform'));
  async function owner(label) {
    const email = label.toLowerCase() + '@request-isolation.test';
    const account = await platform.registerOwner({
      email,
      password,
      displayName: sameName ? 'The same synthetic name' : 'Synthetic account ' + label,
      organizationName: 'Synthetic organization ' + label,
    });
    platform.verifyEmail(account.verificationToken);
    return { ...account, email, token: (await platform.login(email, password)).token };
  }
  const first = await owner('A'),
    second = await owner('B');
  const server = createMultiServer({
    dataDir: directory,
    telegramBot: null,
    supportBot: null,
    sendMail: null,
    telegramAutostart: false,
    supportAutostart: false,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    platform.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cartoteca-request-isolation-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function request(
    route,
    { cookieAccount = first, contextAccount = first, body, bodyText, headers = {} } = {},
  ) {
    const response = await fetch(origin + route, {
      method: body || bodyText ? 'POST' : 'GET',
      headers: {
        Cookie: cookieAccount ? 'cartoteca_v2_session=' + cookieAccount.token : '',
        Origin: origin,
        'Content-Type': 'application/json',
        'X-Cartoteca-Request': '1',
        ...(contextAccount
          ? {
              'X-Cartoteca-Account-Id': contextAccount.accountId,
              'X-Cartoteca-Organization-Id': contextAccount.organizationId || '',
            }
          : {}),
        ...headers,
      },
      body: bodyText || (body ? JSON.stringify(body) : undefined),
    });
    return {
      status: response.status,
      data: await response.json(),
      cookie: response.headers.get('set-cookie')?.split(';')[0],
    };
  }
  async function administrator() {
    const invitation = platform.createInvitation({
      organizationId: first.organizationId,
      invitedBy: first.accountId,
      role: 'salon_admin',
    });
    const email = 'same-organization-admin@request-isolation.test';
    const account = await platform.acceptInvitation({
      token: invitation.token,
      email,
      password,
      displayName: 'Synthetic same-organization admin',
    });
    return {
      ...account,
      email,
      organizationId: first.organizationId,
      token: (await platform.login(email, password)).token,
    };
  }
  async function writeWithPausedBody(account, beforeBodyEnds) {
    let started;
    const reading = new Promise((resolve) => {
      started = resolve;
    });
    const originalTrack = server.requestMetrics.track;
    server.requestMetrics.track = (req, res) => {
      const measurement = originalTrack(req, res);
      return {
        ...measurement,
        stage(name) {
          measurement.stage(name);
          if (req.url === '/api/account/profile' && name === 'request-body') started();
        },
      };
    };
    const body = JSON.stringify({ displayName: 'Must not commit after access changed' });
    let pendingRequest;
    const response = new Promise((resolve, reject) => {
      pendingRequest = http.request(
        origin + '/api/account/profile',
        {
          method: 'POST',
          headers: {
            Cookie: 'cartoteca_v2_session=' + account.token,
            Origin: origin,
            'Content-Type': 'application/json',
            'X-Cartoteca-Request': '1',
            'Content-Length': Buffer.byteLength(body),
            'X-Cartoteca-Account-Id': account.accountId,
            'X-Cartoteca-Organization-Id': account.organizationId,
          },
        },
        (result) => {
          const chunks = [];
          result.on('data', (chunk) => chunks.push(chunk));
          result.on('end', () =>
            resolve({
              status: result.statusCode,
              data: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            }),
          );
          result.on('error', reject);
        },
      );
      pendingRequest.on('error', reject);
      pendingRequest.write(body.slice(0, 1));
    });
    let timer;
    try {
      await Promise.race([
        reading,
        new Promise((resolve, reject) => {
          timer = setTimeout(
            () => reject(Error('Synthetic request did not reach body read')),
            5000,
          );
        }),
      ]);
      await beforeBodyEnds();
      pendingRequest.end(body.slice(1));
      return await response;
    } finally {
      clearTimeout(timer);
      server.requestMetrics.track = originalTrack;
      pendingRequest.destroy();
    }
  }
  const profile = (account) => platform.accountProfile(account.token);
  return {
    first,
    second,
    platform,
    request,
    profile,
    directory,
    administrator,
    writeWithPausedBody,
  };
}

test('a stale profile form cannot update the account selected in another tab', async (t) => {
  const f = await fixture(t),
    beforeA = f.profile(f.first),
    beforeB = f.profile(f.second);
  // The form was rendered for A. Another tab has since replaced the shared cookie with B.
  const response = await f.request('/api/account/profile', {
    cookieAccount: f.second,
    contextAccount: f.first,
    body: { displayName: 'Stale form intended for A' },
  });
  assert.deepEqual(
    {
      status: response.status,
      wrongAccountChanged: JSON.stringify(f.profile(f.second)) !== JSON.stringify(beforeB),
      intendedAccountUnchanged: JSON.stringify(f.profile(f.first)) === JSON.stringify(beforeA),
    },
    { status: 428, wrongAccountChanged: false, intendedAccountUnchanged: true },
  );
  assert.equal(response.data.code, 'AUTH_CONTEXT_CHANGED');
});

test('a stale cookie cannot expose another profile or open its tenant before context validation', async (t) => {
  const f = await fixture(t),
    tenant = path.join(f.directory, 'tenants', f.second.organizationId);
  assert.equal(fs.existsSync(tenant), false);
  for (const route of ['/api/account/profile', '/api/cabinet/bootstrap?paged=1&limit=20']) {
    const response = await f.request(route, { cookieAccount: f.second, contextAccount: f.first });
    assert.equal(response.status, 428);
    assert.equal(response.data.code, 'AUTH_CONTEXT_CHANGED');
    assert.equal(Object.hasOwn(response.data, 'account'), false);
    assert.equal(Object.hasOwn(response.data, 'patients'), false);
  }
  assert.equal(fs.existsSync(tenant), false);
});

test('missing, incomplete and foreign organization context fail closed even for old clients', async (t) => {
  const f = await fixture(t),
    beforeA = f.profile(f.first),
    beforeB = f.profile(f.second);
  for (const headers of [
    {},
    { 'X-Cartoteca-Account-Id': f.first.accountId },
    { 'X-Cartoteca-Organization-Id': f.first.organizationId },
    {
      'X-Cartoteca-Account-Id': f.second.accountId,
      'X-Cartoteca-Organization-Id': f.first.organizationId,
    },
    {
      'X-Cartoteca-Account-Id': f.first.accountId,
      'X-Cartoteca-Organization-Id': f.second.organizationId,
    },
  ]) {
    const response = await f.request('/api/account/profile', {
      contextAccount: null,
      headers,
      body: { displayName: 'Must not be saved' },
    });
    assert.equal(response.status, 428);
    assert.equal(response.data.code, 'AUTH_CONTEXT_CHANGED');
  }
  assert.deepEqual(f.profile(f.first), beforeA);
  assert.deepEqual(f.profile(f.second), beforeB);
});

test('equal display names in different organizations never substitute for account identity', async (t) => {
  const f = await fixture(t, { sameName: true }),
    beforeA = f.profile(f.first),
    beforeB = f.profile(f.second);
  assert.equal(beforeA.account.displayName, beforeB.account.displayName);
  assert.notEqual(f.first.accountId, f.second.accountId);
  assert.notEqual(f.first.organizationId, f.second.organizationId);
  const wrong = await f.request('/api/account/profile', {
    cookieAccount: f.second,
    contextAccount: f.first,
    body: { displayName: 'Must not leak through the same name' },
  });
  assert.equal(wrong.status, 428);
  for (const actor of [f.first, f.second]) {
    const own = await f.request('/api/account/profile', {
      cookieAccount: actor,
      contextAccount: actor,
    });
    assert.equal(own.status, 200);
    assert.deepEqual(own.data, f.profile(actor));
  }
  assert.deepEqual(f.profile(f.first), beforeA);
  assert.deepEqual(f.profile(f.second), beforeB);
});

test('owner and administrator in the same organization still have separate profile and logout contexts', async (t) => {
  const f = await fixture(t),
    administrator = await f.administrator();
  const beforeOwner = f.profile(f.first),
    beforeAdmin = f.profile(administrator);
  assert.equal(administrator.organizationId, f.first.organizationId);
  assert.notEqual(administrator.accountId, f.first.accountId);
  for (const route of ['/api/account/profile', '/api/auth/logout']) {
    const rejected = await f.request(route, {
      cookieAccount: administrator,
      contextAccount: f.first,
      body: route.endsWith('/logout') ? {} : { displayName: 'Must not overwrite the admin' },
    });
    assert.equal(rejected.status, 428);
    assert.equal(f.platform.session(administrator.token).accountId, administrator.accountId);
    assert.equal(f.platform.session(f.first.token).accountId, f.first.accountId);
  }
  assert.deepEqual(f.profile(f.first), beforeOwner);
  assert.deepEqual(f.profile(administrator), beforeAdmin);
  const loggedOut = await f.request('/api/auth/logout', {
    cookieAccount: administrator,
    contextAccount: administrator,
    body: {},
  });
  assert.equal(loggedOut.status, 200);
  assert.equal(f.platform.session(administrator.token), null);
  assert.equal(f.platform.session(f.first.token).accountId, f.first.accountId);
  assert.deepEqual(f.profile(f.first), beforeOwner);
});

test('an old headerless logout cannot end the newly selected account session', async (t) => {
  const f = await fixture(t),
    beforeOwner = f.profile(f.first);
  const staleLogout = await f.request('/api/auth/logout', {
    cookieAccount: f.second,
    contextAccount: null,
    body: {},
  });
  assert.deepEqual(
    {
      status: staleLogout.status,
      newAccountStillSignedIn: Boolean(f.platform.session(f.second.token)),
      originalAccountStillSignedIn: Boolean(f.platform.session(f.first.token)),
    },
    { status: 428, newAccountStillSignedIn: true, originalAccountStillSignedIn: true },
  );
  assert.equal(staleLogout.data.code, 'AUTH_CONTEXT_CHANGED');
  const ownLogout = await f.request('/api/auth/logout', {
    cookieAccount: f.second,
    contextAccount: f.second,
    body: {},
  });
  assert.equal(ownLogout.status, 200);
  assert.equal(f.platform.session(f.second.token), null);
  assert.equal(f.platform.session(f.first.token).accountId, f.first.accountId);
  assert.deepEqual(f.profile(f.first), beforeOwner);
  const anonymousLogout = await f.request('/api/auth/logout', {
    cookieAccount: null,
    contextAccount: null,
    body: {},
  });
  assert.equal(anonymousLogout.status, 200);
  assert.equal(anonymousLogout.data.ok, true);
});

for (const change of ['role', 'session'])
  test(
    'an already started profile write stops if its ' + change + ' changes during the body read',
    async (t) => {
      const f = await fixture(t),
        administrator = await f.administrator();
      const beforeOwner = f.profile(f.first),
        beforeAdmin = f.profile(administrator).account;
      const response = await f.writeWithPausedBody(administrator, () => {
        if (change === 'role')
          f.platform.updateMembership({
            organizationId: f.first.organizationId,
            actorId: f.first.accountId,
            accountId: administrator.accountId,
            role: 'cosmetologist',
            status: 'active',
          });
        else f.platform.logout(administrator.token);
      });
      assert.equal(response.status, 401);
      assert.equal(Object.hasOwn(response.data, 'account'), false);
      const fresh = await f.platform.login(administrator.email, password);
      assert.equal(
        f.platform.session(fresh.token).role,
        change === 'role' ? 'cosmetologist' : 'salon_admin',
      );
      assert.deepEqual(f.profile({ ...administrator, token: fresh.token }).account, beforeAdmin);
      assert.deepEqual(f.profile(f.first), beforeOwner);
    },
  );

test('deliberate public login and a new invitation work while another account is signed in', async (t) => {
  const f = await fixture(t),
    beforeA = f.profile(f.first),
    beforeB = f.profile(f.second);
  const login = await f.request('/api/auth/login', {
    cookieAccount: f.first,
    contextAccount: null,
    body: { email: f.second.email, password },
  });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.id, f.second.accountId);
  assert.equal(login.data.organizationId, f.second.organizationId);
  assert.equal(Boolean(login.cookie), true);
  const email = 'new-invitee@request-isolation.test';
  const invitation = f.platform.prepareEmailInvitation({
    organizationId: f.second.organizationId,
    actorId: f.second.accountId,
    email,
    role: 'salon_admin',
  });
  f.platform.finishEmailInvitation(
    {
      organizationId: f.second.organizationId,
      actorId: f.second.accountId,
      invitationId: invitation.id,
      token: invitation.token,
    },
    true,
  );
  const info = await f.request('/api/auth/invitations/info', {
    cookieAccount: f.first,
    contextAccount: null,
    body: { token: invitation.token },
  });
  assert.equal(info.status, 200);
  assert.equal(info.data.existingAccount, false);
  const accepted = await f.request('/api/auth/invitations/accept', {
    cookieAccount: f.first,
    contextAccount: null,
    body: {
      token: invitation.token,
      email,
      password,
      passwordConfirmation: password,
      displayName: 'Synthetic new invitee',
      privacyConsent: true,
      privacyConsentVersion: PRIVACY_VERSION,
    },
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.organizationId, f.second.organizationId);
  assert.notEqual(accepted.data.accountId, f.first.accountId);
  assert.notEqual(accepted.data.accountId, f.second.accountId);
  assert.equal(Boolean(accepted.cookie), false);
  assert.deepEqual(f.profile(f.first), beforeA);
  assert.deepEqual(f.profile(f.second), beforeB);
  assert.equal(f.platform.session(f.first.token).accountId, f.first.accountId);
});

test('the context precondition runs before request body parsing and never supplies authority', async (t) => {
  const f = await fixture(t);
  const wrong = await f.request('/api/account/profile', {
    cookieAccount: f.second,
    contextAccount: f.first,
    bodyText: '{not valid json',
  });
  assert.equal(wrong.status, 428);
  assert.equal(wrong.data.code, 'AUTH_CONTEXT_CHANGED');
  const unauthenticated = await f.request('/api/account/profile', { cookieAccount: null });
  assert.equal(unauthenticated.status, 401);
  const notAdmin = await f.request('/api/admin/overview');
  assert.equal(notAdmin.status, 403);
});

test('session bootstrap remains public and matching context updates only its authenticated account', async (t) => {
  const f = await fixture(t),
    beforeA = f.profile(f.first);
  const bootstrap = await f.request('/api/auth/session', {
    cookieAccount: f.second,
    contextAccount: null,
  });
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.data.user.id, f.second.accountId);
  const response = await f.request('/api/account/profile', {
    cookieAccount: f.second,
    contextAccount: f.second,
    body: { displayName: 'Updated synthetic B' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.data.account.displayName, 'Updated synthetic B');
  assert.deepEqual(f.profile(f.first), beforeA);
  assert.equal(f.profile(f.second).account.displayName, 'Updated synthetic B');
});

test('private photos reject missing and foreign URL context before creating a tenant', async (t) => {
  const f = await fixture(t),
    tenant = path.join(f.directory, 'tenants', f.second.organizationId);
  const photo = '/api/photos/' + '0'.repeat(32);
  for (const query of [
    '',
    '?accountContext=' + f.first.accountId + '&organizationContext=' + f.first.organizationId,
    '?accountContext=' + f.second.accountId,
  ]) {
    const response = await f.request(photo + query, {
      cookieAccount: f.second,
      contextAccount: null,
    });
    assert.equal(response.status, 428);
    assert.equal(response.data.code, 'AUTH_CONTEXT_CHANGED');
    assert.equal(fs.existsSync(tenant), false);
  }
});

test('private photo preconditions reject duplicate parameters before any tenant access', async (t) => {
  const f = await fixture(t),
    tenant = path.join(f.directory, 'tenants', f.second.organizationId);
  const base =
    '/api/photos/' +
    '0'.repeat(32) +
    '?accountContext=' +
    f.second.accountId +
    '&organizationContext=' +
    f.second.organizationId;
  for (const duplicate of [
    '&accountContext=' + f.first.accountId,
    '&accountContext=' + f.second.accountId,
    '&organizationContext=' + f.first.organizationId,
    '&organizationContext=' + f.second.organizationId,
  ]) {
    const response = await f.request(base + duplicate, {
      cookieAccount: f.second,
      contextAccount: null,
    });
    assert.equal(response.status, 428);
    assert.equal(response.data.code, 'AUTH_CONTEXT_CHANGED');
    assert.equal(fs.existsSync(tenant), false);
  }
});

test('global administrator requests also require their account and explicit empty organization context', async (t) => {
  const f = await fixture(t),
    created = await f.platform.bootstrapGlobalAdmin({
      email: 'global@request-isolation.test',
      password,
      displayName: 'Synthetic global administrator',
    });
  const global = {
    ...created,
    token: (await f.platform.login('global@request-isolation.test', password)).token,
  };
  const missing = await f.request('/api/admin/overview', {
    cookieAccount: global,
    contextAccount: null,
  });
  assert.equal(missing.status, 428);
  const matching = await f.request('/api/admin/overview', {
    cookieAccount: global,
    contextAccount: global,
  });
  assert.equal(matching.status, 200);
});

test('native audio GET requires an unambiguous issuing URL scope and checks any supplied PCM headers', async (t) => {
  const f = await fixture(t),
    route = '/api/assistant/speak-audio?ticket=' + 'a'.repeat(43);
  const own =
    '&accountContext=' + f.first.accountId + '&organizationContext=' + f.first.organizationId;
  for (const suffix of [
    '',
    '&accountContext=' + f.first.accountId,
    '&accountContext=' + f.second.accountId + '&organizationContext=' + f.first.organizationId,
    own + '&accountContext=' + f.first.accountId,
    own + '&organizationContext=' + f.first.organizationId,
  ]) {
    const response = await f.request(route + suffix, { contextAccount: null });
    assert.equal(response.status, 428);
    assert.equal(response.data.code, 'AUTH_CONTEXT_CHANGED');
  }
  const foreignCookie = await f.request(route + own, {
    cookieAccount: f.second,
    contextAccount: null,
  });
  assert.equal(foreignCookie.status, 428);
  const wrongPcmHeaders = await f.request(route + own, { contextAccount: f.second });
  assert.equal(wrongPcmHeaders.status, 428);
  for (const contextAccount of [null, f.first]) {
    const ticketExpired = await f.request(route + own, { contextAccount });
    assert.equal(
      ticketExpired.status,
      410,
      'A matching scope reaches the ticket expiry check without granting audio access',
    );
    assert.match(ticketExpired.data.error, /Озвучивание истекло/);
    assert.equal(Object.hasOwn(ticketExpired.data, 'code'), false);
    assert.equal(Object.hasOwn(ticketExpired.data, 'audioBase64'), false);
  }
  const headerOnly = await f.request(route);
  assert.equal(headerOnly.status, 428, 'PCM headers cannot replace the issuing URL binding');
});

function clientFixture({ document: suppliedDocument } = {}) {
  const state = {
    account: { id: 'synthetic-a', organizationId: 'synthetic-org-a' },
    sessionReady: true,
  };
  const calls = [],
    redirects = [],
    classes = new Set();
  let resets = 0;
  const create = vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../src/client/core/session.js'), 'utf8') +
      '\ncreateSession',
    {
      AbortController,
      setTimeout,
      clearTimeout,
      window: new EventTarget(),
      document: suppliedDocument || { body: { classList: { add: (value) => classes.add(value) } } },
      location: { hash: '', replace: (value) => redirects.push(value) },
      fetch(url, options) {
        let resolve;
        const promise = new Promise((done) => {
          resolve = done;
        });
        calls.push({
          url,
          options,
          complete(data, status = 200) {
            resolve({ status, ok: status >= 200 && status < 300, json: async () => data });
          },
        });
        return promise;
      },
    },
  );
  return {
    state,
    calls,
    redirects,
    classes,
    resets: () => resets,
    api: create(state, { resetAssistant: () => resets++ }),
  };
}

test('authenticated requests capture account and organization without accepting a caller override', async () => {
  const f = clientFixture(),
    pending = f.api.request('/api/account/profile', {
      headers: { 'X-Cartoteca-Account-Id': 'foreign', 'X-Cartoteca-Organization-Id': 'foreign' },
    });
  assert.equal(f.calls[0].options.headers['X-Cartoteca-Account-Id'], f.state.account.id);
  assert.equal(
    f.calls[0].options.headers['X-Cartoteca-Organization-Id'],
    f.state.account.organizationId,
  );
  f.calls[0].complete({ account: { displayName: 'Synthetic A' } });
  assert.equal((await pending).account.displayName, 'Synthetic A');
  const bootstrap = f.api.request('/api/auth/session');
  assert.equal(Object.hasOwn(f.calls[1].options.headers, 'X-Cartoteca-Account-Id'), false);
  f.calls[1].complete({ user: f.state.account });
  await bootstrap;
});

test('a context mismatch blocks in-flight data, future mutations and repeated redirects', async () => {
  const f = clientFixture();
  const errors = [
    f.api.request('/api/account/profile').catch((error) => error),
    f.api.request('/api/cabinet/calendar').catch((error) => error),
  ];
  f.calls[0].complete({ code: 'AUTH_CONTEXT_CHANGED', error: 'Synthetic context mismatch' }, 428);
  const first = await errors[0];
  assert.equal(first.status, 428);
  assert.equal(first.code, 'AUTH_CONTEXT_CHANGED');
  assert.equal(first.outcomeUnknown, false);
  f.calls[1].complete({ appointments: [{ id: 'must-not-escape' }] });
  assert.equal((await errors[1]).code, 'AUTH_CONTEXT_CHANGED');
  await assert.rejects(
    f.api.request('/api/account/profile', { method: 'POST', body: '{}' }),
    (error) => error.code === 'AUTH_CONTEXT_CHANGED' && error.outcomeUnknown === false,
  );
  assert.equal(f.calls.length, 2);
  assert.equal(f.resets(), 1);
  assert.deepEqual(f.redirects, ['/']);
  assert.equal(f.classes.has('app-loading'), true);
  assert.equal(f.state.sessionReady, false);
});

test('an old successful response cannot enter a locally replaced account scope', async () => {
  const f = clientFixture(),
    pending = f.api.request('/api/account/profile').catch((error) => error);
  f.state.account = { id: 'synthetic-b', organizationId: 'synthetic-org-b' };
  f.calls[0].complete({ account: { displayName: 'Old synthetic A' } });
  const error = await pending;
  assert.equal(error.code, 'AUTH_CONTEXT_CHANGED');
  assert.equal(error.outcomeUnknown, false);
  assert.equal(f.state.account.id, 'synthetic-b');
  assert.deepEqual(f.redirects, []);
  assert.equal(f.resets(), 0);
});

test('a delayed profile response cannot replace the current account DOM after a local switch', async (t) => {
  const dom = new JSDOM(
    '<section id="profile-settings"><p>Current account placeholder</p></section>',
  );
  t.after(() => dom.window.close());
  const f = clientFixture({ document: dom.window.document });
  const root = dom.window.document.querySelector('#profile-settings'),
    before = root.innerHTML;
  const createProfile = vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../src/client/modules/profile.js'), 'utf8') +
      '\ncreateProfile',
  );
  const profile = createProfile(f.state, {
    $: (selector) => dom.window.document.querySelector(selector),
    readBackground: f.api.request,
  });
  const pending = profile.loadAccountProfile();
  f.state.account = { id: 'synthetic-b', organizationId: 'synthetic-org-b' };
  f.calls[0].complete({
    account: { displayName: 'Stale A name', email: 'stale-a@request-isolation.test' },
  });
  await pending;
  assert.equal(root.innerHTML, before);
  assert.equal(root.querySelector('form'), null);
  assert.doesNotMatch(root.textContent, /Stale A name|stale-a@/);
  assert.equal(f.state.account.id, 'synthetic-b');
  assert.deepEqual(f.redirects, []);
});

test('parallel session and calendar refreshes terminate once in either response order', async () => {
  for (const probeFirst of [false, true]) {
    const f = clientFixture();
    const probe = f.api.request('/api/auth/session').catch((error) => error),
      calendar = f.api.request('/api/cabinet/calendar').catch((error) => error);
    const completeProbe = () =>
      f.calls[0].complete({
        user: { id: 'synthetic-b', organizationId: 'synthetic-org-b' },
      });
    const completeCalendar = () => f.calls[1].complete({ code: 'AUTH_CONTEXT_CHANGED' }, 428);
    if (probeFirst) {
      completeProbe();
      assert.equal((await probe).code, 'AUTH_CONTEXT_CHANGED');
      completeCalendar();
    } else {
      completeCalendar();
      assert.equal((await calendar).code, 'AUTH_CONTEXT_CHANGED');
      completeProbe();
    }
    for (const result of await Promise.all([probe, calendar]))
      assert.equal(result.code, 'AUTH_CONTEXT_CHANGED');
    assert.deepEqual(f.redirects, ['/']);
    assert.equal(f.resets(), 1);
    assert.equal(f.state.account.id, 'synthetic-a');
  }
});

test('unsuccessful session probes retain their HTTP failure instead of inventing a changed account', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const f = clientFixture(),
      pending = f.api.request('/api/auth/session').catch((error) => error);
    f.calls[0].complete({ error: 'Synthetic session HTTP failure' }, status);
    const error = await pending;
    assert.equal(error.status, status);
    assert.equal(
      error.message,
      status === 401 ? 'Войдите снова.' : 'Synthetic session HTTP failure',
    );
    assert.equal(error.code, undefined);
    assert.equal(error.outcomeUnknown, undefined);
    assert.deepEqual(f.redirects, status === 401 ? ['/'] : []);
    assert.equal(f.resets(), status === 401 ? 1 : 0);
    assert.equal(f.state.sessionReady, true);
  }
});

test('a cabinet context rejection never opens uncertain-save recovery or retries a write', async () => {
  const f = clientFixture();
  Object.assign(f.state, { data: [], services: [], revision: 0 });
  let recovery = 0;
  const createStore = vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../src/client/core/cabinet-store.js'), 'utf8') +
      '\ncreateCabinetStore',
    { structuredClone },
  );
  const store = createStore(f.state, {
    request: f.api.request,
    openSaveRecovery: () => recovery++,
  });
  store.rememberCabinet({ patients: [], services: [] });
  const pending = store.save().catch((error) => error);
  f.calls[0].complete({ code: 'AUTH_CONTEXT_CHANGED', error: 'Synthetic context mismatch' }, 428);
  assert.equal((await pending).code, 'AUTH_CONTEXT_CHANGED');
  assert.equal(store.cabinetSaveStatus(), null);
  assert.equal((await store.recoverCabinetSave({ retry: true })).status, 'none');
  assert.equal(recovery, 0);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.state.data, []);
  assert.deepEqual(f.state.services, []);
});
