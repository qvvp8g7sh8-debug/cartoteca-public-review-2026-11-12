const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setImmediate: turn } = require('node:timers/promises');
const { createIsolatedServer } = require('../src/server/application/isolated-server.cjs');
function ports() {
  const owner = new EventEmitter();
  let ownerClosed = 0,
    queryClosed = 0,
    queryStarted = 0,
    releaseReady,
    releaseExit;
  const ready = new Promise((r) => (releaseReady = r)),
    exit = new Promise((r) => (releaseExit = r));
  owner.providerStatus = () => ({
    providers: { telegram: { configured: false }, max: { configured: false } },
  });
  owner.stats = () => ({ state: 'ready' });
  owner.close = async () => {
    ownerClosed++;
  };
  const query = {
    ready() {
      queryStarted++;
      return ready;
    },
    close() {
      queryClosed++;
      return exit;
    },
  };
  return {
    owner,
    query,
    releaseReady,
    releaseExit,
    counts: () => ({ ownerClosed, queryClosed, queryStarted }),
  };
}
test('native startup and failed cleanup have separate finite deadlines without pretending the worker exited', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = ports();
  const rejected = assert.rejects(
    createIsolatedServer(
      { production: false },
      {
        startApplication: async () => f.owner,
        createExecutor: () => f.query,
        startupMs: 100,
        shutdownMs: 50,
      },
    ),
    (error) => error.code === 'NATIVE_STARTUP_CLEANUP_FAILED',
  );
  await turn();
  assert.equal(f.counts().queryStarted, 1);
  t.mock.timers.tick(100);
  await turn();
  assert.equal(f.counts().ownerClosed, 1);
  assert.equal(f.counts().queryClosed, 1);
  t.mock.timers.tick(50);
  await rejected;
  // Actual worker exit has not been fabricated by either elapsed deadline.
  f.releaseExit();
  await turn();
});
test('ordinary query startup rejection closes the state owner and propagates the original error', async () => {
  const f = ports(),
    original = Object.assign(Error('Synthetic native initialization refused'), {
      code: 'SYNTHETIC_INIT',
    });
  f.query.ready = () => Promise.reject(original);
  f.releaseExit();
  await assert.rejects(
    createIsolatedServer(
      { production: false },
      {
        startApplication: async () => f.owner,
        createExecutor: () => f.query,
      },
    ),
    (error) => error === original,
  );
  assert.equal(f.counts().ownerClosed, 1);
  assert.equal(f.counts().queryClosed, 1);
});
