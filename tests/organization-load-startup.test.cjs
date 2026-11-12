const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '../scripts/benchmark-organizations-server.cjs'), 'utf8');

function launcher(count) {
  const cluster = new EventEmitter(), process = new EventEmitter();
  let forks = 0;
  Object.assign(cluster, {
    isPrimary: true,
    workers: {},
    fork() { forks++; },
    disconnect(callback) { callback(); },
  });
  Object.assign(process, { env: { LOAD_WORKERS: String(count) }, exit() {} });
  const context = {
    process, console, setTimeout, clearTimeout,
    require(name) {
      if (name === 'node:cluster') return cluster;
      if (name === 'node:http') return { createServer: () => ({ listen() {}, close() {} }) };
      if (name === './benchmark-organizations-fixture.cjs') return { safe() {}, DATA: '/synthetic' };
      if (name === './benchmark-organizations-profile.cjs') return {
        loadProfile: () => ({ origin: 'http://synthetic', processRole: 'web' }),
        harnessIdentity: () => ({}), environmentIdentity: () => ({}),
      };
      return require(name);
    },
  };
  vm.runInNewContext(source, context);
  return { cluster, process, forks: () => forks };
}
test('synthetic launcher accepts 1/2/4/8 and awaits each distinct readiness before another fork', () => {
  for (const count of [1, 2, 4, 8]) {
    const app = launcher(count);
    assert.equal(app.forks(), 1);
    for (let id = 1; id <= count; id++) {
      app.cluster.emit('message', { id }, { ready: true });
      app.cluster.emit('message', { id }, { ready: true });
      assert.equal(app.forks(), Math.min(id + 1, count));
    }
  }
});
test('synthetic launcher does not create more workers after stop and rejects unsupported counts', () => {
  const app = launcher(8);
  app.process.emit('SIGTERM');
  app.cluster.emit('message', { id: 1 }, { ready: true });
  assert.equal(app.forks(), 1);
  for (const count of [0, 3, 5, 16, 'invalid']) assert.throws(() => launcher(count), /Invalid synthetic worker count/);
});
