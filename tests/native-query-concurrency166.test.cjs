const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const { createNativeExecutor } = require('../src/server/infrastructure/native-executor.cjs');
const {
  createNativeQueryJobs166,
} = require('../src/server/infrastructure/native-query-jobs166.cjs');
const {
  createNativeMemoryWorkBudget,
} = require('../src/server/infrastructure/native-memory-work-budget.cjs');
const MiB = 1024 * 1024;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const until = async (predicate) => {
  const end = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > end) throw Error('Mock protocol progress timeout');
    await new Promise(setImmediate);
  }
};
const body = (bytes, tag = 'x') => Uint8Array.from(Buffer.alloc(bytes, tag)).buffer;
const response = (bytes, tag = 'x') => ({
  status: 200,
  headers: {},
  body: body(bytes, tag),
});
function work() {
  return createNativeMemoryWorkBudget({
    version: 1,
    maxBytes: 1024 * MiB,
    queryBytes: 384 * MiB,
    queryProbeBytes: 96 * MiB,
    commandBytes: 512 * MiB,
    waitMs: 1000,
    estimatedWorkingSet: true,
    rssHardCapClaim: false,
  });
}
function fixture(
  t,
  {
    feature = true,
    concurrency = 2,
    manualExit = false,
    workBudget = work(),
    kernelFactory,
    ...options
  } = {},
) {
  const workers = [],
    started = [],
    gates = new Map();
  class FakeWorker extends EventEmitter {
    constructor() {
      super();
      this.sent = [];
      this.out = [];
      this.terminateCalls = 0;
      this.exited = false;
      this.finished = deferred();
      const port = {
        postMessage: (message, transfer) => {
          const moved = structuredClone(message, { transfer: transfer || [] });
          this.out.push({
            id: moved.id,
            replyBytes166: moved.replyBytes166,
            error: moved.error,
            resultBytes: moved.result?.body.byteLength,
          });
          queueMicrotask(() => this.emit('message', moved));
        },
      };
      const kernel = kernelFactory
        ? kernelFactory({ port, started, gates })
        : {
            stats: () => ({}),
            async run(metadata, _cancel, execution) {
              started.push(metadata.tag);
              const gate = deferred();
              gates.set(metadata.tag, gate);
              if (metadata.upgrade) await execution.requestMemoryClass('query');
              return gate.promise;
            },
          };
      this.jobs = createNativeQueryJobs166({
        parentPort: port,
        kernel,
        capacity: feature ? 2 : 1,
      });
      setImmediate(() =>
        this.emit('message', {
          ready: true,
          ...(feature
            ? {
                queryFeatures166: {
                  version: 1,
                  capacity: 2,
                  replyCredit: true,
                },
              }
            : {}),
        }),
      );
    }
    postMessage(message, transfer) {
      const moved = structuredClone(message, { transfer: transfer || [] });
      this.sent.push(moved);
      if (feature) queueMicrotask(() => this.jobs.receive(moved));
    }
    terminate() {
      this.terminateCalls++;
      if (!manualExit) setImmediate(() => this.exit());
      return this.finished.promise;
    }
    exit() {
      if (this.exited) return;
      this.exited = true;
      this.emit('exit', 0);
      this.finished.resolve();
    }
    reply(id, result, queryDiagnostics) {
      this.emit('message', { id, result, queryDiagnostics });
    }
  }
  const executor = createNativeExecutor({
    filename: path.join(ROOT, 'src/server/infrastructure/native-query-worker.cjs'),
    concurrency,
    cancelGraceMs: 100,
    timeoutMs: 2000,
    startupMs: 2000,
    workBudget,
    boundedRead: () => true,
    workerFactory() {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    ...options,
  });
  t.after(async () => {
    const closed = executor.close({ force: true });
    workers.forEach((worker) => worker.exit());
    await closed;
    workBudget?.close();
  });
  return {
    executor,
    workers,
    started,
    gates,
    workBudget,
    run(tag, extra = {}, runOptions = {}) {
      return executor.run({ kind: 'query', metadata: { tag, ...extra } }, runOptions);
    },
  };
}
test('166 four small jobs run on two feature workers with unchanged leases and no reply upgrade IPC', async (t) => {
  const f = fixture(t);
  await f.executor.ready();
  const pending = ['a', 'b', 'c', 'd'].map((tag) => f.run(tag));
  await until(() => f.started.length === 4);
  assert.equal(f.workers.length, 2);
  assert.equal(f.executor.stats().active, 4);
  assert.equal(f.executor.stats().reservedBytes, 4 * 65536);
  assert.equal(f.workBudget.stats().usedBytes, 4 * 96 * MiB);
  for (const tag of ['d', 'b', 'c', 'a']) f.gates.get(tag).resolve(response(8, tag));
  const results = await Promise.all(pending);
  assert.deepEqual(
    results.map((row) => row.body.toString()),
    ['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd'],
  );
  assert.equal(
    f.workers.flatMap((worker) => worker.out).filter((row) => row.replyBytes166).length,
    0,
  );
  assert.equal(f.executor.stats().reservedBytes, 0);
  assert.equal(f.executor.stats().retainedBytes, 32);
  results.forEach((result) => result.release());
  assert.equal(f.workBudget.stats().usedBytes, 0);
  assert.equal(f.executor.stats().retainedBytes, 0);
});
for (const reverse of [false, true])
  test(`166 two heavy probes choose the older job without deadlock (newer request first=${reverse})`, async (t) => {
    const heavy = [],
      askA = deferred(),
      askB = deferred();
    const f = fixture(t, {
      concurrency: 1,
      kernelFactory: ({ started, gates }) => ({
        stats: () => ({}),
        async run(metadata, _cancel, execution) {
          started.push(metadata.tag);
          const gate = deferred();
          gates.set(metadata.tag, gate);
          await (metadata.tag === 'a' ? askA : askB).promise;
          await execution.requestMemoryClass('query');
          heavy.push(metadata.tag);
          return gate.promise;
        },
      }),
    });
    await f.executor.ready();
    const a = f.run('a'),
      b = f.run('b').catch((error) => error);
    await until(() => f.started.length === 2);
    if (reverse) {
      askB.resolve();
      await until(() => f.executor.stats().queryUpgradeRequested === 1);
    }
    askA.resolve();
    if (!reverse) askB.resolve();
    const refused = await b;
    assert.equal(refused.code, 'NATIVE_MEMORY_WORK_CAPACITY');
    assert.equal(refused.outcomeUnknown, false);
    await until(() => heavy.length === 1);
    assert.equal(f.executor.stats().queryUpgradeGranted, 1);
    assert.equal(f.executor.stats().queryUpgradeRefused, 1);
    assert.equal(f.workBudget.stats().usedBytes, 384 * MiB);
    assert.equal(f.workBudget.stats().peakBytes <= 384 * MiB, true);
    assert.deepEqual(heavy, ['a'], 'the rejected probe cannot fetch/decode heavy data');
    const grants = f.workers[0].sent.filter((message) => message.memoryGranted === 'query');
    assert.equal(grants.length, 1);
    f.gates.get('a').resolve(response(5, 'a'));
    const result = await a;
    assert.equal(result.body.toString(), 'aaaaa');
    result.release();
    assert.equal(f.workBudget.stats().usedBytes, 0);
  });
test('166 a heavy request waits for its sibling small probe and blocks new probes until heavy cleanup', async (t) => {
  const ask = deferred(),
    heavy = [];
  const f = fixture(t, {
    concurrency: 1,
    kernelFactory: ({ started, gates }) => ({
      stats: () => ({}),
      async run(metadata, _cancel, execution) {
        started.push(metadata.tag);
        const gate = deferred();
        gates.set(metadata.tag, gate);
        if (metadata.tag === 'a') {
          await ask.promise;
          await execution.requestMemoryClass('query');
          heavy.push('a');
        }
        return gate.promise;
      },
    }),
  });
  await f.executor.ready();
  const a = f.run('a'),
    b = f.run('b');
  await until(() => f.started.length === 2);
  ask.resolve();
  await until(() => f.executor.stats().queryUpgradeRequested === 1);
  const c = f.run('c');
  await new Promise(setImmediate);
  assert.equal(f.executor.stats().queryUpgradeGranted, 0);
  assert.equal(f.workBudget.stats().usedBytes, 192 * MiB);
  assert.deepEqual(f.started, ['a', 'b']);
  assert.deepEqual(heavy, []);
  f.gates.get('b').resolve(response(8, 'b'));
  const small = await b;
  small.release();
  await until(() => heavy.length === 1);
  assert.equal(f.workBudget.stats().usedBytes, 384 * MiB);
  assert.deepEqual(f.started, ['a', 'b'], 'no second decoded payload overlaps a heavy owner');
  f.gates.get('a').resolve(response(8, 'a'));
  const large = await a;
  large.release();
  await until(() => f.started.includes('c'));
  f.gates.get('c').resolve(response(8, 'c'));
  const last = await c;
  last.release();
  assert.equal(f.workBudget.stats().usedBytes, 0);
  assert.equal(
    f.workBudget.stats().peakBytes <= 384 * MiB + 8,
    true,
    'the transferred small parent reply may retain eight exact bytes after its worker payload is gone',
  );
});
test('166 initial heavy reads occupy an exclusive worker while bounded probes wait', async (t) => {
  const f = fixture(t, { concurrency: 1, boundedRead: (metadata) => metadata.bounded === true });
  await f.executor.ready();
  const a = f.run('heavy'),
    b = f.run('small', { bounded: true });
  await until(() => f.started.length === 1);
  assert.equal(f.workBudget.stats().usedBytes, 384 * MiB);
  assert.deepEqual(f.started, ['heavy']);
  f.gates.get('heavy').resolve(response(8));
  const first = await a;
  first.release();
  await until(() => f.started.length === 2);
  assert.equal(f.workBudget.stats().usedBytes, 96 * MiB);
  f.gates.get('small').resolve(response(8));
  const last = await b;
  last.release();
  assert.equal(f.workBudget.stats().usedBytes, 0);
});
test('166 exact large reply upgrades respect the retained cap and initial-credit headroom makes progress', async (t) => {
  const f = fixture(t, {
    maxResponseBytes: 128 * 1024,
    maxRetainedBytes: 256 * 1024,
  });
  await f.executor.ready();
  const a = f.run('a'),
    b = f.run('b'),
    c = f.run('c'),
    d = f.run('d');
  await until(() => f.started.length === 3);
  assert.equal(f.executor.stats().reservedBytes, 3 * 65536);
  assert.equal(
    f.executor.stats().active,
    3,
    'one full reply can still upgrade even with small initial reservations',
  );
  for (const tag of ['a', 'b', 'c']) f.gates.get(tag).resolve(response(128 * 1024, tag));
  const first = await a;
  await until(
    () => f.workers.flatMap((worker) => worker.out).filter((row) => row.replyBytes166).length === 3,
  );
  assert.equal(first.body.length, 128 * 1024);
  assert.equal(
    f.executor.stats().retainedBytes + f.executor.stats().reservedBytes <= 256 * 1024,
    true,
  );
  assert.equal(
    f.workers.flatMap((worker) => worker.sent).filter((row) => row.replyGranted166).length,
    1,
    'other ready bodies stay owned under work leases before credit ACK',
  );
  first.release();
  const pair = await Promise.all([b, c]);
  pair.forEach((row) => row.release());
  await until(() => f.started.includes('d'));
  f.gates.get('d').resolve(response(128 * 1024, 'd'));
  const last = await d;
  assert.equal(last.body.length, 128 * 1024);
  last.release();
  assert.equal(f.executor.stats().reservedBytes, 0);
  assert.equal(f.executor.stats().retainedBytes, 0);
  assert.equal(f.workBudget.stats().usedBytes, 0);
});
test('166 worker cancellation routes pending memory/reply grants by id and leaves another job intact', async () => {
  const out = [],
    gates = new Map();
  const port = {
    postMessage(message, transfer) {
      const value = structuredClone(message, { transfer: transfer || [] });
      out.push(value);
    },
  };
  const kernel = {
    stats: () => ({}),
    async run(metadata, _cancel, execution) {
      await execution.requestMemoryClass('query');
      const gate = deferred();
      gates.set(metadata.tag, gate);
      await gate.promise;
      return response(96 * 1024, metadata.tag);
    },
  };
  const jobs = createNativeQueryJobs166({
    parentPort: port,
    kernel,
    capacity: 2,
  });
  const make = (id, tag) => ({
    id,
    kind: 'query',
    metadata: { tag },
    cancel: new SharedArrayBuffer(4),
    memoryClass: 'query-probe',
    replyCredit166: 65536,
    maxReplyBytes166: 64 * MiB,
  });
  jobs.receive(make(1, 'a'));
  jobs.receive(make(2, 'b'));
  assert.deepEqual(
    out.map((row) => row.id),
    [1, 2],
  );
  jobs.receive({ id: 2, memoryGranted: 'query' });
  await until(() => gates.has('b'));
  gates.get('b').resolve();
  await until(() => out.some((row) => row.replyBytes166));
  jobs.receive({ id: 1, replyGranted166: 96 * 1024 });
  assert.equal(
    out.filter((row) => row.result).length,
    0,
    'wrong job reply grant cannot release another body',
  );
  jobs.receive({ id: 1, cancel166: true });
  await until(() => out.some((row) => row.error?.status === 499));
  assert.equal(jobs.active(), 1);
  jobs.receive({ id: 2, replyGranted166: 96 * 1024 });
  await until(() => out.some((row) => row.result));
  assert.equal(out.find((row) => row.result).id, 2);
  assert.equal(out.find((row) => row.result).result.body.byteLength, 96 * 1024);
  assert.equal(jobs.active(), 0);
  jobs.receive({ id: 1, memoryGranted: 'query' });
  jobs.receive({ id: 1, replyGranted166: 96 * 1024 });
  assert.equal(
    out.filter((row) => row.result).length,
    1,
    'cancelled late grants do not resurrect work',
  );
});
test('166 cancelling an exact reply waiter frees only its credit and lets the sibling body transfer', async (t) => {
  const f = fixture(t, { maxResponseBytes: 128 * 1024, maxRetainedBytes: 256 * 1024 });
  await f.executor.ready();
  const abort = new AbortController();
  const a = f.run('a');
  const b = f.run('b', {}, { signal: abort.signal }).catch((error) => error);
  const c = f.run('c');
  await until(() => f.started.length === 3);
  for (const tag of ['a', 'b', 'c']) f.gates.get(tag).resolve(response(128 * 1024, tag));
  const first = await a;
  await until(
    () => f.workers.flatMap((worker) => worker.out).filter((row) => row.replyBytes166).length === 3,
  );
  abort.abort();
  assert.equal((await b).code, 'NATIVE_CANCELLED');
  const last = await c;
  assert.equal(last.body.length, 128 * 1024);
  assert.equal(f.executor.stats().retainedBytes, 256 * 1024);
  assert.equal(f.executor.stats().reservedBytes, 0);
  first.release();
  last.release();
  assert.equal(f.workBudget.stats().usedBytes, 0);
});
test('166 an uncredited body cannot bypass reply admission or release physical work early', async (t) => {
  const f = fixture(t, { concurrency: 1, manualExit: true });
  await f.executor.ready();
  const pending = f.run('bad').catch((error) => error);
  await until(() => f.started.length === 1);
  const worker = f.workers[0];
  worker.reply(worker.sent.find((row) => row.kind === 'query').id, response(128 * 1024));
  assert.equal(worker.terminateCalls, 1);
  assert.equal(f.executor.stats().retainedBytes, 0);
  assert.equal(f.workBudget.stats().usedBytes, 96 * MiB);
  worker.exit();
  assert.equal((await pending).code, 'NATIVE_WORKER_EXIT');
  assert.equal(f.executor.stats().reservedBytes, 0);
  assert.equal(f.workBudget.stats().usedBytes, 0);
});
test('166 a physical worker exit retains and then releases every owned job and ignores late cancelled frames', async (t) => {
  const f = fixture(t, { concurrency: 1, manualExit: true, cancelGraceMs: 0 });
  await f.executor.ready();
  const abort = new AbortController();
  const a = f.run('a', {}, { signal: abort.signal }).catch((error) => error),
    b = f.run('b').catch((error) => error);
  await until(() => f.started.length === 2);
  const worker = f.workers[0],
    ids = worker.sent.filter((row) => row.kind === 'query').map((row) => row.id);
  abort.abort();
  assert.equal(worker.terminateCalls, 1);
  assert.equal(f.executor.stats().active, 2);
  assert.equal(
    f.workBudget.stats().usedBytes,
    192 * MiB,
    'logical cancellation never frees physical ownership',
  );
  worker.exit();
  const errors = await Promise.all([a, b]);
  assert.equal(errors[0].code, 'NATIVE_CANCELLED');
  assert.equal(errors[1].code, 'NATIVE_WORKER_EXIT');
  assert.equal(
    errors.every((error) => error.outcomeUnknown === false),
    true,
  );
  assert.equal(f.executor.stats().reservedBytes, 0);
  assert.equal(f.workBudget.stats().usedBytes, 0);
  worker.emit('message', {
    id: ids[0],
    error: { status: 499, message: 'late' },
  });
  assert.equal(f.executor.stats().reservedBytes, 0);
});
test('166 old command workers remain single-owner and cancelled mutations keep unknown settlement', async (t) => {
  const f = fixture(t, { feature: false, concurrency: 1 });
  await f.executor.ready();
  const abort = new AbortController();
  const command = f.executor
    .run({ kind: 'command' }, { mutating: true, signal: abort.signal })
    .catch((error) => error);
  const query = f.run('next');
  await until(() => f.workers[0].sent.some((row) => row.kind === 'command'));
  const worker = f.workers[0],
    first = worker.sent.find((row) => row.kind === 'command');
  assert.equal(f.executor.stats().active, 1);
  assert.equal(Object.hasOwn(first, 'replyCredit166'), false);
  abort.abort();
  assert.equal(worker.terminateCalls, 0);
  worker.reply(first.id, response(8));
  const unknown = await command;
  assert.equal(unknown.outcomeUnknown, true);
  await until(() => worker.sent.some((row) => row.kind === 'query'));
  worker.reply(worker.sent.find((row) => row.kind === 'query').id, response(8));
  const reply = await query;
  reply.release();
  assert.equal(f.executor.stats().active, 0);
});
function diagnostics(version) {
  const routes = [
    'bootstrap',
    'directory',
    'patient',
    'calendar',
    'operation',
    'timeZone',
    'schedules',
    'workspace',
    'availability',
    'serviceGroups',
  ];
  const fields = [
    'count',
    'errors',
    'rpcCalls',
    'operationSqlCalls',
    'authMs',
    'projectionMs',
    'serializeMs',
    'totalMs',
  ];
  const pool = [
    'hits',
    'misses',
    'opens',
    'openErrors',
    'evictions',
    'closes',
    'closeErrors',
    'openMs',
    'closeMs',
    'connections',
  ];
  const view = ['hits', 'misses', 'invalidated', 'rejected', 'entries'];
  return {
    version,
    routes: Object.fromEntries(
      routes.map((name) => [name, Object.fromEntries(fields.map((field) => [field, 0]))]),
    ),
    pool: Object.fromEntries(pool.map((field) => [field, 0])),
    ...(version > 1
      ? {
          readViews: {
            ...Object.fromEntries(view.map((field) => [field, 0])),
            sqlResults: { hits: 0, misses: 0, rejected: 0, entries: 0 },
            ...(version === 3
              ? {
                  directoryResponses165: Object.fromEntries(view.map((field) => [field, 0])),
                }
              : {}),
          },
        }
      : {}),
  };
}
test('166 a duplicate active job id cannot acknowledge or replay its physical owner', async () => {
  const out = [],
    gate = deferred();
  let starts = 0;
  const jobs = createNativeQueryJobs166({
    capacity: 2,
    parentPort: {
      postMessage(message) {
        out.push(message);
      },
    },
    kernel: {
      stats: () => ({}),
      async run() {
        starts++;
        await gate.promise;
        return response(8);
      },
    },
  });
  const message = { id: 7, kind: 'query', metadata: {}, cancel: new SharedArrayBuffer(4) };
  jobs.receive(message);
  jobs.receive(message);
  assert.equal(starts, 1);
  assert.equal(jobs.active(), 1);
  assert.equal(out.length, 0);
  gate.resolve();
  await until(() => jobs.active() === 0);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 7);
  assert.equal(out[0].result.body.byteLength, 8);
});
test('166 closed diagnostics accepts v1/v2/v3 and rejects unknown/private cache fields', async (t) => {
  const f = fixture(t, { feature: false, concurrency: 1 });
  await f.executor.ready();
  const worker = f.workers[0];
  async function send(snapshot) {
    const pending = f.run('diag');
    await until(() => f.executor.stats().active === 1);
    const id = worker.sent.at(-1).id;
    worker.reply(id, response(3), snapshot);
    const result = await pending;
    result.release();
    return f.executor.stats().queryDiagnostics[0].snapshot;
  }
  for (const version of [1, 2, 3])
    assert.equal((await send(diagnostics(version))).version, version);
  const wrong = diagnostics(2);
  wrong.readViews.directoryResponses165 = {
    hits: 0,
    misses: 0,
    invalidated: 0,
    rejected: 0,
    entries: 0,
  };
  assert.equal(await send(wrong), null);
  const privateData = diagnostics(3);
  privateData.readViews.directoryResponses165.tenantId = 'PRIVATE';
  assert.equal(await send(privateData), null);
  assert.equal(JSON.stringify(f.executor.stats()).includes('PRIVATE'), false);
  const missing = diagnostics(3);
  delete missing.readViews.directoryResponses165;
  assert.equal(await send(missing), null);
});
