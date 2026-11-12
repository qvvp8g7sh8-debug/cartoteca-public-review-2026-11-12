const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { createNativeExecutor } = require('../src/server/infrastructure/native-executor.cjs');
class FakeWorker extends EventEmitter {
  messages = [];
  terminateCalls = 0;
  postMessage(message, transfer) {
    this.messages.push(structuredClone(message, { transfer }));
  }
  terminate() {
    this.terminateCalls++;
    return Promise.resolve();
  }
  ready() {
    this.emit('message', { ready: true });
  }
  exit() {
    if (!this.exited) {
      this.exited = true;
      this.emit('exit', 0);
    }
  }
  reply(text = 'ok') {
    const body = Uint8Array.from(Buffer.from(text)).buffer;
    this.emit(
      'message',
      structuredClone(
        {
          id: this.messages.at(-1).id,
          result: { status: 200, headers: { 'content-type': 'application/json' }, body },
        },
        { transfer: [body] },
      ),
    );
  }
}
function fixture(t, options = {}) {
  const workers = [];
  const executor = createNativeExecutor({
    filename: path.resolve(__dirname, 'synthetic-native-worker.cjs'),
    maxPendingBytes: 64,
    maxRequestBytes: 32,
    maxResponseBytes: 32,
    maxRetainedBytes: 64,
    workerFactory() {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    ...options,
  });
  t.after(async () => {
    const closed = executor.close({ force: true });
    for (const worker of workers) worker.exit();
    await closed;
  });
  return { executor, workers };
}

test('ready warms every reader before admitting requests and close waits for actual exits', async (t) => {
  const f = fixture(t, { concurrency: 2 });
  let ready = false;
  const pending = f.executor.ready().then(() => {
    ready = true;
  });
  assert.equal(f.workers.length, 2);
  f.workers[0].ready();
  await Promise.resolve();
  assert.equal(ready, false);
  f.workers[1].ready();
  await pending;
  assert.equal(ready, true);
  let closed = false;
  const stopped = f.executor.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  f.workers[0].exit();
  await Promise.resolve();
  assert.equal(closed, false);
  f.workers[1].exit();
  await stopped;
  assert.equal(closed, true);
});

test('input ownership transfers once and only serialized response bytes are retained', async (t) => {
  const f = fixture(t),
    raw = Uint8Array.from([1, 2, 3]).buffer,
    metadata = { token: 'synthetic-private-token', accountId: 'A' };
  const pending = f.executor.run({ kind: 'query', payload: raw, metadata });
  assert.equal(raw.byteLength, 0);
  metadata.accountId = 'B';
  f.workers[0].ready();
  assert.deepEqual([...new Uint8Array(f.workers[0].messages[0].payload)], [1, 2, 3]);
  assert.equal(f.workers[0].messages[0].metadata.accountId, 'A');
  f.workers[0].reply('abc');
  const result = await pending;
  assert.equal(result.body.toString(), 'abc');
  assert.equal(f.executor.stats().inputBytes, 0);
  assert.equal(f.executor.stats().retainedBytes, 3);
  assert.doesNotMatch(JSON.stringify(f.executor.stats()), /private-token|accountId/);
  result.release();
  result.release();
  assert.equal(f.executor.stats().retainedBytes, 0);
});

test('a slow HTTP consumer retains output credit until explicit settlement release', async (t) => {
  const f = fixture(t, { maxRetainedBytes: 32 });
  const one = f.executor.run({ kind: 'query' });
  f.workers[0].ready();
  f.workers[0].reply('held');
  const first = await one;
  const two = f.executor.run({ kind: 'query' });
  assert.equal(f.workers[0].messages.length, 1);
  assert.equal(f.executor.stats().pending, 1);
  first.release();
  assert.equal(f.workers[0].messages.length, 2);
  f.workers[0].reply();
  (await two).release();
});

test('active read cancellation keeps permit and byte credit until actual worker exit and never retries', async (t) => {
  const f = fixture(t),
    abort = new AbortController();
  const pending = assert.rejects(
    f.executor.run({ kind: 'query', payload: Buffer.from('abc') }, { signal: abort.signal }),
    (error) => error.status === 499 && error.outcomeUnknown === false,
  );
  f.workers[0].ready();
  abort.abort();
  assert.equal(f.workers[0].terminateCalls, 1);
  assert.equal(f.executor.stats().active, 1);
  assert.equal(f.executor.stats().inputBytes, 3);
  assert.equal(f.executor.stats().reservedBytes, 32);
  f.workers[0].exit();
  await pending;
  assert.equal(f.executor.stats().active, 0);
  assert.equal(f.executor.stats().inputBytes, 0);
  assert.equal(f.executor.stats().started, 1);
  assert.equal(f.workers.length, 1);
});

test('mutating cancellation signals ownership but cannot release or force retry before settlement', async (t) => {
  const f = fixture(t),
    abort = new AbortController();
  const pending = assert.rejects(
    f.executor.run({ kind: 'mutation' }, { mutating: true, signal: abort.signal }),
    (error) => error.status === 499 && error.outcomeUnknown === true,
  );
  f.workers[0].ready();
  abort.abort();
  const request = f.workers[0].messages[0];
  assert.equal(Atomics.load(new Int32Array(request.cancel), 0), 1);
  assert.equal(f.workers[0].terminateCalls, 0);
  assert.equal(f.executor.stats().active, 1);
  f.workers[0].reply();
  await pending;
  assert.equal(f.executor.stats().started, 1);
  assert.equal(f.executor.stats().active, 0);
});

test('worker death reports unknown mutation outcome without replaying the command', async (t) => {
  const f = fixture(t);
  const pending = assert.rejects(
    f.executor.run({ kind: 'mutation' }, { mutating: true }),
    (error) => error.code === 'NATIVE_WORKER_EXIT' && error.outcomeUnknown === true,
  );
  f.workers[0].ready();
  f.workers[0].exit();
  await pending;
  assert.equal(f.workers.length, 1);
  assert.equal(f.executor.stats().started, 1);
  assert.equal(f.executor.stats().inputBytes, 0);
});

test('queued cancellation removes only waiting work and global input limits refuse before worker start', async (t) => {
  const f = fixture(t, { maxPending: 1 }),
    abort = new AbortController();
  const first = f.executor.run({ kind: 'query' });
  f.workers[0].ready();
  const waiting = assert.rejects(
    f.executor.run({ kind: 'query', payload: Buffer.alloc(3) }, { signal: abort.signal }),
    { status: 499 },
  );
  await assert.rejects(f.executor.run({ kind: 'query' }), { status: 503 });
  abort.abort();
  await waiting;
  assert.equal(f.executor.stats().active, 1);
  assert.equal(f.executor.stats().pending, 0);
  f.workers[0].reply();
  (await first).release();
});

test('soft affinity reuses an idle preferred reader but another idle reader handles overflow', async (t) => {
  const f = fixture(t, { concurrency: 2 });
  const warm = f.executor.ready();
  f.workers.forEach((worker) => worker.ready());
  await warm;
  const one = f.executor.run({ kind: 'query' }, { affinityKey: 'same-org' });
  const preferred = f.workers.find((worker) => worker.messages.length);
  const two = f.executor.run({ kind: 'query' }, { affinityKey: 'same-org' });
  assert.equal(f.workers.filter((worker) => worker.messages.length === 1).length, 2);
  f.workers.forEach((worker) => worker.reply());
  for (const result of await Promise.all([one, two])) result.release();
  const three = f.executor.run({ kind: 'query' }, { affinityKey: 'same-org' });
  assert.equal(preferred.messages.length, 2);
  preferred.reply();
  (await three).release();
});

test('metadata, request bytes and pooled input boundaries are bounded without sending neighboring bytes', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.executor.run({ kind: 'query', metadata: { huge: 'x'.repeat(32769) } }),
    TypeError,
  );
  await assert.rejects(f.executor.run({ kind: 'query', payload: Buffer.alloc(33) }), {
    status: 503,
  });
  const slab = Buffer.from('private:public:private'),
    publicPart = slab.subarray(8, 14);
  const pending = f.executor.run({ kind: 'query', payload: publicPart });
  f.workers[0].ready();
  assert.equal(Buffer.from(f.workers[0].messages[0].payload).toString(), 'public');
  assert.equal(slab.toString(), 'private:public:private');
  f.workers[0].reply();
  (await pending).release();
});

test('startup timeout rejects readiness while an unacknowledged worker still owns its physical slot', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { startupMs: 10 });
  const startupFailure = (error) =>
    error.code === 'NATIVE_STARTUP_TIMEOUT' &&
    error.status === 503 &&
    error.outcomeUnknown === false;
  const warm = assert.rejects(f.executor.ready(), startupFailure);
  assert.equal(f.workers.length, 1);
  t.mock.timers.tick(10);
  await warm;
  assert.equal(f.workers[0].terminateCalls, 1);
  assert.equal(f.executor.stats().workers, 1, 'a rejected warmup never pretends the worker exited');
  assert.equal(f.executor.stats().started, 0);
  await assert.rejects(
    f.executor.ready(),
    startupFailure,
    'another readiness waiter cannot hang behind an expired startup timer',
  );
  let closed = false;
  const closing = f.executor.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(f.executor.stats().workers, 1);
  f.workers[0].exit();
  await closing;
  assert.equal(f.executor.stats().workers, 0);
  assert.equal(closed, true);
});
