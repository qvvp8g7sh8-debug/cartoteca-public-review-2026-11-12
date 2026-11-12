const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { startPostgresServer } = require('../scripts/start-postgres-server.cjs');
function fixture() {
  const server = new EventEmitter();
  server.isolationStatus = () => ({ ready: true });
  server.close = (callback) => {
    server.closed = true;
    server.emit('close');
    callback?.();
  };
  server.closeAllConnections = () => {
    server.connectionsClosed = true;
  };
  server.listen = () => {
    server.listenCalled = true;
  };
  let received;
  return {
    server,
    get received() {
      return received;
    },
    dependencies: {
      environment: { CARTOTECA_POSTGRES_READINESS_SOCKET: '/tmp/synthetic.sock' },
      configuration: () => ({ dataDir: '/synthetic', port: 4173, host: '127.0.0.1' }),
      createServer: async () => server,
      technicalReadiness: (status) => status,
      attachReadiness: async (_, options) => {
        received = options;
        return {
          close: async () => {
            server.readinessClosed = true;
          },
        };
      },
    },
  };
}
test('PostgreSQL entry attaches technical readiness to the same data before the caller listens', async () => {
  const f = fixture();
  assert.equal(await startPostgresServer({}, f.dependencies), f.server);
  assert.deepEqual(f.received, { socketPath: '/tmp/synthetic.sock', dataDir: '/synthetic' });
  assert.equal(f.server.localPort, 4173);
  assert.equal(f.server.listenCalled, undefined);
});
test('startup owner loss during asynchronous readiness rejects and closes instead of announcing readiness', async () => {
  const f = fixture();
  f.dependencies.attachReadiness = async () => {
    f.server.emit('backgroundError', Error('synthetic owner lost'));
    return {
      close: async () => {
        f.server.readinessClosed = true;
      },
    };
  };
  await assert.rejects(startPostgresServer({}, f.dependencies), /owner lost/);
  assert.equal(f.server.closed, true);
  assert.equal(f.server.readinessClosed, true);
  assert.equal(f.server.listenCalled, undefined);
});
test('initial incomplete executor readiness prevents even binding the readiness socket', async () => {
  const f = fixture();
  f.server.isolationStatus = () => ({ ready: false });
  let called = false;
  f.dependencies.attachReadiness = async () => {
    called = true;
  };
  await assert.rejects(startPostgresServer({}, f.dependencies), /not ready/);
  assert.equal(called, false);
  assert.equal(f.server.closed, true);
});
test('readiness attach failure closes all children through the existing server lifecycle', async () => {
  const f = fixture();
  f.dependencies.attachReadiness = async () => {
    throw Error('synthetic socket unavailable');
  };
  await assert.rejects(startPostgresServer({}, f.dependencies), /socket unavailable/);
  assert.equal(f.server.connectionsClosed, true);
  assert.equal(f.server.closed, true);
});
