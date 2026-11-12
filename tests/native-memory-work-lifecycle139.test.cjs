const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const {
  createNativeMemoryWorkBudget,
} = require('../src/server/infrastructure/native-memory-work-budget.cjs');
const { createNativeExecutor } = require('../src/server/infrastructure/native-executor.cjs');
const { createNativeCommandProxy } = require('../src/server/http/native-command-proxy.cjs');
const MiB = 1024 * 1024;
const tick = () => new Promise(setImmediate);
function budget() {
  return createNativeMemoryWorkBudget({
    version: 1,
    maxBytes: 768 * MiB,
    queryBytes: 384 * MiB,
    commandBytes: 512 * MiB,
    maxPending: 32,
    waitMs: 5000,
    estimatedWorkingSet: true,
    rssHardCapClaim: false,
  });
}
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
  reply() {
    this.emit('message', {
      id: this.messages.at(-1).id,
      result: { status: 200, headers: {}, body: Uint8Array.from([1, 2, 3]).buffer },
    });
  }
  exit() {
    if (!this.exited) {
      this.exited = true;
      this.emit('exit', 0);
    }
  }
}
function executorFixture(t, b, options = {}) {
  const workers = [];
  const executor = createNativeExecutor({
    filename: path.join(__dirname, 'helpers/native-executor-worker.cjs'),
    concurrency: 2,
    workBudget: b,
    workerFactory() {
      const w = new ControlledWorker();
      workers.push(w);
      return w;
    },
    ...options,
  });
  t.after(async () => {
    const closed = executor.close({ force: true });
    workers.forEach((w) => w.exit());
    await closed;
    b.close();
  });
  return {
    executor,
    workers,
    async warm() {
      const ready = executor.ready();
      workers.forEach((w) => w.ready());
      await ready;
    },
  };
}
test('settled query work reduces to exact retained bytes so slow readers cannot monopolize command admission', async (t) => {
  const b = budget(),
    f = executorFixture(t, b);
  await f.warm();
  const first = f.executor.run({ kind: 'query' }),
    second = f.executor.run({ kind: 'query' });
  await tick();
  assert.equal(f.executor.stats().started, 2);
  assert.equal(b.stats().usedBytes, 768 * MiB);
  let commandAdmitted = false;
  const command = b.acquire('command').then((lease) => {
    commandAdmitted = true;
    return lease;
  });
  await tick();
  assert.equal(commandAdmitted, false);
  f.workers[0].reply();
  f.workers[1].reply();
  const replies = await Promise.all([first, second]),
    manual = await command;
  assert.equal(f.executor.stats().retainedBytes, 6);
  assert.equal(b.stats().usedBytes, 512 * MiB + 6);
  assert.equal(b.stats().active, 3, 'both retained bodies remain individually owned');
  replies[0].release();
  replies[0].release();
  assert.equal(b.stats().usedBytes, 512 * MiB + 3);
  replies[1].release();
  manual.release();
  assert.equal(b.stats().usedBytes, 0);
});
test('a query canceled before admission never posts work to a reader', async (t) => {
  const b = budget(),
    blocker = await b.acquire('command'),
    f = executorFixture(t, b);
  await f.warm();
  const abort = new AbortController();
  const failed = assert.rejects(f.executor.run({ kind: 'query' }, { signal: abort.signal }), {
    code: 'NATIVE_CANCELLED',
    outcomeUnknown: false,
  });
  abort.abort();
  await failed;
  await tick();
  assert.equal(f.executor.stats().started, 0);
  assert.equal(
    f.workers.reduce((n, w) => n + w.messages.length, 0),
    0,
  );
  assert.equal(b.stats().usedBytes, 512 * MiB);
  blocker.release();
});
test('an active canceled query with a late reply keeps its reservation until actual worker exit', async (t) => {
  const b = budget(),
    f = executorFixture(t, b, { concurrency: 1 });
  await f.warm();
  const abort = new AbortController();
  const failed = assert.rejects(f.executor.run({ kind: 'query' }, { signal: abort.signal }), {
    code: 'NATIVE_CANCELLED',
  });
  await tick();
  abort.abort();
  assert.equal(f.workers[0].terminateCalls, 1);
  f.workers[0].reply();
  await failed;
  assert.equal(
    b.stats().usedBytes,
    384 * MiB,
    'a reply cannot acknowledge pending physical termination',
  );
  f.workers[0].exit();
  assert.equal(b.stats().usedBytes, 0);
  assert.equal(f.executor.stats().started, 1);
});
test('a reply during pending termination cannot shrink work until exit and then retains only its bytes', async (t) => {
  const b = budget(),
    f = executorFixture(t, b, { concurrency: 1 });
  await f.warm();
  const pending = f.executor.run({ kind: 'query' });
  await tick();
  f.workers[0].emit('error', Error('reader failed'));
  f.workers[0].reply();
  const reply = await pending;
  assert.equal(b.stats().usedBytes, 384 * MiB);
  f.workers[0].exit();
  assert.equal(b.stats().usedBytes, 3);
  reply.release();
  assert.equal(b.stats().usedBytes, 0);
});
test('a query deadline cannot return capacity while termination is still unacknowledged', async (t) => {
  const b = budget(),
    f = executorFixture(t, b, { concurrency: 1, timeoutMs: 20 });
  await f.warm();
  const failed = assert.rejects(f.executor.run({ kind: 'query' }), { code: 'NATIVE_TIMEOUT' });
  await new Promise((resolve) => setTimeout(resolve, 55));
  assert.equal(f.workers[0].terminateCalls, 1);
  assert.equal(b.stats().usedBytes, 384 * MiB);
  f.workers[0].exit();
  await failed;
  assert.equal(b.stats().usedBytes, 0);
});
test('reader startup exhaustion never reserves work before physical readiness', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = 0;
  const b = budget(),
    f = executorFixture(t, b, { concurrency: 1, now: () => now });
  const failed = assert.rejects(f.executor.run({ kind: 'query' }), {
    code: 'NATIVE_START_CAPACITY',
    outcomeUnknown: false,
  });
  await tick();
  assert.equal(b.stats().usedBytes, 0);
  assert.equal(b.stats().admitted, 0);
  for (let i = 0; i < 4; i++) {
    f.workers[i].exit();
    if (i < 3) {
      now += 100;
      t.mock.timers.tick(100);
    }
  }
  await failed;
  assert.equal(f.executor.stats().started, 0);
  assert.equal(b.stats().usedBytes, 0);
});
function commandFixture(b, options = {}) {
  const calls = [],
    leases = [];
  let reserves = 0;
  const proxy = createNativeCommandProxy({
    workBudget: b,
    ownerCount: 1,
    endpoint: () => ({}),
    reserve() {
      reserves++;
      let complete, fail;
      const completed = new Promise((resolve, reject) => {
        complete = resolve;
        fail = reject;
      });
      leases.push({ complete, fail });
      return { ready: Promise.resolve(), completed, cancel() {} };
    },
    createProxy: () => ({
      run() {
        return new Promise((resolve, reject) => calls.push({ resolve, reject }));
      },
      close() {},
      stats: () => ({}),
    }),
    ...options,
  });
  function run() {
    const req = new EventEmitter(),
      res = new EventEmitter();
    req.pause = () => {};
    const result = proxy.run(req, res);
    return { req, res, result };
  }
  return { proxy, calls, leases, run, reserves: () => reserves };
}
test('manual admission precedes every owner ticket and keeps an unforwarded body paused', async () => {
  const b = budget(),
    blocker = await b.acquire('query'),
    f = commandFixture(b),
    request = f.run();
  const failed = assert.rejects(request.result, { status: 499 });
  await tick();
  assert.equal(f.reserves(), 0);
  assert.equal(f.calls.length, 0);
  request.req.aborted = true;
  request.req.emit('aborted');
  await failed;
  assert.equal(f.reserves(), 0);
  blocker.release();
  f.proxy.close();
  b.close();
});
test('a manual response ending does not free work or its one owner before handler completion', async () => {
  const b = budget(),
    f = commandFixture(b),
    first = f.run();
  await tick();
  let admitted = false;
  const query = b.acquire('query').then((lease) => {
    admitted = true;
    return lease;
  });
  f.calls[0].resolve();
  await first.result;
  await tick();
  assert.equal(f.proxy.stats().active, 1);
  assert.equal(admitted, false);
  assert.equal(b.stats().usedBytes, 512 * MiB);
  f.leases[0].complete();
  const lease = await query;
  lease.release();
  f.proxy.close();
  b.close();
});
test('rejected command completion waits for proven physical closure and never retries another owner', async () => {
  const b = budget();
  let physicallyClosed;
  const closure = new Promise((resolve) => {
    physicallyClosed = resolve;
  });
  const f = commandFixture(b, { physicalClosed: () => closure }),
    first = f.run();
  await tick();
  f.calls[0].reject(Object.assign(Error('unknown'), { outcomeUnknown: true }));
  await assert.rejects(first.result, { outcomeUnknown: true });
  f.leases[0].fail(Error('owner closing'));
  await tick();
  assert.equal(b.stats().usedBytes, 512 * MiB);
  assert.equal(f.proxy.stats().active, 1);
  physicallyClosed();
  await tick();
  assert.equal(b.stats().usedBytes, 0);
  assert.equal(f.reserves(), 1);
  f.proxy.close();
  b.close();
});

test('unconfirmed physical command closure stays charged even after proxy and budget shutdown', async () => {
  const b = budget(),
    f = commandFixture(b, { physicalClosed: () => Promise.reject(Error('exit unconfirmed')) });
  const first = f.run();
  await tick();
  f.calls[0].reject(Object.assign(Error('unknown'), { outcomeUnknown: true }));
  await assert.rejects(first.result, { outcomeUnknown: true });
  f.leases[0].fail(Error('owner failed'));
  await tick();
  f.proxy.close();
  b.close();
  await tick();
  assert.equal(b.stats().usedBytes, 512 * MiB);
  assert.equal(f.proxy.stats().active, 1);
  assert.equal(f.reserves(), 1);
});
