const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createFreshAssetStats199,
} = require('../src/server/infrastructure/postgres/fresh-asset-stats199.cjs');
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('prelaunch stat observations coalesce; a post-barrier caller cannot join launched IO', async () => {
  const scheduled = [],
    launched = [],
    old = deferred();
  let version = 1;
  const observer = createFreshAssetStats199({
    schedule: (job) => scheduled.push(job),
    lstat: async (file, options) => {
      const snapshot = version;
      launched.push({ file, bigint: options?.bigint === true, snapshot });
      if (snapshot === 1) await old.promise;
      return snapshot;
    },
  });
  const one = observer.read([{ path: 'key', bigint: true }]);
  const concurrent = observer.read([{ path: 'key', bigint: true }]);
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.equal(launched.length, 1);
  // This new API boundary occurs after the original observation was launched.
  version = 2;
  const afterBarrier = observer.read([{ path: 'key', bigint: true }]);
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.deepEqual(await afterBarrier, [2]);
  old.resolve();
  assert.deepEqual(await one, [1]);
  assert.deepEqual(await concurrent, [1]);
  assert.equal(launched.length, 2);
  const next = observer.read([{ path: 'key', bigint: true }]);
  scheduled.shift()();
  assert.deepEqual(await next, [2]);
  assert.equal(launched.length, 3, 'fulfilled observations are never retained');
  observer.close();
});

test('a batch preserves request order and bigint semantics, and splits bounded groups', async () => {
  const scheduled = [],
    calls = [];
  const observer = createFreshAssetStats199({
    schedule: (job) => scheduled.push(job),
    lstat: async (file, options) => {
      calls.push([file, options?.bigint === true]);
      return file + ':' + (options?.bigint === true);
    },
  });
  const request = Array.from({ length: 130 }, (_, n) => ({ path: String(n), bigint: n % 2 === 0 }));
  const result = observer.read(request);
  assert.equal(scheduled.length, 3);
  for (const launch of scheduled) launch();
  assert.deepEqual(
    await result,
    request.map((r) => r.path + ':' + r.bigint),
  );
  assert.equal(calls.length, 130);
  const mixed = observer.read([{ path: 'same' }, { path: 'same', bigint: true }, { path: 'same' }]);
  scheduled.at(-1)();
  assert.deepEqual(await mixed, ['same:false', 'same:true', 'same:false']);
  assert.equal(calls.length, 132);
  observer.close();
});

test('closing queued or in-flight observations rejects callers and cannot launch queued IO', async () => {
  const scheduled = [],
    gate = deferred();
  let calls = 0;
  const observer = createFreshAssetStats199({
    schedule: (job) => scheduled.push(job),
    lstat: async () => {
      calls++;
      await gate.promise;
      return 1;
    },
  });
  const inFlight = observer.read([{ path: 'one' }]);
  scheduled.shift()();
  const queued = observer.read([{ path: 'two' }]);
  const checks = [
    assert.rejects(inFlight, { status: 503 }),
    assert.rejects(queued, { status: 503 }),
  ];
  observer.close();
  scheduled.shift()();
  gate.resolve();
  await Promise.all(checks);
  assert.equal(calls, 1);
  await assert.rejects(observer.read([{ path: 'three' }]), { status: 503 });
});
