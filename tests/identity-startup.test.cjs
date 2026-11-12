const test = require('node:test');
const assert = require('node:assert/strict');
const { createIdentityStartup } = require('../src/server/application/identity-startup.cjs');
const flush = () => new Promise(setImmediate);

test('identity startup retries failures with capped backoff and stops after success', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0,
    success = false;
  const startup = createIdentityStartup({
    initialize: async () => {
      calls++;
      if (calls === 1) throw Error('Synthetic transport failure');
      return { connected: success };
    },
  });
  await startup.start();
  assert.equal(calls, 1);
  for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    const before = calls;
    t.mock.timers.tick(delay - 1);
    await flush();
    assert.equal(calls, before);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(calls, before + 1);
  }
  success = true;
  t.mock.timers.tick(60000);
  await flush();
  const recovered = calls;
  t.mock.timers.tick(600000);
  startup.start();
  await flush();
  assert.equal(calls, recovered);
  startup.stop();
});

test('identity startup coalesces starts and aborts in-flight work without scheduling after close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0,
    signal,
    complete;
  const startup = createIdentityStartup({
    initialize: (value) => {
      calls++;
      signal = value;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
  });
  const pending = startup.start();
  assert.equal(startup.start(), pending);
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(600000);
  assert.equal(calls, 1);
  startup.stop();
  assert.equal(signal.aborted, true);
  complete({ connected: false });
  await pending;
  t.mock.timers.tick(600000);
  startup.start();
  await flush();
  assert.equal(calls, 1);
});

test('stopping identity startup clears an already scheduled retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const startup = createIdentityStartup({
    initialize: async () => (++calls, { connected: false }),
  });
  await startup.start();
  startup.stop();
  t.mock.timers.tick(600000);
  await flush();
  assert.equal(calls, 1);
});

test('closing before the initial microtask does not start a provider request', async () => {
  const startup = createIdentityStartup({ initialize: () => assert.fail('Closed before request') });
  const pending = startup.start();
  startup.stop();
  await pending;
});
