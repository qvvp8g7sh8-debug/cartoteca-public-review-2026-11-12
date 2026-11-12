const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { fork } = require('node:child_process');
const path = require('node:path');
const { configuration } = require('../src/server/config.cjs');
const { notificationSchema } = require('../src/server/application/startup-schema.cjs');
const { createPreflightServer } = require('../src/server/application/max-startup.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const { startBackground } = require('../scripts/start-background.cjs');
const { staffMaxFixture } = require('./helpers/staff-max-fixture.cjs');
const { authContextHeaders } = require('./helpers/account-context.cjs');

const isolated = {
  production: false,
  origin: '',
  sendMail: null,
  telegramBot: null,
  supportDelivery: {},
};
const close = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });

test('process configuration preserves combined default and validates bounded per-process resources', () => {
  const config = configuration({}, {});
  assert.equal(config.processRole, 'combined');
  assert.equal(config.tenantCacheLimit, 64);
  assert.equal(config.tenantReadCacheBytes, 64 * 1024 * 1024);
  assert.equal(config.tenantIdleMs, 0);
  const selected = configuration(
    {},
    {
      CARTOTECA_PROCESS_ROLE: 'web',
      CARTOTECA_TENANT_CACHE_LIMIT: '256',
      CARTOTECA_READ_CACHE_MIB: '0',
      CARTOTECA_TENANT_IDLE_MS: '60000',
    },
  );
  assert.equal(selected.processRole, 'web');
  assert.equal(selected.tenantCacheLimit, 256);
  assert.equal(selected.tenantReadCacheBytes, 0);
  assert.equal(selected.tenantIdleMs, 60000);
  for (const overrides of [
    { processRole: 'unknown' },
    { tenantCacheLimit: 0 },
    { tenantCacheLimit: 1025 },
    { tenantCacheLimit: NaN },
    { tenantReadCacheBytes: -1 },
    { tenantIdleMs: 86400001 },
  ])
    assert.throws(() => configuration(overrides, {}), /Invalid/);
  assert.throws(() => configuration({}, { CARTOTECA_READ_CACHE_MIB: '513' }), /Invalid/);
});

test('startup and preflight select the same schema17 for Push and reject malformed or incompatible versions', () => {
  assert.equal(notificationSchema({ pushEnabled: true, maxEnabled: true }, {}), 17);
  assert.equal(notificationSchema({ maxEnabled: true }, {}), 15);
  assert.equal(notificationSchema({}, {}), 11);
  assert.equal(notificationSchema({ pushEnabled: true }, { CARTOTECA_MAX_SCHEMA: '17' }), 17);
  assert.throws(() => notificationSchema({ pushEnabled: true, notificationSchema: 15 }, {}), {
    status: 503,
  });
  assert.throws(() => notificationSchema({ maxEnabled: true }, { CARTOTECA_MAX_SCHEMA: '017' }), {
    status: 503,
  });
});

test('schema17 preflight opens prepared data without protected config, provider calls, timers or queue changes', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  f.connect(f.users[2], 2);
  f.create();
  const before = f.jobs();
  const rejectProvider = () =>
    assert.fail('Preflight must not initialize or send through providers');
  const server = await createPreflightServer(
    {
      dataDir: f.source,
      production: false,
      origin: 'https://synthetic.test',
      maxEnabled: true,
      pushEnabled: true,
      telegramBot: { initialize: rejectProvider, updates: rejectProvider, send: rejectProvider },
      supportDelivery: { telegram: { initialize: rejectProvider, send: rejectProvider } },
      sendMail: rejectProvider,
      pushSend: rejectProvider,
      maxAutostart: true,
    },
    {
      environment: { MAX_PROTECTED_CONFIG: 'must-never-be-read', CARTOTECA_MAX_SCHEMA: '17' },
      fetchImpl: rejectProvider,
    },
  );
  try {
    assert.equal(server.processRole, 'preflight');
    assert.equal(server.address(), null);
    assert.equal(server.startBackground(), false);
    server.emit('listening');
    assert.equal(server.telegramRuntime.status().configured, false);
    assert.equal(server.maxRuntime.status().configured, false);
    assert.equal(server.staffPushRuntime.available, false);
    assert.deepEqual(f.jobs(), before);
    assert.equal(f.database.db.prepare('PRAGMA user_version').get().user_version, 17);
    assert.deepEqual(f.database.db.prepare('SELECT * FROM max_runtime_leases').all(), []);
    assert.equal(
      f.database.db
        .prepare("SELECT 1 FROM telegram_runtime WHERE key='application-process-roles'")
        .get(),
      undefined,
    );
    assert.ok(f.platform.session(f.users[2].token));
  } finally {
    await close(server);
  }
});

test('web role serves HTTP and verifies Telegram identity without polling, scheduling or delivering', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  let identities = 0;
  const server = createMultiServer({
    ...isolated,
    dataDir: f.source,
    notificationSchema: 17,
    processRole: 'web',
    telegramBot: {
      initialize: async () => {
        identities++;
        return { username: 'Synthetic_bot', botId: '123' };
      },
      updates: () => assert.fail('Web worker must not poll'),
      send: () => assert.fail('Web worker must not deliver automatically'),
    },
  });
  const starts = [];
  for (const key of [
    'telegramRuntime',
    'maxRuntime',
    'staffPushRuntime',
    'supportRuntime',
    'adminEmailRuntime',
    'bookingPublicationRuntime',
  ])
    server[key].start = () => starts.push(key);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await new Promise(setImmediate);
    assert.equal(identities, 1);
    assert.equal(server.telegramRuntime.status().connected, true);
    assert.equal(server.startBackground(), false);
    assert.deepEqual(starts, []);
    const base = 'http://127.0.0.1:' + server.address().port;
    assert.equal((await fetch(base + '/login.html')).status, 200);
    assert.deepEqual(f.database.db.prepare('SELECT * FROM max_runtime_leases').all(), []);
  } finally {
    await close(server);
  }
});

test('combined startup retains existing autostarts and starts each runtime only once', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  const server = createMultiServer({ ...isolated, dataDir: f.source, notificationSchema: 17 });
  const starts = [];
  for (const key of [
    'telegramRuntime',
    'maxRuntime',
    'staffPushRuntime',
    'supportRuntime',
    'adminEmailRuntime',
    'bookingPublicationRuntime',
  ])
    server[key].start = () => starts.push(key);
  try {
    assert.equal(server.startBackground(), true);
    server.emit('listening');
    assert.equal(server.startBackground(), false);
    assert.deepEqual(
      starts.sort(),
      [
        'telegramRuntime',
        'staffPushRuntime',
        'supportRuntime',
        'adminEmailRuntime',
        'bookingPublicationRuntime',
      ].sort(),
    );
  } finally {
    await close(server);
  }
  assert.equal(server.startBackground(), false);
});

test('web identity recovers after transient startup failure and restores authenticated link APIs without polling', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  // Creating encrypted accounts/migration copies is setup, not the identity
  // retry deadline. Keep the functional path bounded without racing a loaded VM.
  await t.test(
    'identity recovery and authenticated APIs finish within the deadline',
    { timeout: 10000 },
    async () => {
      let calls = 0,
        recover,
        allowRecovery;
      const permitted = new Promise((resolve) => {
        allowRecovery = resolve;
      });
      const recovered = new Promise((resolve) => {
        recover = resolve;
      });
      const server = createMultiServer({
        ...isolated,
        dataDir: f.source,
        notificationSchema: 17,
        processRole: 'web',
        telegramBot: {
          initialize: async () => {
            calls++;
            if (calls === 1) throw Error('Synthetic transient outage');
            // First prove the disconnected API state; a busy event loop must not
            // make a real one-second retry race the request in this synthetic test.
            await permitted;
            recover();
            return { username: 'Synthetic_bot', botId: '123' };
          },
          updates: () => assert.fail('Identity retry must never poll'),
          send: () => assert.fail('Identity retry must never send'),
        },
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const base = 'http://127.0.0.1:' + server.address().port;
      const headers = {
        ...authContextHeaders(f.users[0].login),
        origin: base,
        'x-cartoteca-request': '1',
        'content-type': 'application/json',
        cookie: 'cartoteca_v2_session=' + f.users[0].token,
      };
      const link = () =>
        fetch(base + '/api/telegram/staff/link', { method: 'POST', headers, body: '{}' });
      try {
        await new Promise(setImmediate);
        assert.equal(server.telegramRuntime.status().connected, false);
        assert.equal((await link()).status, 503);
        allowRecovery();
        await recovered;
        await new Promise(setImmediate);
        assert.equal(calls, 2);
        const status = await fetch(base + '/api/telegram/staff', { headers });
        assert.equal(status.status, 200);
        assert.equal((await status.json()).bot.connected, true);
        const response = await link();
        assert.equal(response.status, 200);
        assert.match((await response.json()).url, /^https:\/\/t\.me\/Synthetic_bot\?start=staff_/);
        assert.equal(
          (
            await fetch(base + '/api/telegram/staff/link', {
              method: 'POST',
              headers: { origin: base, 'x-cartoteca-request': '1' },
              body: '{}',
            })
          ).status,
          401,
        );
        assert.equal(server.startBackground(), false);
        assert.equal(calls, 2);
      } finally {
        allowRecovery();
        await close(server);
      }
    },
  );
});

test('background entrypoint has no HTTP port and obeys explicit disabled senders', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  const server = await startBackground(
    {
      ...isolated,
      dataDir: f.source,
      notificationSchema: 17,
      telegramAutostart: false,
      maxAutostart: false,
      pushAutostart: false,
      supportAutostart: false,
      adminEmailAutostart: false,
      bookingPublicationAutostart: false,
    },
    { environment: {}, fetchImpl: () => assert.fail('No providers in background fixture') },
  );
  try {
    assert.equal(server.processRole, 'background');
    assert.equal(server.listening, false);
    assert.equal(server.address(), null);
    assert.equal(server.startBackground(), false);
  } finally {
    await close(server);
  }
});

test('a lost process lease stops every runtime and blocks automatic restart', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  t.mock.timers.enable({ apis: ['setInterval'] });
  t.mock.method(console, 'error', () => {});
  const server = createMultiServer({ ...isolated, dataDir: f.source, notificationSchema: 17 });
  const stopped = [];
  for (const key of [
    'telegramRuntime',
    'maxRuntime',
    'staffPushRuntime',
    'supportRuntime',
    'adminEmailRuntime',
    'bookingPublicationRuntime',
  ]) {
    server[key].start = () => {};
    server[key].stop = () => stopped.push(key);
  }
  try {
    assert.equal(server.startBackground(), true);
    f.database.db
      .prepare("DELETE FROM telegram_runtime WHERE key='application-process-roles'")
      .run();
    t.mock.timers.tick(10000);
    assert.equal(server.backgroundStatus().state, 'lease-lost');
    assert.equal(server.requestMetrics.snapshot().resources.background.active, false);
    assert.equal(stopped.length, 6);
    assert.equal(server.startBackground(), false);
  } finally {
    await close(server);
  }
});

test('conflicting application roles fail before starting any runtime and recover after clean release', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  const options = { ...isolated, dataDir: f.source, notificationSchema: 17 };
  const combined = createMultiServer(options);
  const background = createMultiServer({ ...options, processRole: 'background' });
  const duplicate = createMultiServer({ ...options, processRole: 'background' });
  let starts = 0;
  for (const server of [combined, background, duplicate])
    for (const key of [
      'telegramRuntime',
      'maxRuntime',
      'staffPushRuntime',
      'supportRuntime',
      'adminEmailRuntime',
      'bookingPublicationRuntime',
    ])
      server[key].start = () => {
        starts++;
      };
  let combinedClosed = false;
  try {
    combined.startBackground();
    assert.equal(starts, 5);
    assert.throws(() => background.startBackground(), { status: 503 });
    assert.equal(starts, 5);
    assert.equal(background.backgroundStatus().active, false);
    await close(combined);
    combinedClosed = true;
    assert.equal(background.startBackground(), true);
    assert.equal(starts, 10);
    assert.throws(() => duplicate.startBackground(), { status: 503 });
    assert.equal(starts, 10);
  } finally {
    if (!combinedClosed) await close(combined);
    await close(background);
    await close(duplicate);
  }
});

test('expiry blocks new background work even before a delayed heartbeat can execute', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const server = createMultiServer({ ...isolated, dataDir: f.source, notificationSchema: 17 });
  try {
    server.startBackground();
    assert.equal(server.backgroundStatus().active, true);
    now += 60001;
    assert.deepEqual(server.backgroundStatus(), {
      role: 'combined',
      state: 'lease-expired',
      active: false,
    });
    assert.deepEqual(server.bookingPublicationRuntime.tick(), { cursor: '', skipped: true });
    assert.equal(server.requestMetrics.snapshot().resources.background.state, 'lease-expired');
  } finally {
    await close(server);
  }
});

test(
  'the real two-worker launcher passes schema17 preflight and shares authenticated HTTP sessions',
  { timeout: 30000 },
  async (t) => {
    const f = await staffMaxFixture(t, { schema: 17 });
    const probe = require('node:net').createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const child = fork(path.join(__dirname, '../scripts/start-workers.cjs'), [], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        CARTOTECA_DATA_DIR: f.source,
        PORT: String(port),
        BIND_HOST: '127.0.0.1',
        APP_ORIGIN: '',
        WEB_CONCURRENCY: '2',
        CARTOTECA_PROCESS_ROLE: 'web',
        CARTOTECA_MAX_SCHEMA: '17',
        CARTOTECA_PUSH_ENABLED: '1',
        CARTOTECA_MAX_ENABLED: '0',
        CARTOTECA_RELEASE_GATE: '',
        MAX_PROTECTED_CONFIG: '',
        TELEGRAM_BOT_TOKEN: '',
        CARTOTECA_SUPPORT_BOT_TOKEN: '',
        SMTP_HOST: '',
      },
    });
    let errorOutput = '';
    const deadline = setTimeout(() => child.kill(), 20000);
    child.stderr.on('data', (data) => {
      errorOutput += data;
    });
    try {
      const message = await Promise.race([
        once(child, 'message').then(([value]) => value),
        once(child, 'exit').then(([code]) => {
          throw Error('Worker exited ' + code + ': ' + errorOutput);
        }),
      ]);
      assert.equal(message.workers, 2);
      const base = 'http://127.0.0.1:' + message.port;
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          fetch(base + '/api/auth/session', {
            headers: { cookie: 'cartoteca_v2_session=' + f.users[0].token },
          }),
        ),
      );
      assert.ok(results.every((response) => response.status === 200));
      assert.equal(f.database.db.prepare('PRAGMA user_version').get().user_version, 17);
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null) {
        const exited = once(child, 'exit');
        child.send('stop');
        await exited;
      }
    }
  },
);
