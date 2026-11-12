const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { createMultiServer } = require('../multi-server.cjs'),
  { createPlatformStore } = require('../platform-store.cjs');
const {
  createTelegramRuntime,
} = require('../src/server/modules/notifications/telegram-runtime.cjs');
const password = 'Synthetic-staff-http-password';
const { authContextHeaders } = require('./helpers/account-context.cjs');
test('personal routes require login and CSRF, cannot target others; bot rejects group/forged sender and stop revokes links', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-staff-http-'));
  const sent = [],
    bot = {
      initialize: async () => ({ username: 'Synthetic_bot' }),
      send: async (...args) => sent.push(args),
    };
  const server = createMultiServer({
    dataDir: dir,
    telegramBot: bot,
    supportBot: null,
    telegramAutostart: false,
    supportAutostart: false,
    sendMail: null,
  });
  const platform = createPlatformStore(path.join(dir, 'platform'));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    platform.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  await server.telegramRuntime.initialize();
  const owner = await platform.registerOwner({
    email: 'owner@http.test',
    password,
    displayName: 'Synthetic',
    organizationName: 'Synthetic',
  });
  platform.verifyEmail(owner.verificationToken);
  const login = await platform.login('owner@http.test', password),
    base = 'http://127.0.0.1:' + server.address().port,
    cookie = 'cartoteca_v2_session=' + login.token;
  const post = (route, body, headers = {}) =>
    fetch(base + route, {
      method: 'POST',
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        'X-Cartoteca-Request': '1',
        Cookie: cookie,
        ...authContextHeaders(login),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  assert.equal((await fetch(base + '/api/telegram/staff')).status, 401);
  assert.equal(
    (await post('/api/telegram/staff/link', {}, { 'X-Cartoteca-Request': '' })).status,
    403,
  );
  assert.equal((await post('/api/telegram/staff/link', { accountId: 'other' })).status, 400);
  const response = await post('/api/telegram/staff/link', {});
  assert.equal(response.status, 200);
  const invitation = await response.json(),
    secret = new URL(invitation.url).searchParams.get('start');
  assert.match(secret, /^staff_[A-Za-z0-9_-]{43}$/);
  const runtime = createTelegramRuntime({
    platform,
    tenantStore: () => {
      throw Error('No client data should be accessed');
    },
    bot,
  });
  t.after(() => runtime.stop());
  await runtime.handleUpdate({
    message: {
      chat: { id: 100001, type: 'group' },
      from: { id: 100001 },
      text: '/start ' + secret,
    },
  });
  await runtime.handleUpdate({
    message: {
      chat: { id: 100001, type: 'private' },
      from: { id: 100002 },
      text: '/start ' + secret,
    },
  });
  assert.equal(platform.staffNotifications.status(login.token).linked, false);
  await runtime.handleUpdate({
    message: {
      chat: { id: 100001, type: 'private' },
      from: { id: 100001 },
      text: '/start ' + secret,
    },
  });
  const statusResponse = await fetch(base + '/api/telegram/staff', {
      headers: { Cookie: cookie, ...authContextHeaders(login) },
    }),
    status = await statusResponse.json();
  assert.equal(status.linked, true);
  assert.equal(status.enabled, true);
  assert.ok(!JSON.stringify(status).includes('100001'));
  assert.equal(sent.length, 1);
  assert.equal(
    (
      await post('/api/telegram/staff/settings', {
        bindingId: status.bindingId,
        enabled: false,
        accountId: 'other',
      })
    ).status,
    400,
  );
  const global = await platform.bootstrapGlobalAdmin({
      email: 'global@http.test',
      password,
      displayName: 'Synthetic global',
    }),
    globalLogin = await platform.login('global@http.test', password);
  assert.equal(
    (
      await post(
        '/api/telegram/staff/link',
        {},
        { Cookie: 'cartoteca_v2_session=' + globalLogin.token, ...authContextHeaders(globalLogin) },
      )
    ).status,
    403,
  );
  const clientToken = platform.telegram.issueLink(
    owner.organizationId,
    'synthetic-client',
    owner.accountId,
  );
  platform.telegram.consumeLink(clientToken, '100001', () => true);
  const stopping = createTelegramRuntime({ platform, tenantStore: () => {}, bot });
  t.after(() => stopping.stop());
  await stopping.handleUpdate({
    message: { chat: { id: 100001, type: 'private' }, from: { id: 100001 }, text: '/stop' },
  });
  assert.equal(platform.staffNotifications.status(login.token).linked, false);
  assert.equal(platform.telegram.link(owner.organizationId, 'synthetic-client'), null);
});
