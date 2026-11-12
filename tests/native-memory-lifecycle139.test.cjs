const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { BigInt64Array, Atomics, SharedArrayBuffer } = globalThis;
const { createNativeExecutor } = require('../src/server/infrastructure/native-executor.cjs');
const { createTransport } = require('../src/server/infrastructure/postgres/transport.cjs');
const {
  createNativeMemoryBudget,
  nativeMemoryProcess,
} = require('../src/server/infrastructure/native-memory-budget.cjs');
const MiB = 1024 * 1024;

class FakeWorker extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.terminations = 0;
    this.exited = false;
  }
  postMessage() {}
  terminate() {
    this.terminations++;
    return Promise.resolve().then(() => {
      if (this.exited) return;
      this.exited = true;
      this.settings.workerData.replyPort?.close();
      this.emit('exit', 0);
    });
  }
}
function writeSample(mailbox, processPlan, { pid = process.pid, threadId = 1, heap = null } = {}) {
  // The private counter mailbox carries eight scalar fields after its seqlock.
  const view = new BigInt64Array(mailbox);
  Atomics.store(view, 0, 1n);
  const fields = [Date.now(), pid, threadId, heap ?? processPlan.heapCeilingMiB * MiB, 1, 2, 3, 4];
  fields.forEach((value, index) => Atomics.store(view, index + 1, BigInt(value)));
  Atomics.store(view, 0, 2n);
}
function managedQueryPool(t) {
  const plan = createNativeMemoryBudget({ budgetMiB: 1536, commandCount: 2, postgres: true });
  const memoryProcess = nativeMemoryProcess(plan, 'gateway');
  const workers = [];
  const executor = createNativeExecutor({
    filename: __filename,
    memoryProcess,
    workerData: { config: { storageBackend: 'postgres', nativeMemoryProcess: memoryProcess } },
    concurrency: 2,
    resourceLimits: memoryProcess.workerResourceLimits,
    workerFactory(_filename, settings) {
      const worker = new FakeWorker(settings);
      workers.push(worker);
      writeSample(settings.workerData.nativeMemoryMailbox, memoryProcess, { threadId: 1 });
      writeSample(settings.workerData.nativeDatabaseMemoryMailbox, memoryProcess, { threadId: 2 });
      return worker;
    },
  });
  t.after(() => executor.close({ force: true }));
  return { memoryProcess, workers, executor };
}
for (const damage of ['foreign-pid', 'duplicate-thread', 'invalid-counter', 'unpublished']) {
  test(`managed query READY rejects ${damage} diagnostics and closes every owned slot`, async (t) => {
    const { memoryProcess, workers, executor } = managedQueryPool(t);
    const waiting = executor.ready();
    waiting.catch(() => {});
    assert.equal(workers.length, 2);
    const data = workers[0].settings.workerData;
    if (damage === 'foreign-pid')
      writeSample(data.nativeDatabaseMemoryMailbox, memoryProcess, {
        pid: process.pid + 1,
        threadId: 2,
      });
    else if (damage === 'duplicate-thread')
      writeSample(data.nativeDatabaseMemoryMailbox, memoryProcess, { threadId: 1 });
    else if (damage === 'invalid-counter')
      writeSample(data.nativeDatabaseMemoryMailbox, memoryProcess, { threadId: 2, heap: -1 });
    else Atomics.store(new BigInt64Array(data.nativeMemoryMailbox), 0, 0n);
    let status;
    assert.doesNotThrow(() => {
      status = executor.stats();
    });
    if (damage === 'invalid-counter') {
      assert.equal(
        status.memory[0].report.main.heapSizeLimitBytes,
        memoryProcess.heapCeilingMiB * MiB,
      );
      assert.equal(status.memory[0].report.database, null);
      assert.equal(status.memory[0].report.lease, null);
    } else assert.equal(status.memory[0].report, null);
    assert.equal(status.memory[1].report.database.threadId, 2);
    try {
      workers[0].emit('message', {
        ready: true,
        memoryBudget: {
          version: 1,
          identity: 'gateway',
          heapSizeLimitBytes: memoryProcess.heapCeilingMiB * MiB,
        },
      });
    } catch (error) {
      await executor.close();
      throw error;
    }
    await assert.rejects(waiting, { code: 'NATIVE_MEMORY_BUDGET_MISMATCH' });
    await executor.close();
    assert.ok(workers.every((worker) => worker.exited));
    assert.ok(workers.every((worker) => worker.terminations === 1));
    assert.equal(executor.stats().workers, 0);
    assert.equal(executor.stats().started, 0, 'no work or mutation was submitted');
    assert.equal(executor.stats().completed, 0);
  });
}
for (const code of ['NATIVE_MEMORY_BUDGET_MISMATCH', 'PRIVATE_SQL_ERROR', undefined]) {
  test(`PG startup worker error ${code ?? 'without-code'} preserves only its closed classification`, async (t) => {
    const memoryProcess = nativeMemoryProcess(
      createNativeMemoryBudget({ budgetMiB: 1536, commandCount: 2, postgres: true }),
      'web',
    );
    let worker;
    const transport = createTransport({
      connection: {},
      nativeMemoryProcess: memoryProcess,
      workerFactory(_filename, settings) {
        worker = new FakeWorker(settings);
        return worker;
      },
    });
    t.after(() => transport.close());
    const expected = code === 'NATIVE_MEMORY_BUDGET_MISMATCH' ? code : 'POSTGRES_WORKER_FAILED';
    const waiting = assert.rejects(transport.ready(), (error) => {
      assert.equal(error.code, expected);
      assert.equal(
        JSON.stringify({ code: error.code, message: error.message }).includes('PRIVATE_'),
        false,
      );
      return true;
    });
    worker.emit('error', Object.assign(Error('PRIVATE_CONNECTION_SQL_PASSWORD'), { code }));
    await waiting;
    await transport.close();
    assert.equal(worker.exited, true);
    assert.equal(worker.terminations, 1);
    assert.equal(transport.stats().calls, 0, 'failure happens before any SQL request');
    assert.equal(transport.stats().poisoned, true);
    assert.equal(transport.stats().exited, true);
  });
}

test('PG malformed memory mailbox rejects READY without throwing from callbacks or public stats', async (t) => {
  const memoryProcess = nativeMemoryProcess(
    createNativeMemoryBudget({ budgetMiB: 1536, commandCount: 2, postgres: true }),
    'web',
  );
  let worker;
  const transport = createTransport({
    connection: {},
    nativeMemoryProcess: memoryProcess,
    nativeMemoryMailbox: new SharedArrayBuffer(8),
    workerFactory(_filename, settings) {
      worker = new FakeWorker(settings);
      return worker;
    },
  });
  t.after(() => transport.close());
  const waiting = transport.ready();
  waiting.catch(() => {});
  let status;
  assert.doesNotThrow(() => {
    status = transport.stats();
  });
  assert.equal(status.memory, null);
  try {
    worker.emit('message', { type: 'ready' });
  } catch (error) {
    await transport.close();
    throw error;
  }
  await assert.rejects(waiting, { code: 'NATIVE_MEMORY_BUDGET_MISMATCH' });
  await transport.close();
  assert.equal(worker.exited, true);
  assert.equal(worker.terminations, 1);
  assert.equal(transport.stats().calls, 0);
  assert.equal(transport.stats().memory, null);
});

test('runtime sampling failures cannot escape RPC/timer callbacks or replace the last valid sample', (t) => {
  const {
    createMemoryMailbox,
    sampleIsolateMemory,
    startMemorySampling,
  } = require('../src/server/infrastructure/native-memory-observation.cjs');
  const actual = sampleIsolateMemory();
  const plan = { version: 1, identity: 'web', heapCeilingMiB: actual.heapSizeLimitBytes / MiB };
  assert.throws(
    () => startMemorySampling(plan, new SharedArrayBuffer(8)),
    {
      code: 'NATIVE_MEMORY_BUDGET_MISMATCH',
    },
    'an invalid startup mailbox remains a hard rejection',
  );
  t.mock.timers.enable({ apis: ['setInterval'] });
  const mailbox = createMemoryMailbox();
  const sampling = startMemorySampling(plan, mailbox);
  t.after(() => sampling.close());
  // Inspect writer bytes here; production readers normalize only Worker mailboxes.
  const view = new BigInt64Array(mailbox);
  const before = Array.from(view);
  const collector = t.mock.method(process, 'memoryUsage', () => {
    throw Error('Synthetic metric collector failure');
  });
  assert.equal(sampling.publish(), null);
  assert.doesNotThrow(() => t.mock.timers.tick(1000));
  assert.deepEqual(
    Array.from(view),
    before,
    'a failed collector cannot invent a fresh counter or overwrite valid telemetry',
  );
  collector.mock.restore();
  const recovered = sampling.publish();
  assert.ok(recovered.sampleAtMs >= Number(before[1]));
  assert.equal(recovered.heapSizeLimitBytes, actual.heapSizeLimitBytes);
  assert.equal(Number(Atomics.load(view, 1)), recovered.sampleAtMs);
  assert.ok(Atomics.load(view, 0) > before[0], 'collection resumes after the failure');
  sampling.close();
});
