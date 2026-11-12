const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createPostgresServer } = require('../src/server/application/postgres-server.cjs');
const options = {
  storageBackend: 'postgres',
  postgresProfile: 'production-v1',
  postgresAllowedHosts: ['postgres'],
  postgres: {
    host: 'postgres',
    port: 5432,
    database: 'synthetic',
    user: 'cartoteca_app',
    password: 'synthetic-only-password',
  },
  production: true,
  origin: 'https://synthetic.test',
  host: '0.0.0.0',
  releaseGate: true,
};
function fixture() {
  const server = new EventEmitter(),
    seen = [];
  let held = false;
  server.isolationStatus = () => ({ closeState: server.closed ? 'closed' : 'open' });
  server.close = (callback) => {
    server.closed = true;
    server.emit('close');
    callback?.();
  };
  const dependencies = {
    environment: {},
    acquireAuthority: async () => {
      held = true;
      return {
        get state() {
          return held ? 'held' : 'lost';
        },
        release: async () => {
          held = false;
        },
      };
    },
    prepare: async (config) => {
      seen.push(config.postgresRevisionProfile);
      return { ...config, postgresRevisionProfile: held ? 3 : 2 };
    },
    createServer: async (config) => {
      server.config = config;
      return server;
    },
  };
  return { server, dependencies, seen };
}
test('guarded startup refreshes a derived v2 profile to v3 rather than treating it as an operator pin', async () => {
  const f = fixture();
  const server = await createPostgresServer(options, f.dependencies);
  assert.deepEqual(f.seen, [undefined, undefined]);
  assert.equal(server.config.postgresRevisionProfile, 3);
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
test('guarded startup preserves a profile explicitly pinned by the operator', async () => {
  const f = fixture();
  const server = await createPostgresServer(
    { ...options, postgresRevisionProfile: 3 },
    f.dependencies,
  );
  assert.deepEqual(f.seen, [3, 3]);
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
