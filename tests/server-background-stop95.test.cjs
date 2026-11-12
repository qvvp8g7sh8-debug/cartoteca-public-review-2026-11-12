const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createMultiServer } = require('../multi-server.cjs');
const { staffMaxFixture } = require('./helpers/staff-max-fixture.cjs');
const { authContextHeaders } = require('./helpers/account-context.cjs');

const isolated = {
  production: false,
  origin: '',
  sendMail: null,
  telegramBot: null,
  supportDelivery: {},
  notificationSchema: 17,
  telegramIdentityAutostart: false,
  telegramAutostart: false,
  maxAutostart: false,
  pushAutostart: false,
  supportAutostart: false,
  adminEmailAutostart: false,
  bookingPublicationAutostart: false,
  metricsEnabled: true,
  metricsIntervalMs: 0,
  metricsEmit() {},
};
const runtimes = [
  'telegramRuntime',
  'maxRuntime',
  'staffPushRuntime',
  'supportRuntime',
  'adminEmailRuntime',
  'bookingPublicationRuntime',
];
const close = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
const lease = (f) =>
  f.database.db
    .prepare("SELECT value FROM telegram_runtime WHERE key='application-process-roles'")
    .get();

test('finite background stop requires a started owner and remains idempotent after real shutdown', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  const server = createMultiServer({ ...isolated, dataDir: f.source });
  const stopped = [];
  for (const name of runtimes) {
    const original = server[name].stop;
    server[name].stop = () => {
      stopped.push(name);
      return original();
    };
  }
  try {
    assert.equal(server.stopBackground(), false);
    assert.deepEqual(stopped, []);
    assert.equal(lease(f), undefined);
    assert.equal(server.startBackground(), true);
    assert.ok(lease(f));
    assert.equal(server.backgroundStatus().active, true);
    assert.equal(server.stopBackground(), true);
    assert.deepEqual(stopped.sort(), [...runtimes].sort());
    assert.deepEqual(server.backgroundStatus(), {
      role: 'combined',
      state: 'stopped',
      active: false,
    });
    assert.equal(server.requestMetrics.snapshot().resources.background.active, false);
    assert.equal(lease(f), undefined, 'Successful finite stop releases the process lease');
    assert.equal(server.stopBackground(), false);
    assert.equal(
      server.startBackground(),
      false,
      'A finite owner cannot acquire a second background lifetime',
    );
    assert.deepEqual(server.bookingPublicationRuntime.tick(), { cursor: '', skipped: true });
    assert.equal(stopped.length, runtimes.length);
  } finally {
    await close(server);
  }
  assert.equal(server.stopBackground(), false);
  assert.equal(server.startBackground(), false);
});

test('Q1 and all delivery runtimes stop while authenticated HTTP remains available to reconcile data', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  require('../src/server/migrations/018-notification-schedule.cjs').migrateNotificationSchedule(
    f.database,
    f.platformDirectory,
  );
  require('../src/server/migrations/019-paid-services.cjs').migratePaidServices(
    f.database,
    f.platformDirectory,
  );
  const marker = path.join(f.source, '.restore-in-progress');
  fs.writeFileSync(marker, 'notification-queue-maintenance-preparation-v1', { flag: 'wx' });
  require('../src/server/migrations/001-notification-queue-maintenance.cjs').migrateNotificationMaintenance(
    f.platformDirectory,
  );
  fs.unlinkSync(marker);
  const options = {
    ...isolated,
    dataDir: f.source,
    notificationSchema: 19,
    notificationMaintenanceEnabled: true,
  };
  const server = createMultiServer(options);
  let replacement;
  try {
    assert.equal(server.startBackground(), true);
    assert.equal(server.requestMetrics.snapshot().resources.notificationMaintenance.running, true);
    assert.equal(server.stopBackground(), true);
    const stats = server.requestMetrics.snapshot().resources;
    assert.equal(stats.notificationMaintenance.enabled, true);
    assert.equal(stats.notificationMaintenance.running, false);
    assert.equal(stats.background.active, false);
    assert.equal(lease(f), undefined);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    assert.equal(server.startBackground(), false, 'Listening after stop does not revive the owner');
    const base = 'http://127.0.0.1:' + server.address().port;
    const headers = {
      ...authContextHeaders(f.users[0].login),
      cookie: 'cartoteca_v2_session=' + f.users[0].token,
    };
    const session = await fetch(base + '/api/auth/session', { headers });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).user.id, f.owner.accountId);
    assert.equal((await fetch(base + '/login.html')).status, 200);
    replacement = createMultiServer({ ...options, processRole: 'background' });
    assert.equal(
      replacement.startBackground(),
      true,
      'Stopped HTTP server no longer owns background authority',
    );
    assert.equal(replacement.stopBackground(), true);
    assert.equal(server.backgroundStatus().active, false);
    assert.equal((await fetch(base + '/api/auth/session', { headers })).status, 200);
  } finally {
    if (replacement) await close(replacement);
    await close(server);
  }
});

test('web and preflight roles cannot stop or acquire a background lifetime', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  for (const processRole of ['web', 'preflight']) {
    const server = createMultiServer({ ...isolated, dataDir: f.source, processRole });
    try {
      assert.equal(server.stopBackground(), false);
      assert.equal(server.startBackground(), false);
      server.emit('listening');
      assert.equal(server.stopBackground(), false);
      assert.equal(server.backgroundStatus().active, false);
      assert.equal(lease(f), undefined);
    } finally {
      await close(server);
    }
  }
});

test('lease loss retains its diagnostic state and cannot be converted into a restart by stop or close', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  t.mock.timers.enable({ apis: ['setInterval'] });
  t.mock.method(console, 'error', () => {});
  const server = createMultiServer({ ...isolated, dataDir: f.source });
  try {
    assert.equal(server.startBackground(), true);
    f.database.db
      .prepare("DELETE FROM telegram_runtime WHERE key='application-process-roles'")
      .run();
    t.mock.timers.tick(10000);
    assert.deepEqual(server.backgroundStatus(), {
      role: 'combined',
      state: 'lease-lost',
      active: false,
    });
    assert.equal(server.stopBackground(), false);
    assert.equal(server.backgroundStatus().state, 'lease-lost');
    assert.equal(server.startBackground(), false);
    assert.deepEqual(server.bookingPublicationRuntime.tick(), { cursor: '', skipped: true });
  } finally {
    await close(server);
  }
  assert.equal(server.backgroundStatus().state, 'lease-lost');
  assert.equal(server.stopBackground(), false);
});

test('a pending old Telegram initialization cannot start polling or send queued work after finite stop', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  f.connectTelegram(f.users[2], 2);
  f.create('synthetic-finite-stop95');
  const before = f.jobs('telegram');
  assert.ok(before.length > 0);
  let release,
    initializations = 0,
    updates = 0,
    sends = 0;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const server = createMultiServer({
    ...isolated,
    dataDir: f.source,
    telegramAutostart: true,
    telegramBot: {
      initialize: async () => {
        initializations++;
        return pending;
      },
      updates: async () => {
        updates++;
        return [];
      },
      send: async () => {
        sends++;
        return { messageId: 'synthetic' };
      },
    },
  });
  try {
    assert.equal(server.startBackground(), true);
    await new Promise(setImmediate);
    assert.equal(initializations, 1);
    assert.equal(server.stopBackground(), true);
    release({ username: 'Synthetic_bot', botId: '123' });
    await new Promise(setImmediate);
    await server.telegramRuntime.tick();
    // The completion boolean also represents an empty recipient scan. Authority
    // is proved below by unchanged jobs and zero actual polling/outbound calls.
    await server.telegramRuntime.scheduleBatched();
    assert.equal(server.startBackground(), false);
    assert.equal(updates, 0);
    assert.equal(sends, 0);
    assert.deepEqual(
      f.jobs('telegram'),
      before,
      'Stopping does not claim or acknowledge pending work',
    );
    assert.equal(server.backgroundStatus().active, false);
    assert.equal(lease(f), undefined);
  } finally {
    release({ username: 'Synthetic_bot', botId: '123' });
    await close(server);
  }
});
