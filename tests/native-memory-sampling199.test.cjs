const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createMemoryMailbox,
  sampleIsolateMemory,
  startMemorySampling,
} = require('../src/server/infrastructure/native-memory-observation.cjs');

function setup(t) {
  const actual = sampleIsolateMemory();
  const plan = { version: 1, identity: 'web', heapCeilingMiB: actual.heapSizeLimitBytes / 1048576 };
  let monotonic = 0;
  const memory = process.memoryUsage();
  let calls = 0;
  let broken = false;
  t.mock.timers.enable({ apis: ['setInterval'] });
  t.mock.method(process, 'memoryUsage', () => {
    calls++;
    if (broken) throw Error('Synthetic collection failure');
    return { ...memory, heapUsed: memory.heapUsed + calls };
  });
  const mailbox = createMemoryMailbox();
  const sampling = startMemorySampling(plan, mailbox, { now: () => monotonic });
  t.after(() => sampling.close());
  return {
    sampling,
    view: new BigInt64Array(mailbox),
    setNow: (value) => {
      monotonic = value;
    },
    breakCollector: (value) => {
      broken = value;
    },
    calls: () => calls,
  };
}

test('SQL reply bursts reuse telemetry until the monotonic one-second boundary', (t) => {
  const { sampling, view, setNow, calls } = setup(t);
  const startup = Array.from(view);
  assert.equal(calls(), 2, 'strict attestation and initial mailbox publication both remain');
  for (let n = 0; n < 10000; n++) assert.equal(sampling.publishIfDue(), null);
  setNow(999.999);
  assert.equal(sampling.publishIfDue(), null);
  assert.equal(calls(), 2);
  assert.deepEqual(Array.from(view), startup);
  setNow(1000);
  assert.ok(sampling.publishIfDue());
  assert.equal(calls(), 3);
  assert.ok(view[0] > startup[0]);
  assert.equal(sampling.publishIfDue(), null, 'a second reply at the same instant is cheap');
});

test('explicit publish and the interval remain forced while close clears only the timer', (t) => {
  const { sampling, setNow, calls } = setup(t);
  setNow(100);
  assert.ok(sampling.publish());
  assert.equal(calls(), 3);
  assert.equal(sampling.publishIfDue(), null);
  setNow(1099);
  assert.equal(sampling.publishIfDue(), null, 'forced collection resets the reply cadence');
  setNow(1100);
  assert.ok(sampling.publishIfDue());
  assert.equal(calls(), 4);
  // Even a due timer whose clock is unchanged must force a sample.
  t.mock.timers.tick(1000);
  assert.equal(calls(), 5);
  sampling.close();
  t.mock.timers.tick(5000);
  assert.equal(calls(), 5);
  assert.ok(sampling.publish(), 'the existing explicit publication contract is preserved');
  assert.equal(calls(), 6);
});

test('wall-clock changes do not turn SQL replies into additional memory scans', (t) => {
  let wall = 100000;
  t.mock.method(Date, 'now', () => wall);
  const { sampling, setNow, calls } = setup(t);
  wall += 24 * 60 * 60 * 1000;
  setNow(500);
  assert.equal(sampling.publishIfDue(), null);
  assert.equal(calls(), 2);
  wall = 50000;
  setNow(1000);
  assert.ok(sampling.publishIfDue());
  assert.equal(calls(), 3);
});

test('collector failure is nonfatal, retains valid counters, and does not retry on every SQL reply', (t) => {
  const { sampling, view, setNow, calls, breakCollector } = setup(t);
  const startup = Array.from(view);
  setNow(1000);
  breakCollector(true);
  assert.equal(sampling.publishIfDue(), null);
  assert.equal(calls(), 3);
  assert.deepEqual(Array.from(view), startup);
  for (let n = 0; n < 10000; n++) assert.equal(sampling.publishIfDue(), null);
  assert.equal(calls(), 3, 'failed attempts share the same bounded cadence');
  setNow(2000);
  breakCollector(false);
  assert.ok(sampling.publishIfDue());
  assert.equal(calls(), 4);
  assert.ok(view[0] > startup[0]);
});

test('startup mailbox mismatch stays fatal and an unmanaged process still has no sampler', (t) => {
  const actual = sampleIsolateMemory();
  const plan = { version: 1, identity: 'web', heapCeilingMiB: actual.heapSizeLimitBytes / 1048576 };
  assert.throws(() => startMemorySampling(plan, new SharedArrayBuffer(8)), {
    code: 'NATIVE_MEMORY_BUDGET_MISMATCH',
  });
  assert.equal(startMemorySampling(null, new SharedArrayBuffer(8)), null);
  assert.throws(
    () =>
      startMemorySampling(
        { ...plan, heapCeilingMiB: plan.heapCeilingMiB + 1 },
        createMemoryMailbox(),
      ),
    { code: 'NATIVE_MEMORY_BUDGET_MISMATCH' },
  );
});
