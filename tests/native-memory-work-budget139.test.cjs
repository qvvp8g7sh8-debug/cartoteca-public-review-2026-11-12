const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createNativeMemoryWorkBudget,
} = require('../src/server/infrastructure/native-memory-work-budget.cjs');
const MiB = 1024 * 1024;
const tick = () => new Promise(setImmediate);
function budget(options = {}) {
  return createNativeMemoryWorkBudget({
    version: 1,
    maxBytes: 768 * MiB,
    queryBytes: 384 * MiB,
    commandBytes: 512 * MiB,
    maxPending: 32,
    waitMs: 5000,
    estimatedWorkingSet: true,
    rssHardCapClaim: false,
    ...options,
  });
}
test('a waiting heavy command owns the FIFO head even when a later query would fit', async () => {
  const b = budget(),
    first = await b.acquire('query');
  let command, follower;
  const commandReady = b.acquire('command').then((lease) => {
    command = lease;
  });
  const followerReady = b.acquire('query').then((lease) => {
    follower = lease;
  });
  await tick();
  assert.equal(command, undefined);
  assert.equal(follower, undefined, 'the free 384MiB cannot bypass the heavy FIFO head');
  assert.equal(b.stats().pending, 2);
  first.release();
  await commandReady;
  assert.equal(b.stats().usedBytes, 512 * MiB);
  assert.equal(follower, undefined);
  command.release();
  await followerReady;
  assert.equal(b.stats().usedBytes, 384 * MiB);
  follower.release();
  follower.release();
  assert.equal(b.stats().usedBytes, 0);
  assert.equal(b.stats().admitted, b.stats().released);
});
test('cancellation removes only waiting work and cannot return an active lease early', async () => {
  const b = budget(),
    abort = new AbortController(),
    held = await b.acquire('command', { signal: abort.signal });
  const waitingAbort = new AbortController();
  const pending = assert.rejects(b.acquire('query', { signal: waitingAbort.signal }), {
    status: 499,
    code: 'NATIVE_CANCELLED',
    outcomeUnknown: false,
  });
  abort.abort();
  waitingAbort.abort();
  await pending;
  assert.equal(b.stats().usedBytes, 512 * MiB);
  assert.equal(b.stats().pending, 0);
  held.release();
  assert.equal(b.stats().usedBytes, 0);
});
test('a bounded admission deadline refuses before work starts and leaves the active estimate charged', async () => {
  const b = budget({ waitMs: 20 }),
    held = await b.acquire('command');
  const pending = assert.rejects(b.acquire('query'), {
    status: 503,
    code: 'NATIVE_MEMORY_WORK_TIMEOUT',
    outcomeUnknown: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  await pending;
  assert.equal(b.stats().usedBytes, 512 * MiB);
  assert.equal(b.stats().timedOut, 1);
  assert.equal(b.stats().admitted, 1);
  held.release();
});
test('queue capacity and shutdown never clear active reservations', async () => {
  const b = budget({ maxPending: 1 }),
    held = await b.acquire('command');
  const pending = assert.rejects(b.acquire('command'), { code: 'NATIVE_MEMORY_WORK_CLOSED' });
  await assert.rejects(b.acquire('query'), {
    code: 'NATIVE_MEMORY_WORK_CAPACITY',
    outcomeUnknown: false,
  });
  b.close();
  await pending;
  assert.equal(b.stats().active, 1);
  assert.equal(b.stats().usedBytes, 512 * MiB);
  await assert.rejects(b.acquire('query'), { code: 'NATIVE_MEMORY_WORK_CLOSED' });
  held.release();
  assert.equal(b.stats().active, 0);
});
test('the increased profile admits the same weights without changing operation limits or inventing a RAM guarantee', async () => {
  const b = budget({ maxBytes: 1536 * MiB });
  const leases = await Promise.all([
    b.acquire('command'),
    b.acquire('command'),
    b.acquire('query'),
  ]);
  assert.equal(b.stats().usedBytes, 1408 * MiB);
  assert.equal(b.stats().estimatedWorkingSet, true);
  assert.equal(b.stats().rssHardCapClaim, false);
  leases.forEach((lease) => lease.release());
  b.close();
});
test('invalid or oversized operation weights fail before retaining state', async () => {
  assert.throws(() => budget({ queryBytes: 769 * MiB }), /Invalid/);
  const b = budget();
  await assert.rejects(b.acquire('foreign-owner'), /Invalid/);
  assert.equal(b.stats().usedBytes, 0);
});

test('a settled lease can only shrink and retains exact response ownership until release', async () => {
  const b = budget(),
    reply = await b.acquire('query');
  reply.reduceTo(32 * MiB);
  assert.equal(b.stats().usedBytes, 32 * MiB);
  assert.throws(() => reply.reduceTo(33 * MiB), /Invalid/);
  const manual = await b.acquire('command');
  assert.equal(b.stats().usedBytes, 544 * MiB);
  reply.release();
  reply.reduceTo(0);
  reply.release();
  assert.equal(b.stats().usedBytes, 512 * MiB);
  manual.release();
  assert.equal(b.stats().usedBytes, 0);
});
