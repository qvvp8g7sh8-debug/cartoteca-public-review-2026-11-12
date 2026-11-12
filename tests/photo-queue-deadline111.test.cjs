const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createProcessingQueue,
} = require('../src/server/infrastructure/photos/processing-queue.cjs');
const turn = () => new Promise(setImmediate);
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test('delayed timer cannot start an expired photo waiter on active task microtask settlement, while a fresh next waiter proceeds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  const queue = createProcessingQueue({ concurrency: 1, capacity: 3, waitMs: 5, now: () => now });
  const gate = deferred(),
    started = [];
  const active = queue.run(() => {
    started.push('active');
    return gate.promise;
  });
  const expired = queue.run(() => assert.fail('expired queued photo must never open/decode'));
  const rejected = assert.rejects(
    expired,
    (error) => error.status === 503 && error.retryAfter === 5,
  );
  await turn();
  // Advance only the monotonic clock: model a delayed timer, without sleeping,
  // blocking the event loop or allowing MockTimers to execute its callback.
  now = 6;
  const fresh = queue.run(() => {
    started.push('fresh');
    return 'fresh result';
  });
  gate.resolve('active result');
  assert.equal(await active, 'active result');
  await rejected;
  assert.equal(await fresh, 'fresh result');
  await turn();
  assert.deepEqual(started, ['active', 'fresh']);
  assert.deepEqual(queue.snapshot(), { active: 0, queued: 0, concurrency: 1, capacity: 3 });
  t.mock.timers.tick(100);
  await turn();
  assert.deepEqual(started, ['active', 'fresh']);
});
for (const elapsed of [4, 5])
  test(`photo waiter uses strict absolute deadline at elapsed${elapsed}ms`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let now = 0,
      calls = 0;
    const queue = createProcessingQueue({ concurrency: 1, capacity: 1, waitMs: 5, now: () => now });
    const gate = deferred(),
      active = queue.run(() => gate.promise);
    const pending = queue.run(() => {
      calls++;
      return 'within deadline';
    });
    const result = elapsed === 5 ? assert.rejects(pending, { status: 503 }) : pending;
    now = elapsed;
    gate.resolve();
    await active;
    await result;
    await turn();
    assert.equal(calls, elapsed === 4 ? 1 : 0);
    assert.equal(queue.snapshot().active, 0);
    assert.equal(queue.snapshot().queued, 0);
  });
test('a timeout removes only waiting work; actual active work keeps its slot until settlement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  const queue = createProcessingQueue({ concurrency: 1, capacity: 1, waitMs: 5, now: () => now });
  const gate = deferred(),
    active = queue.run(() => gate.promise);
  const expired = queue.run(() => assert.fail('timer-expired task must release its captured work'));
  const rejected = assert.rejects(expired, { status: 503 });
  await turn();
  now = 5;
  t.mock.timers.tick(5);
  await rejected;
  assert.deepEqual(queue.snapshot(), { active: 1, queued: 0, concurrency: 1, capacity: 1 });
  gate.resolve();
  await active;
  await turn();
  assert.deepEqual(queue.snapshot(), { active: 0, queued: 0, concurrency: 1, capacity: 1 });
});
test('all eight expired waiters drain without executing work or losing the available slot', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  const queue = createProcessingQueue({ concurrency: 1, capacity: 8, waitMs: 5, now: () => now });
  const gate = deferred(),
    active = queue.run(() => gate.promise);
  const rejected = Array.from({ length: 8 }, () =>
    assert.rejects(
      queue.run(() => assert.fail('bounded expired queue must not execute')),
      { status: 503 },
    ),
  );
  await turn();
  now = 5;
  gate.resolve();
  await active;
  await Promise.all(rejected);
  await turn();
  assert.deepEqual(queue.snapshot(), { active: 0, queued: 0, concurrency: 1, capacity: 8 });
  assert.equal(await queue.run(() => 'recovered'), 'recovered');
  await turn();
  assert.equal(queue.snapshot().active, 0);
});
