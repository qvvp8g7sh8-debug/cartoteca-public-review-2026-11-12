const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const http = require('node:http');
const { fork } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const {
  routes,
  isNativeCommand,
  nativeCommandIsolation,
} = require('../src/server/infrastructure/native-command-routes.cjs');
const {
  createNotificationChannelProjection,
} = require('../src/server/modules/notifications/channel-projection.cjs');
const { startNativeApplication } = require('../src/server/infrastructure/native-application.cjs');
const {
  runNativeApplicationChild,
} = require('../src/server/infrastructure/native-application-child.cjs');
const { nativeIsolatedFixture } = require('./helpers/native-isolated-fixture.cjs');

const observation = () => ({
  telegram: { configured: false, connected: false, botId: '' },
  providers: {
    telegram: { configured: false, connected: false, botId: '' },
    max: { configured: true, connected: true, botId: 'synthetic-bot' },
  },
});

test('manual command classification keeps the exact existing handlers and an explicit prepared activation boundary', () => {
  const expected = [
    'PUT /api/cabinet',
    'PATCH /api/cabinet/changes',
    'POST /api/cabinet/appointments',
  ];
  assert.deepEqual(
    routes.map((row) => row.method + ' ' + row.path),
    expected,
  );
  for (const row of routes) {
    assert.equal(isNativeCommand({ method: row.method, url: row.path + '?ignored=1' }), true);
    assert.strictEqual(
      row,
      require('../src/server/modules/cabinet/routes.cjs').routes.find(
        (original) => original.method === row.method && original.path === row.path,
      ),
    );
  }
  for (const [method, url] of [
    ['GET', '/api/cabinet'],
    ['POST', '/api/auth/logout'],
    ['POST', '/api/assistant/execute'],
    ['PATCH', '/api/cabinet/changes/extra'],
    ['PATCH', '/api/cabinet/%63hanges'],
  ])
    assert.equal(isNativeCommand({ method, url }), false);
  assert.equal(nativeCommandIsolation({ storageBackend: 'sqlite' }), false);
  assert.equal(nativeCommandIsolation({ storageBackend: 'postgres' }), false);
  assert.equal(
    nativeCommandIsolation({ storageBackend: 'postgres', postgresRevisionProfile: 2 }),
    true,
  );
  assert.equal(
    nativeCommandIsolation({
      storageBackend: 'postgres',
      postgresRevisionProfile: 2,
      nativeCommandIsolation: false,
    }),
    false,
  );
  assert.equal(
    nativeCommandIsolation({ storageBackend: 'sqlite', nativeCommandIsolation: true }),
    true,
  );
  assert.throws(() => nativeCommandIsolation({ nativeCommandIsolation: '1' }), /isolation/);
});

test('command channel projection performs no reconciliation and observes a later revocation and epoch', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE telegram_runtime(key TEXT PRIMARY KEY,value TEXT)');
    const set = db.prepare('INSERT OR REPLACE INTO telegram_runtime VALUES(?,?)');
    const key = 'notification-channel-state-v1';
    set.run(key, JSON.stringify({ max: { enabled: true, version: 'first' } }));
    const changes = () => db.prepare('SELECT total_changes() AS n').get().n;
    const before = changes();
    const channels = createNotificationChannelProjection({ db, open: JSON.parse });
    assert.equal(channels.enabled('max'), true);
    assert.equal(channels.version('max'), 'first');
    assert.equal(channels.enabled('telegram'), false);
    assert.equal(changes(), before, 'constructing and reading cannot cancel jobs or update epochs');
    set.run(key, JSON.stringify({ max: { enabled: false, version: 'revoked' } }));
    const revoked = changes();
    assert.equal(channels.enabled('max'), false);
    assert.equal(channels.version('max'), 'revoked');
    assert.equal(changes(), revoked);
  } finally {
    db.close();
  }
});

function privateRequest(
  endpoint,
  transportToken = endpoint.transportToken,
  requestPath = '/api/auth/session',
) {
  return new Promise((resolve, reject) => {
    const outgoing = http.get(
      {
        host: endpoint.host,
        port: endpoint.port,
        path: requestPath,
        headers: {
          host: '127.0.0.1:4174',
          'x-cartoteca-native-transport': transportToken,
          'x-cartoteca-native-address': '127.0.0.1',
          'x-cartoteca-native-port': '4174',
        },
      },
      (incoming) => {
        incoming.resume();
        incoming.once('end', () => resolve(incoming.statusCode));
      },
    );
    outgoing.once('error', reject);
  });
}

test(
  'one opt-in command PID has a different private capability; its death closes every owner without a replay',
  { timeout: 30000 },
  async (t) => {
    const f = await nativeIsolatedFixture(t);
    const children = [],
      heaps = [];
    const owner = await startNativeApplication({
      config: { ...f.config, nativeCommandIsolation: true },
      environment: {},
      spawn(file, args, options) {
        heaps.push(
          options.execArgv.find((argument) => argument.startsWith('--max-old-space-size=')),
        );
        const child = fork(file, args, {
          ...options,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        children.push(child);
        return child;
      },
    });
    try {
      const status = owner.stats();
      assert.equal(children.length, 3);
      assert.deepEqual(
        heaps,
        ['--max-old-space-size=256', '--max-old-space-size=768', '--max-old-space-size=768'],
        'manual commands retain the previous web save heap limit',
      );
      assert.equal(
        new Set([status.application.pid, status.background.pid, status.command.pid]).size,
        3,
      );
      assert.equal(status.command.role, 'command');
      assert.equal(
        await privateRequest(owner.commandEndpoint(), owner.endpoint().transportToken),
        403,
      );
      assert.equal(await privateRequest(owner.commandEndpoint()), 404);
      assert.equal(
        await privateRequest(
          owner.commandEndpoint(),
          owner.commandEndpoint().transportToken,
          '/api/assistant/config',
        ),
        404,
      );
      assert.equal(JSON.stringify(status).includes(owner.commandEndpoint().transportToken), false);
      const failed = once(owner, 'failed');
      children[2].kill('SIGKILL');
      await failed;
      await owner.close();
      assert.equal(children.length, 3, 'no automatic restart or write replay');
      assert.equal(owner.stats().application.exited, true);
      assert.equal(owner.stats().background.exited, true);
      assert.equal(owner.stats().command.exited, true);
      assert.throws(() => owner.commandEndpoint(), /unavailable/);
    } finally {
      await owner.close();
    }
  },
);

test('a command startup failure rejects readiness and confirms every already-owned sibling exit', async () => {
  const children = [];
  let sequence = 700;
  await assert.rejects(
    startNativeApplication({
      config: { production: false, nativeCommandIsolation: true },
      spawn() {
        const child = new EventEmitter();
        child.pid = sequence++;
        child.connected = true;
        child.send = (message, callback) => {
          callback?.();
          if (message === 'stop') {
            child.connected = false;
            process.nextTick(() => child.emit('exit', 0, null));
            return;
          }
          if (message.type !== 'start') return;
          child.start = message;
          process.nextTick(() =>
            child.emit('message', {
              ...message,
              type: message.role === 'command' ? 'failed' : 'ready',
              pid: child.pid,
              port: message.role === 'background' ? null : child.pid,
              backgroundActive: message.role === 'background',
              providers: observation(),
            }),
          );
        };
        child.kill = () => process.nextTick(() => child.emit('exit', null, 'SIGKILL'));
        children.push(child);
        return child;
      },
    }),
    /unavailable/,
  );
  assert.deepEqual(
    children.map((child) => child.start.role),
    ['background', 'web', 'command'],
  );
  assert.ok(children.every((child) => !child.connected));
});

test('command child uses the narrow composition even when provider and assistant options are enabled', async () => {
  const runtime = new EventEmitter(),
    server = new EventEmitter(),
    messages = [];
  let options,
    stopped = 0,
    updates = 0;
  runtime.connected = true;
  runtime.pid = 123;
  runtime.send = (message, callback) => {
    messages.push(message);
    callback?.();
  };
  server.backgroundStatus = () => ({ active: false });
  server.nativeProviderStatus = observation;
  server.updateNativeProviderStatus = () => {
    updates++;
  };
  server.address = () => ({ port: 12345 });
  server.listen = (_port, _host, callback) => callback();
  await runNativeApplicationChild(runtime, {
    createServer: () => {
      throw Error('Provider composition must not execute.');
    },
    createCommandServer: (value, providers) => {
      options = value;
      assert.deepEqual(providers, observation());
      return server;
    },
    createLifecycle: () => ({
      attach: () => true,
      stop: () => {
        stopped++;
      },
    }),
  });
  const start = {
    type: 'start',
    protocol: 'cartoteca-native-application-v1',
    role: 'command',
    nonce: 'synthetic',
    secret: 'a'.repeat(64),
    providers: observation(),
    config: {
      storageBackend: 'sqlite',
      production: false,
      assistantAppointmentSavingEnabled: true,
      maxEnabled: true,
    },
  };
  runtime.emit('message', start);
  await new Promise(setImmediate);
  assert.equal(options.processRole, 'web', 'no combined/background PG role authority');
  assert.equal(options.internalIngressSecret, start.secret);
  assert.equal(messages.at(-1).type, 'ready');
  assert.equal(messages.at(-1).role, 'command');
  assert.equal(messages.at(-1).backgroundActive, false);
  runtime.emit('message', { ...start, type: 'providers', nonce: 'wrong' });
  runtime.emit('message', { ...start, type: 'providers' });
  await new Promise(setImmediate);
  assert.equal(updates, 1, 'provider status accepts only the authenticated parent lifetime');
  assert.equal(stopped, 0);
  server.emit('close');
});
