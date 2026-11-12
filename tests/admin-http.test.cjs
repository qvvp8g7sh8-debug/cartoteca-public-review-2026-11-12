const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const { adminFixture } = require('./helpers/admin-fixture.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const { authContextHeaders, scopedPhotoUrl } = require('./helpers/account-context.cjs');

async function httpFixture(t, mail = true, options = {}) {
  const f = await adminFixture(t),
    messages = [];
  const server = createMultiServer({
    dataDir: f.directory,
    sendMail: mail
      ? async (email, link, metadata) => messages.push({ email, link, metadata })
      : null,
    telegramBot: null,
    supportDelivery: { telegram: null, email: null },
    telegramAutostart: false,
    supportAutostart: false,
    adminEmailAutostart: false,
    ...options,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  f.cleanup(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const cookies = {
    admin: 'cartoteca_v2_session=' + f.adminSession.token,
    owner: 'cartoteca_v2_session=' + f.ownerSession.token,
  };
  const contexts = {
    admin: authContextHeaders(f.adminSession),
    owner: authContextHeaders(f.ownerSession),
  };
  const request = (route, body, role = 'admin', origin = base) =>
    fetch(
      base + (route.startsWith('/api/photos/') ? scopedPhotoUrl(route, contexts[role]) : route),
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Cartoteca-Request': '1',
          Origin: origin,
          Cookie: cookies[role] || '',
          ...(route === '/api/auth/session' ? {} : contexts[role]),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
  return { ...f, f, server, messages, request, base };
}

test('all administrative read routes require current global authority and expose only allowlisted fields', async (t) => {
  const { f, request } = await httpFixture(t);
  const routes = [
    '/api/admin/overview',
    '/api/admin/organizations',
    '/api/admin/accounts',
    '/api/admin/audit',
    '/api/admin/support',
    '/api/admin/system',
    '/api/admin/organization?id=' + f.owner.organizationId,
    '/api/admin/account?id=' + f.owner.accountId,
  ];
  for (const route of routes) {
    assert.equal((await request(route, undefined, 'owner')).status, 403, route);
    assert.equal((await request(route, undefined, 'anonymous')).status, 401, route);
    const response = await request(route);
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.doesNotMatch(
      JSON.stringify(await response.json()),
      /passwordHash|salt|chatId|botToken|clinical|connectionString/,
    );
  }
  assert.equal(fs.existsSync(path.join(f.directory, 'tenants')), false);
  for (const route of ['/api/cabinet', '/api/cabinet/directory', '/api/photos/fake'])
    assert.equal((await request(route)).status, 403, route);
});

test('backup status is global-only, allowlisted, fresh and never a clinical/archive download', async (t) => {
  const { atomicJson } = require('../src/server/infrastructure/backup/durable.cjs');
  const f = await httpFixture(t);
  // Configure through the normal server option using a separate temporary server.
  const statusFile = path.join(f.f.directory, 'synthetic-status', 'status.json'),
    now = Date.now();
  atomicJson(statusFile, {
    format: 1,
    observedAt: now,
    cadenceHours: 24,
    remoteConfigured: true,
    lastLocalAt: now,
    lastRemoteAt: now,
    lastDrillAt: now,
    state: 'protected',
    secretKey: 'SENSITIVE_SYNTHETIC',
    file: '/private/archive.enc',
    patients: ['SENSITIVE_SYNTHETIC'],
  });
  const server = createMultiServer({
    dataDir: f.f.directory,
    backupStatusFile: statusFile,
    sendMail: null,
    telegramBot: null,
    supportDelivery: { telegram: null, email: null },
    telegramAutostart: false,
    supportAutostart: false,
    adminEmailAutostart: false,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  f.f.cleanup(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = (role) =>
    fetch(base + '/api/admin/system', {
      headers: {
        ...(role === 'anonymous'
          ? {}
          : authContextHeaders(role === 'admin' ? f.f.adminSession : f.f.ownerSession)),
        Cookie:
          role === 'admin'
            ? 'cartoteca_v2_session=' + f.f.adminSession.token
            : role === 'owner'
              ? 'cartoteca_v2_session=' + f.f.ownerSession.token
              : '',
      },
    });
  assert.equal((await get('anonymous')).status, 401);
  assert.equal((await get('owner')).status, 403);
  const response = await get('admin'),
    data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.backups.health, 'protected');
  assert.doesNotMatch(JSON.stringify(data), /SENSITIVE_SYNTHETIC|archive.enc|secretKey|patients/);
  assert.match(response.headers.get('cache-control'), /no-store/);
});

test('mutations enforce CSRF, versions and isolation; organization restriction does not change subscription', async (t) => {
  const { f, request } = await httpFixture(t),
    org = f.owner.organizationId;
  const body = f.command('organization', org, { status: 'suspended' });
  assert.equal(
    (await request('/api/admin/organizations/access', body, 'admin', 'https://evil.test')).status,
    403,
  );
  assert.equal((await request('/api/admin/organizations/access', body, 'owner')).status, 403);
  assert.equal((await request('/api/admin/organizations/access', body)).status, 200);
  assert.equal((await request('/api/admin/organizations/access', body)).status, 200);
  assert.equal(
    (await request('/api/admin/organizations/access', { ...body, requestId: f.database.id() }))
      .status,
    409,
  );
  assert.equal(f.store.subscription(org).status, 'active');
  assert.equal(f.store.organization(f.other.organizationId).status, 'active');
  assert.equal((await request('/api/cabinet', undefined, 'owner')).status, 401);
});

test('email recovery needs operator password and configured mail; HTTP never leaks confirmation link', async (t) => {
  const { f, server, request, messages, base } = await httpFixture(t);
  const body = f.command('account', f.owner.accountId, {
    email: 'http-replacement@admin.test',
    identityConfirmed: true,
    password: f.password,
  });
  assert.equal(
    (await request('/api/admin/accounts/email', { ...body, password: 'wrong' })).status,
    401,
  );
  const response = await request('/api/admin/accounts/email', body);
  assert.equal(response.status, 202);
  const result = await response.json();
  assert.equal(result.pending, true);
  assert.equal(result.token, undefined);
  assert.equal(result.link, undefined);
  assert.equal((await request('/api/auth/session', undefined, 'owner')).status, 200);
  await server.adminEmailRuntime.tick();
  assert.equal(messages.length, 1);
  assert.equal(new URL(messages[0].link).origin, base);
  const token = new URL(messages[0].link).hash.split('=')[1];
  assert.equal(
    (await request('/api/auth/confirm-email-change', { token }, 'anonymous')).status,
    200,
  );
  assert.equal((await request('/api/auth/session', undefined, 'owner')).status, 200);
  assert.equal(f.store.session(f.ownerSession.token), null);
});

test('unconfigured SMTP prevents recovery or public reply before database mutation', async (t) => {
  const { f, request } = await httpFixture(t, false);
  const body = f.command('account', f.owner.accountId, {
    email: 'disabled@admin.test',
    identityConfirmed: true,
    password: f.password,
  });
  assert.equal((await request('/api/admin/accounts/email', body)).status, 503);
  assert.equal(f.store.admin.account(f.admin.accountId, f.owner.accountId).recovery, null);
  const receipt = f.store.support.create(
    { accountId: f.owner.accountId, organizationId: f.owner.organizationId },
    { requestId: f.database.id(), description: 'Синтетический вопрос' },
  );
  const message = f.command('support', receipt.id, { kind: 'reply', text: 'Ответ' });
  assert.equal((await request('/api/admin/support/message', message)).status, 503);
  assert.equal(f.store.admin.support.detail(f.admin.accountId, receipt.id).messages.length, 0);
});
