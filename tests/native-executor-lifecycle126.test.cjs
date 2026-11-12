const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { createNativeExecutor } = require('../src/server/infrastructure/native-executor.cjs');
const { technicalReadiness } = require('../src/server/infrastructure/postgres/readiness.cjs');

class ControlledWorker extends EventEmitter {
  messages = [];
  terminateCalls = 0;
  exited = false;
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
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', 0);
  }
  reply(text = 'owned output') {
    const body = Uint8Array.from(Buffer.from(text)).buffer;
    this.emit('message', {
      id: this.messages.at(-1).id,
      result: { status: 200, headers: {}, body },
    });
  }
}

function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let time = 0;
  const workers = [];
  const executor = createNativeExecutor({
    filename: path.join(__dirname, 'helpers/native-executor-worker.cjs'),
    concurrency: 2,
    maxPendingBytes: 64,
    maxRequestBytes: 32,
    maxResponseBytes: 32,
    maxRetainedBytes: 64,
    now: () => time,
    workerFactory() {
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker;
    },
    ...options,
  });
  t.after(async () => {
    const closed = executor.close({ force: true });
    workers.forEach((worker) => worker.exit());
    await closed;
  });
  return {
    executor,
    workers,
    advance(milliseconds) {
      time += milliseconds;
      t.mock.timers.tick(milliseconds);
    },
    async warm() {
      const ready = executor.ready();
      workers.forEach((worker) => worker.ready());
      await ready;
    },
  };
}

function technical(executor) {
  const child = (pid) => ({ ready: true, exited: false, pid });
  return technicalReadiness({
    closeState: 'open',
    owner: { state: 'ready', application: child(101), background: child(102) },
    queries: executor.stats(),
  });
}

test('a warmed pool replaces its final cancelled reader without a new query or readiness call', async (t) => {
  const f = fixture(t);
  await f.warm();
  const abort = new AbortController();
  const pending = assert.rejects(
    f.executor.run({ kind: 'query', payload: Buffer.from('raw') }, { signal: abort.signal }),
    { code: 'NATIVE_CANCELLED', status: 499 },
  );
  abort.abort();
  assert.equal(f.workers[0].terminateCalls, 1);
  assert.equal(f.executor.stats().inputBytes, 3);
  assert.equal(f.executor.stats().reservedBytes, 32);
  assert.equal(technical(f.executor).ready, false);
  f.workers[0].exit();
  await pending;
  assert.equal(f.executor.stats().inputBytes, 0);
  assert.equal(f.executor.stats().reservedBytes, 0);
  assert.equal(f.workers.length, 2, 'replacement waits for the bounded recovery backoff');
  f.advance(99);
  assert.equal(f.workers.length, 2);
  f.advance(1);
  assert.equal(f.workers.length, 3, 'quiet warm pool recreates its missing physical reader');
  assert.equal(technical(f.executor).ready, false, 'a newly constructed worker is not ready');
  f.workers[2].ready();
  assert.equal(technical(f.executor).ready, true);
  assert.equal(f.executor.stats().started, 1, 'the cancelled command was never replayed');
  assert.equal(f.workers[2].messages.length, 0);
});

test('rolling restart exhaustion resumes on one precise timer and keeps readiness false meanwhile', async (t) => {
  const f = fixture(t);
  await f.warm();
  f.workers[0].exit();
  f.advance(100);
  f.workers[2].ready();
  f.workers[1].exit();
  f.advance(100);
  f.workers[3].ready();
  f.workers[2].exit();
  f.advance(100);
  assert.equal(f.workers.length, 4);
  assert.equal(f.executor.stats().recovery.retryInMs, 29700);
  assert.equal(technical(f.executor).ready, false);
  await assert.rejects(f.executor.ready(), { code: 'NATIVE_START_CAPACITY' });
  f.advance(29699);
  assert.equal(f.workers.length, 4, 'watcher ticks cannot bypass the rolling four-attempt budget');
  f.advance(1);
  assert.equal(f.workers.length, 5, 'recovery requires no new external request at the boundary');
  f.workers[4].ready();
  assert.equal(technical(f.executor).ready, true);
  assert.equal(f.executor.stats().started, 0);
});

test('close clears recovery ownership and cannot spawn a quiet replacement after physical exits', async (t) => {
  const f = fixture(t);
  await f.warm();
  f.workers[0].exit();
  assert.equal(f.executor.stats().recovery.scheduled, true);
  const closing = f.executor.close();
  f.workers[1].exit();
  await closing;
  f.advance(60000);
  assert.equal(f.workers.length, 2);
  assert.equal(f.executor.stats().workers, 0);
  assert.deepEqual(f.executor.stats().recovery, {
    warmRequested: false,
    scheduled: false,
    retryInMs: 0,
  });
});

test('an initial startup timeout remains an error even when the desired warm pool later recovers', async (t) => {
  const f = fixture(t, { concurrency: 1, startupMs: 10 });
  const failed = assert.rejects(f.executor.ready(), { code: 'NATIVE_STARTUP_TIMEOUT' });
  f.advance(10);
  await failed;
  assert.equal(f.executor.stats().workers, 1, 'timeout does not fabricate physical exit');
  assert.equal(f.workers[0].terminateCalls, 1);
  f.workers[0].exit();
  f.advance(100);
  assert.equal(f.workers.length, 2);
  assert.equal(f.executor.stats().readyWorkers, 0);
  f.workers[1].ready();
  await f.executor.ready();
  assert.equal(f.executor.stats().readyWorkers, 1);
});

test('opt-in cooperative disconnect discards cancelled bytes and preserves the healthy reader', async (t) => {
  const f = fixture(t, { concurrency: 1, cancelGraceMs: 100, timeoutMs: 1000 });
  await f.warm();
  const abort = new AbortController();
  const pending = assert.rejects(
    f.executor.run({ kind: 'query', payload: Buffer.from('raw') }, { signal: abort.signal }),
    { code: 'NATIVE_CANCELLED', status: 499, outcomeUnknown: false },
  );
  abort.abort();
  assert.equal(Atomics.load(new Int32Array(f.workers[0].messages[0].cancel), 0), 1);
  assert.equal(f.workers[0].terminateCalls, 0);
  assert.equal(f.executor.stats().active, 1);
  assert.equal(f.executor.stats().inputBytes, 3);
  f.advance(99);
  f.workers[0].reply('cancelled clinical bytes');
  await pending;
  assert.equal(f.executor.stats().retainedBytes, 0);
  assert.equal(f.executor.stats().inputBytes, 0);
  assert.equal(f.executor.stats().readyWorkers, 1);
  const next = f.executor.run({ kind: 'query' });
  f.advance(1);
  assert.equal(f.workers[0].terminateCalls, 0, 'the old grace timer cannot kill a later command');
  f.workers[0].reply('independent command');
  const result = await next;
  assert.equal(result.body.toString(), 'independent command');
  result.release();
  assert.equal(f.workers.length, 1);
  assert.equal(f.executor.stats().started, 2);
});

test('a stuck disconnected read is force terminated after grace with credit held until actual exit', async (t) => {
  const f = fixture(t, { concurrency: 1, cancelGraceMs: 100, timeoutMs: 1000 });
  await f.warm();
  const abort = new AbortController();
  const pending = assert.rejects(
    f.executor.run({ kind: 'query', payload: Buffer.from('raw') }, { signal: abort.signal }),
    { code: 'NATIVE_CANCELLED' },
  );
  abort.abort();
  f.advance(99);
  assert.equal(f.workers[0].terminateCalls, 0);
  f.advance(1);
  assert.equal(f.workers[0].terminateCalls, 1);
  assert.equal(f.executor.stats().active, 1);
  assert.equal(f.executor.stats().inputBytes, 3);
  assert.equal(f.executor.stats().reservedBytes, 32);
  f.workers[0].exit();
  await pending;
  assert.equal(f.executor.stats().active, 0);
  assert.equal(f.executor.stats().inputBytes, 0);
  assert.equal(f.executor.stats().reservedBytes, 0);
  assert.equal(f.executor.stats().started, 1);
});

test('disconnect grace is capped by the original absolute request deadline', async (t) => {
  const f = fixture(t, { concurrency: 1, cancelGraceMs: 100, timeoutMs: 50 });
  await f.warm();
  const abort = new AbortController();
  const pending = assert.rejects(f.executor.run({ kind: 'query' }, { signal: abort.signal }), {
    code: 'NATIVE_CANCELLED',
  });
  f.advance(20);
  abort.abort();
  f.advance(29);
  assert.equal(f.workers[0].terminateCalls, 0);
  f.advance(1);
  assert.equal(f.workers[0].terminateCalls, 1, 'grace cannot move the 50ms original deadline');
  assert.equal(f.executor.stats().active, 1);
  f.workers[0].exit();
  await pending;
});

test('native request timeout forces a read immediately even when disconnect grace is enabled', async (t) => {
  const f = fixture(t, { concurrency: 1, cancelGraceMs: 100, timeoutMs: 50 });
  await f.warm();
  const pending = assert.rejects(f.executor.run({ kind: 'query' }), {
    code: 'NATIVE_TIMEOUT',
    status: 503,
  });
  f.advance(50);
  assert.equal(f.workers[0].terminateCalls, 1);
  assert.equal(f.executor.stats().active, 1);
  f.workers[0].exit();
  await pending;
  assert.equal(f.executor.stats().timedOut, 1);
});

test('disconnect grace does not force terminate or replay a mutation after its deadline', async (t) => {
  const f = fixture(t, { concurrency: 1, cancelGraceMs: 100, timeoutMs: 50 });
  await f.warm();
  const abort = new AbortController();
  const pending = assert.rejects(
    f.executor.run({ kind: 'mutation' }, { signal: abort.signal, mutating: true }),
    { code: 'NATIVE_CANCELLED', outcomeUnknown: true },
  );
  abort.abort();
  f.advance(1000);
  assert.equal(f.workers[0].terminateCalls, 0);
  assert.equal(f.executor.stats().active, 1);
  assert.equal(f.executor.stats().started, 1);
  f.workers[0].reply();
  await pending;
  assert.equal(f.executor.stats().retainedBytes, 0);
});
