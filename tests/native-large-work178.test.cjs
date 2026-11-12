const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createNativeMemoryWorkBudget,
} = require('../src/server/infrastructure/native-memory-work-budget.cjs');
const {
  createNativeMemoryBudget,
} = require('../src/server/infrastructure/native-memory-budget.cjs');
const MiB = 1024 * 1024;
const tick = () => new Promise(setImmediate);
function budget() {
  const plan = createNativeMemoryBudget({
    budgetMiB: 4096,
    commandCount: 4,
    postgres: true,
    queryConcurrency: 6,
  });
  assert.equal(plan.workAdmission.maxBytes, 3008 * MiB);
  return createNativeMemoryWorkBudget(plan.workAdmission);
}

test('178 work admission accounts beyond signed32 bits exactly and retains FIFO head ownership', async () => {
  const b = budget();
  const initial = await Promise.all([
    ...Array.from({ length: 4 }, () => b.acquire('command')),
    ...Array.from({ length: 10 }, () => b.acquire('query-probe')),
  ]);
  assert.equal(b.stats().usedBytes, 3008 * MiB);
  assert.ok(b.stats().usedBytes > 2 ** 31);
  assert.equal(Number.isSafeInteger(b.stats().usedBytes), true);
  let heavy, follower;
  const nextHeavy = b.acquire('command').then((lease) => {
    heavy = lease;
  });
  const nextFollower = b.acquire('query-probe').then((lease) => {
    follower = lease;
  });
  await tick();
  assert.equal(b.stats().pendingBytes, 608 * MiB);
  assert.equal(b.stats().pending, 2);
  initial[4].release();
  await tick();
  assert.equal(b.stats().usedBytes, 2912 * MiB);
  assert.equal(heavy, undefined);
  assert.equal(follower, undefined, 'free96MiB cannot jump a waiting512MiB command');
  for (const index of [5, 6, 7, 8]) initial[index].release();
  await tick();
  assert.equal(b.stats().usedBytes, 2528 * MiB);
  assert.equal(heavy, undefined);
  initial[9].release();
  await nextHeavy;
  assert.equal(b.stats().usedBytes, 2944 * MiB);
  assert.equal(follower, undefined);
  heavy.release();
  await nextFollower;
  assert.equal(b.stats().usedBytes, 2528 * MiB);
  for (const lease of initial) lease.release();
  follower.release();
  follower.release();
  assert.equal(b.stats().usedBytes, 0);
  assert.equal(b.stats().pendingBytes, 0);
  assert.equal(b.stats().active, 0);
  assert.equal(b.stats().admitted, b.stats().released);
  b.close();
});

test('178 cancellation and shutdown never return an active greater-than2GiB lease early', async () => {
  const b = budget();
  const held = await b.acquire('command-exclusive');
  assert.equal(b.stats().usedBytes, 3008 * MiB);
  const abort = new AbortController();
  const cancelled = assert.rejects(b.acquire('command', { signal: abort.signal }), {
    status: 499,
    code: 'NATIVE_CANCELLED',
    outcomeUnknown: false,
  });
  abort.abort();
  await cancelled;
  assert.equal(b.stats().usedBytes, 3008 * MiB);
  const closed = assert.rejects(b.acquire('query'), { code: 'NATIVE_MEMORY_WORK_CLOSED' });
  b.close();
  await closed;
  assert.equal(b.stats().usedBytes, 3008 * MiB);
  assert.equal(b.stats().active, 1);
  held.reduceTo(2 ** 31 + 1);
  assert.equal(b.stats().usedBytes, 2147483649);
  for (const invalid of [2 ** 31 + 2, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => held.reduceTo(invalid));
  assert.equal(b.stats().usedBytes, 2147483649);
  held.release();
  held.release();
  assert.equal(b.stats().usedBytes, 0);
  assert.equal(b.stats().active, 0);
  await assert.rejects(b.acquire('command'), { code: 'NATIVE_MEMORY_WORK_CLOSED' });
});
