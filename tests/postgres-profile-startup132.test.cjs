const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createPostgresServer } = require('../src/server/application/postgres-server.cjs');
const config = {
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
  const server = new EventEmitter();
  server.isolationStatus = () => ({ closeState: server.closed ? 'closed' : 'open' });
  server.close = (callback) => {
    server.closed = true;
    server.emit('close');
    callback?.();
  };
  const state = { held: false, releases: 0, calls: [] };
  return {
    server,
    state,
    dependencies: {
      environment: {},
      acquireAuthority: async () => {
        state.held = true;
        state.calls.push('guardian');
        return {
          get state() {
            return state.held ? 'held' : 'lost';
          },
          release: async () => {
            if (!state.released) state.releases++;
            state.released = true;
          },
        };
      },
      createServer: async (options) => {
        state.calls.push('children');
        state.received = options;
        return server;
      },
    },
  };
}
test('gateway resolves the executor profile again under lifetime authority after an offline transition', async () => {
  const f = fixture();
  f.dependencies.prepare = async (options) => {
    f.state.calls.push(f.state.held ? 'guarded-profile' : 'initial-profile');
    return {
      ...options,
      ...(f.state.held ? { postgresRevisionProfile: 2 } : {}),
      releaseGate: false,
    };
  };
  const server = await createPostgresServer(config, f.dependencies);
  assert.deepEqual(f.state.calls, ['initial-profile', 'guardian', 'guarded-profile', 'children']);
  assert.equal(f.state.received.postgresRevisionProfile, 2);
  assert.equal(f.state.received.releaseGate, true);
  await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  assert.equal(f.state.releases, 1);
});
test('authority loss during the guarded profile read prevents every child from starting', async () => {
  const f = fixture();
  f.dependencies.prepare = async (options) => {
    if (f.state.held) f.state.held = false;
    return options;
  };
  await assert.rejects(createPostgresServer(config, f.dependencies), /authority is unavailable/);
  assert.equal(f.state.calls.includes('children'), false);
});
test('a failed guarded profile read does not admit a gateway with stale metadata', async () => {
  const f = fixture();
  f.dependencies.prepare = async (options) => {
    if (f.state.held) throw Error('Synthetic changed profile');
    return options;
  };
  await assert.rejects(createPostgresServer(config, f.dependencies), /changed profile/);
  assert.equal(f.state.calls.includes('children'), false);
});
