const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { maxFixture } = require('./max-fixture.cjs');
const { migrateNotificationQueue } = require('../src/server/migrations/013-notification-queue.cjs');
const {
  migrateNotificationChannels,
} = require('../src/server/migrations/014-notification-channels.cjs');
const { migrateMaxInbox } = require('../src/server/migrations/015-max-inbox.cjs');
const { createMultiServer } = require('../src/server/application/server.cjs');
const { createConfiguredMultiServer } = require('../src/server/application/max-startup.cjs');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const { secureRequest } = require('../src/server/http/security.cjs');
const { configuredMax } = require('../src/server/modules/notifications/max-adapter.cjs');

const secret = 'synthetic_max_webhook_secret_not_a_real_credential';
const disabled = {
  sendMail: null,
  telegramBot: null,
  supportDelivery: { telegram: null, email: null },
  telegramAutostart: false,
  maxAutostart: false,
  supportAutostart: false,
  adminEmailAutostart: false,
  bookingPublicationAutostart: false,
};
function fixture(t) {
  const f = maxFixture(t, { serverData: true });
  migrateNotificationQueue(f.database, f.directory);
  migrateNotificationChannels(f.database, f.directory);
  migrateMaxInbox(f.database, f.directory);
  const storage = createStorage(path.join(f.dataDir, 'tenants', 'org'));
  storage.write({
    revision: 0,
    services: [],
    patients: f.patients.map((p) => ({ ...p, name: 'Synthetic client' })),
  });
  storage.close();
  return f;
}

test('MAX webhook authenticates before parsing, commits before 200, survives server restart and preserves CSRF elsewhere', async (t) => {
  const f = fixture(t),
    issued = f.links.issue('org', 'p', 'owner', '123', () => {}, f.now);
  const options = {
    ...disabled,
    dataDir: f.dataDir,
    port: 0,
    commonNotificationsEnabled: true,
    maxConnectionsEnabled: true,
    maxBot: {},
    maxBotIdentity: f.identity,
    maxWebhookSecret: secret,
  };
  const body = {
    update_type: 'bot_started',
    timestamp: f.now,
    user: { user_id: '9223372036854775807', is_bot: false, name: 'PRIVATE NAME' },
    payload: issued.token,
  };
  let server = createMultiServer(options);
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const post = (endpoint, value, header = secret, extra = {}) =>
      fetch(origin + endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-max-bot-api-secret': header, ...extra },
        body: typeof value === 'string' ? value : JSON.stringify(value),
      });
    for (const endpoint of ['/api/max/webhook?probe=synthetic', '/api/max/step/../webhook'])
      assert.equal((await post(endpoint, 'not-json')).status, 400);
    for (const endpoint of ['/api/max/webhook/', '/api/max/webhook-other'])
      assert.equal((await post(endpoint, 'not-json')).status, 403);
    assert.equal((await post('/api/max/webhook', 'not-json', 'wrong')).status, 403);
    assert.equal(f.database.db.prepare('SELECT count(*) n FROM max_event_inbox').get().n, 0);
    assert.equal(
      (await post('/api/max/webhook', { ...body, padding: 'x'.repeat(33000) })).status,
      413,
    );
    assert.equal(
      (await post('/api/max/webhook', body, secret, { 'content-encoding': 'gzip' })).status,
      415,
    );
    assert.equal((await post('/api/max/unlink', {})).status, 403);
    const accepted = await post(
      '/api/max/webhook',
      JSON.stringify(body).replace('"9223372036854775807"', '9223372036854775807'),
    );
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).accepted, true);
    assert.equal(f.links.link('org', 'p'), null);
    assert.equal(
      f.database.db.prepare('SELECT status FROM max_event_inbox').get().status,
      'pending',
    );
    await new Promise((resolve) => server.close(resolve));
    server = createMultiServer(options);
    // Background work requires a process lease even when this fixture drives ticks manually.
    assert.equal(server.startBackground(), true);
    await server.maxRuntime.tick();
    assert.equal(f.links.link('org', 'p').userId, '9223372036854775807');
    assert.equal(f.database.db.prepare('SELECT status FROM max_event_inbox').get().status, 'done');
    assert.equal(server.maxRuntime.accept(secret, body).repeated, true);
    assert.equal(server.maxRuntime.status().running, false);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('provider exemption cannot bypass other methods, paths or Host validation', () => {
  const res = { setHeader() {} };
  const req = {
    method: 'POST',
    url: '/api/max/webhook',
    socket: { localPort: 4174 },
    headers: { host: '127.0.0.1:4174' },
  };
  assert.equal(secureRequest(req, res, '', [], true), 'http://127.0.0.1:4174');
  for (const changed of [
    { ...req, method: 'DELETE' },
    { ...req, url: '/api/max/unlink' },
    { ...req, headers: { host: 'foreign.test' } },
  ])
    assert.throws(() => secureRequest(changed, res, '', [], true), { status: 403 });
  assert.throws(() => secureRequest(req, res, '', [], false), { status: 403 });
});

test('prepared startup stays default-off; enabling requires schema, secret and exact /me bot identity', async (t) => {
  const f = fixture(t);
  assert.throws(
    () => createMultiServer({ ...disabled, dataDir: f.dataDir }),
    /newer than this application/,
  );
  let requests = 0;
  const environment = {
    CARTOTECA_MAX_ENABLED: '1',
    MAX_BOT_TOKEN: 'synthetic-token',
    MAX_WEBHOOK_SECRET: secret,
  };
  const fetchImpl = async () => {
    requests++;
    return { ok: true, json: async () => ({ is_bot: true, user_id: 123, username: 'wrong_bot' }) };
  };
  await assert.rejects(
    createConfiguredMultiServer(
      { ...disabled, dataDir: f.dataDir },
      { environment: { ...environment, MAX_WEBHOOK_SECRET: '' }, fetchImpl },
    ),
    { status: 503 },
  );
  assert.equal(requests, 0);
  await assert.rejects(
    createConfiguredMultiServer({ ...disabled, dataDir: f.dataDir }, { environment, fetchImpl }),
    { status: 409 },
  );
  assert.equal(requests, 1);
  const server = await createConfiguredMultiServer(
    { ...disabled, dataDir: f.dataDir },
    {
      environment,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ is_bot: true, user_id: 123, username: f.identity.username }),
      }),
    },
  );
  assert.equal(server.maxRuntime.status().configured, true);
  assert.equal(server.maxRuntime.status().running, false);
  await new Promise((resolve) => server.close(resolve));
});

test('webhook subscription is explicit, HTTPS-only and keeps token/secret out of URL', async () => {
  const calls = [];
  const bot = configuredMax({
    enabled: true,
    token: 'synthetic-token',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () =>
          new URL(url).pathname === '/me'
            ? { is_bot: true, user_id: 123, username: 'synthetic_bot' }
            : { success: true },
      };
    },
  });
  assert.equal(calls.length, 0);
  await bot.initialize();
  for (const url of [
    'http://synthetic.test/api/max/webhook',
    'https://localhost/api/max/webhook',
    'https://synthetic.test:4174/api/max/webhook',
    'https://synthetic.test/other',
  ])
    await assert.rejects(bot.subscribe(url, secret), { status: 400 });
  assert.equal(calls.length, 1);
  await bot.subscribe('https://synthetic.test/api/max/webhook', secret);
  const call = calls[1];
  assert.equal(new URL(call.url).pathname, '/subscriptions');
  assert.equal(call.url.includes(secret), false);
  assert.deepEqual(JSON.parse(call.options.body).update_types, [
    'bot_started',
    'bot_stopped',
    'message_callback',
  ]);
});
