const test = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const { nativeIsolatedFixture } = require('./helpers/native-isolated-fixture.cjs');
const {
  startNativeApplication,
  providerSnapshot,
} = require('../src/server/infrastructure/native-application.cjs');

function recorder() {
  const children = [],
    output = [];
  return {
    children,
    output,
    spawn(filename, args, options) {
      const child = fork(filename, args, { ...options, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', (bytes) => {
          if (output.length < 100) output.push(bytes.toString());
        });
      children.push(child);
      return child;
    },
  };
}
function request(endpoint, authenticated) {
  return new Promise((resolve, reject) => {
    const headers = { host: '127.0.0.1:4174' };
    if (authenticated)
      Object.assign(headers, {
        'x-cartoteca-native-transport': endpoint.transportToken,
        'x-cartoteca-native-address': '127.0.0.1',
        'x-cartoteca-native-port': '4174',
      });
    const outgoing = http.request(
      { hostname: endpoint.host, port: endpoint.port, path: '/login.html', headers },
      (incoming) => {
        let bytes = 0;
        incoming.on('data', (value) => {
          bytes += value.length;
        });
        incoming.on('end', () => resolve({ status: incoming.statusCode, bytes }));
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

test('provider snapshot excludes arbitrary payload and preserves the exact non-secret readiness fields', () => {
  const snapshot = providerSnapshot({
    telegram: {
      configured: true,
      connected: true,
      username: 'Synthetic_bot',
      botId: '123',
      error: 'PRIVATE',
      token: 'PRIVATE',
    },
    providers: {
      telegram: { configured: true, connected: true, botId: '123' },
      max: { configured: true, connected: true, botId: '456' },
    },
    patient: 'PRIVATE',
  });
  assert.equal(snapshot.providers.max.botId, '456');
  assert.equal(snapshot.telegram.error, 'Telegram temporarily unavailable.');
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE'), false);
});

test(
  'native local profile has one web owner and one background PID, private ingress and finite idempotent close',
  { timeout: 30000 },
  async (t) => {
    const f = await nativeIsolatedFixture(t),
      captured = recorder();
    const owner = await startNativeApplication({
      config: f.config,
      environment: {},
      spawn: captured.spawn,
    });
    try {
      const status = owner.stats(),
        endpoint = owner.endpoint();
      assert.equal(status.state, 'ready');
      assert.equal(status.application.role, 'web');
      assert.equal(status.background.role, 'background');
      assert.notEqual(status.application.pid, status.background.pid);
      assert.notEqual(status.application.pid, process.pid);
      assert.equal(captured.children.length, 2, 'no automatic multi-web cluster');
      assert.equal((await request(endpoint, false)).status, 403);
      assert.equal((await request(endpoint, true)).status, 200);
      assert.equal(JSON.stringify(status).includes(endpoint.transportToken), false);
      assert.equal(captured.output.join('').includes(endpoint.transportToken), false);
      assert.equal(owner.providerStatus().providers.max.configured, false);
    } finally {
      await owner.close();
    }
    await owner.close();
    assert.equal(owner.stats().state, 'closed');
    assert.equal(owner.stats().application.exited, true);
    assert.equal(owner.stats().background.exited, true);
  },
);

test(
  'death of either owned role stops the sibling without restarting or replaying requests',
  { timeout: 30000 },
  async (t) => {
    const f = await nativeIsolatedFixture(t),
      captured = recorder();
    const owner = await startNativeApplication({
      config: f.config,
      environment: {},
      spawn: captured.spawn,
    });
    try {
      const failure = once(owner, 'failed');
      captured.children[0].kill('SIGKILL');
      await failure;
      await owner.close();
      assert.equal(captured.children.length, 2, 'a stateful owner is not transparently restarted');
      assert.equal(owner.stats().application.exited, true);
      assert.equal(owner.stats().background.exited, true);
      assert.throws(() => owner.endpoint(), /unavailable/);
    } finally {
      await owner.close();
    }
  },
);

test(
  'failed prepared-schema startup stops every owned process before rejecting',
  { timeout: 15000 },
  async (t) => {
    const f = await nativeIsolatedFixture(t),
      captured = recorder();
    await assert.rejects(
      startNativeApplication({
        config: { ...f.config, notificationSchema: 19 },
        environment: {},
        spawn: captured.spawn,
        startupTimeoutMs: 3000,
        shutdownTimeoutMs: 1000,
        killGraceMs: 1000,
      }),
      /unavailable/,
    );
    assert.equal(
      captured.children.length,
      1,
      'web cannot start after failed background preparation',
    );
    assert.ok(
      captured.children.every((child) => child.exitCode !== null || child.signalCode !== null),
    );
  },
);

test('local-only and nonserializable startup options reject before creating any process', async () => {
  let started = 0;
  const spawn = () => {
    started++;
    throw Error('not expected');
  };
  await assert.rejects(
    startNativeApplication({ config: { production: true }, spawn }),
    /local profile/,
  );
  await assert.rejects(
    startNativeApplication({ config: { production: false, callback() {} }, spawn }),
    /serializable/,
  );
  assert.equal(started, 0);
});

test('a private listener startup error is observed and closes its owned lifecycle', async () => {
  const { EventEmitter } = require('node:events');
  const {
    runNativeApplicationChild,
  } = require('../src/server/infrastructure/native-application-child.cjs');
  const runtime = new EventEmitter(),
    server = new EventEmitter(),
    messages = [],
    stopped = [];
  runtime.connected = true;
  runtime.pid = 123;
  runtime.send = (message, callback) => {
    messages.push(message);
    callback?.();
  };
  server.nativeProviderStatus = () => ({ telegram: {}, providers: {} });
  server.telegramRuntime = { status: () => ({ configured: false }) };
  server.listen = () => server.emit('error', Error('synthetic private-listen failure'));
  await runNativeApplicationChild(runtime, {
    createServer: async () => server,
    createLifecycle: () => ({
      attach: () => true,
      stop: (code) => {
        stopped.push(code);
        server.emit('close');
      },
    }),
  });
  runtime.emit('message', {
    type: 'start',
    protocol: 'cartoteca-native-application-v1',
    nonce: 'synthetic',
    role: 'web',
    secret: 'a'.repeat(64),
    config: { production: false, telegramIdentityAutostart: false },
  });
  await new Promise(setImmediate);
  assert.deepEqual(stopped, [1]);
  assert.equal(messages.at(-1).code, 'NATIVE_LISTENER_FAILED');
  assert.equal(
    messages.some((message) => message.type === 'ready'),
    false,
  );
});
