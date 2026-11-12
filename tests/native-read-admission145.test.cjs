const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createNativeExecutor } = require('../src/server/infrastructure/native-executor.cjs');
const {
  createNativeMemoryWorkBudget,
} = require('../src/server/infrastructure/native-memory-work-budget.cjs');
const MiB = 1024 * 1024;
const tick = () => new Promise(setImmediate);
class Reader extends EventEmitter {
  messages = [];
  stops = 0;
  postMessage(message, transfer) {
    this.messages.push(structuredClone(message, { transfer }));
  }
  terminate() {
    this.stops++;
    return Promise.resolve();
  }
  get job() {
    return this.messages.find((message) => message.kind === 'query');
  }
  upgrade() {
    this.emit('message', { id: this.job.id, memoryClass: 'query' });
  }
  reply(bytes = 3) {
    this.emit('message', {
      id: this.job.id,
      result: { status: 200, headers: {}, body: new ArrayBuffer(bytes) },
    });
  }
  exit() {
    this.emit('exit', 0);
  }
}
async function fixture(t, options = {}) {
  const budget = createNativeMemoryWorkBudget({
    version: 1,
    maxBytes: 896 * MiB,
    queryBytes: 384 * MiB,
    queryProbeBytes: 96 * MiB,
    commandBytes: 512 * MiB,
    estimatedWorkingSet: true,
    rssHardCapClaim: false,
  });
  const workers = [];
  const executor = createNativeExecutor({
    filename: __filename,
    concurrency: 2,
    workBudget: budget,
    boundedRead: (metadata) => metadata.bounded === true,
    workerFactory() {
      const worker = new Reader();
      workers.push(worker);
      return worker;
    },
    ...options,
  });
  t.after(async () => {
    const closing = executor.close({ force: true });
    workers.forEach((worker) => worker.exit());
    await closing;
    budget.close();
  });
  const ready = executor.ready();
  workers.forEach((worker) => worker.emit('message', { ready: true }));
  await ready;
  function run(bounded = true, signal) {
    const result = executor.run({ kind: 'query', metadata: { bounded } }, { signal });
    result.catch(() => {});
    return result;
  }
  return { budget, executor, workers, run };
}
test('two bounded reads coexist with a command without increasing the aggregate budget', async (t) => {
  const f = await fixture(t),
    command = await f.budget.acquire('command');
  const reads = [f.run(), f.run()];
  await tick();
  assert.equal(f.executor.stats().started, 2);
  assert.equal(f.budget.stats().usedBytes, 704 * MiB);
  f.workers.forEach((worker) => {
    assert.equal(worker.job.memoryClass, 'query-probe');
    worker.reply();
  });
  (await Promise.all(reads)).forEach((reply) => reply.release());
  command.release();
  assert.equal(f.budget.stats().usedBytes, 0);
});
test('two oversized probes return capacity before awaiting the original heavy reservation', async (t) => {
  const f = await fixture(t),
    command = await f.budget.acquire('command');
  const first = f.run(),
    second = f.run();
  await tick();
  f.workers[0].upgrade();
  await tick();
  assert.equal(
    f.workers[0].messages.length,
    1,
    'no fetch permission while capacity is unavailable',
  );
  f.workers[1].upgrade();
  await tick();
  assert.deepEqual(f.workers[0].messages.at(-1), {
    id: f.workers[0].job.id,
    memoryGranted: 'query',
  });
  assert.equal(f.workers[1].messages.length, 1);
  assert.equal(f.budget.stats().usedBytes, 896 * MiB);
  f.workers[0].reply();
  (await first).release();
  await tick();
  assert.equal(f.workers[1].messages.at(-1).memoryGranted, 'query');
  f.workers[1].reply();
  (await second).release();
  command.release();
  assert.equal(f.budget.stats().usedBytes, 0);
});
test('legacy reads keep the heavy estimate and cannot request a probe upgrade', async (t) => {
  const f = await fixture(t),
    result = f.run(false);
  await tick();
  assert.equal(f.budget.stats().usedBytes, 384 * MiB);
  assert.equal(f.workers[0].job.memoryClass, undefined);
  f.workers[0].upgrade();
  assert.equal(f.workers[0].stops, 1);
  assert.equal(f.budget.stats().usedBytes, 384 * MiB);
  f.workers[0].exit();
  await assert.rejects(result, { code: 'NATIVE_WORKER_EXIT' });
  assert.equal(f.budget.stats().usedBytes, 0);
});
test('cancellation removes a pending upgrade and never grants it after physical exit', async (t) => {
  const f = await fixture(t),
    command = await f.budget.acquire('command');
  const abort = new AbortController();
  const first = f.run(true, abort.signal),
    second = f.run();
  await tick();
  f.workers[0].upgrade();
  await tick();
  assert.equal(f.budget.stats().pending, 1);
  abort.abort();
  f.workers[0].exit();
  await assert.rejects(first, { code: 'NATIVE_CANCELLED' });
  await tick();
  assert.equal(f.budget.stats().pending, 0);
  assert.equal(f.workers[0].messages.length, 1);
  f.workers[1].reply();
  (await second).release();
  command.release();
  assert.equal(f.budget.stats().usedBytes, 0);
});
test('an upgraded reservation stays charged after cancellation until the reader physically exits', async (t) => {
  const f = await fixture(t),
    abort = new AbortController(),
    result = f.run(true, abort.signal);
  await tick();
  f.workers[0].upgrade();
  await tick();
  assert.equal(f.budget.stats().usedBytes, 384 * MiB);
  abort.abort();
  assert.equal(f.budget.stats().usedBytes, 384 * MiB);
  f.workers[0].exit();
  await assert.rejects(result, { code: 'NATIVE_CANCELLED' });
  assert.equal(f.budget.stats().usedBytes, 0);
});
test('duplicate upgrade is a protocol violation and cannot return an active reservation early', async (t) => {
  const f = await fixture(t),
    result = f.run();
  await tick();
  f.workers[0].upgrade();
  await tick();
  f.workers[0].upgrade();
  assert.equal(f.workers[0].stops, 1);
  assert.equal(f.budget.stats().usedBytes, 384 * MiB);
  f.workers[0].exit();
  await assert.rejects(result, { code: 'NATIVE_WORKER_EXIT' });
});
