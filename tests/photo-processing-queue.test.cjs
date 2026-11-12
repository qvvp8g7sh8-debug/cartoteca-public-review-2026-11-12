const test = require('node:test');
const assert = require('node:assert/strict');
const { createProcessingQueue } = require('../src/server/infrastructure/photos/processing-queue.cjs');

test('photo processing has bounded concurrency, FIFO waiting and releases capacity after failure', async () => {
  const queue = createProcessingQueue({ concurrency: 1, capacity: 2, waitMs: 1000 });
  let finish; const calls = [];
  const first = queue.run(() => new Promise((resolve) => { calls.push('first'); finish = resolve; }));
  const second = queue.run(() => { calls.push('second'); throw Error('bad photo'); });
  const rejected = assert.rejects(second, /bad photo/);
  const third = queue.run(() => { calls.push('third'); return 'ok'; });
  await assert.rejects(queue.run(() => assert.fail('overflow must never execute')), (e) => e.status === 503 && e.retryAfter === 5);
  assert.deepEqual(queue.snapshot(), { active: 1, queued: 2, concurrency: 1, capacity: 2 });
  finish(); await first; await rejected; assert.equal(await third, 'ok');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['first', 'second', 'third']); assert.equal(queue.snapshot().active, 0);
});
test('expired waiting photo is removed and cannot execute later', async () => {
  const queue = createProcessingQueue({ concurrency: 1, capacity: 1, waitMs: 10 });
  let finish;
  const active = queue.run(() => new Promise((resolve) => { finish = resolve; }));
  await assert.rejects(queue.run(() => assert.fail('expired work must never run')), (e) => e.status === 503);
  assert.equal(queue.snapshot().queued, 0); finish(); await active;
  await new Promise((r) => setImmediate(r)); assert.equal(queue.snapshot().active, 0);
  assert.throws(() => createProcessingQueue({ concurrency: 0 }), /configuration/);
});
