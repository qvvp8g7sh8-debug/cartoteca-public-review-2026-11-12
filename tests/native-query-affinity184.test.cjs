const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const ROOT = path.resolve(__dirname, '..');
const { createNativeExecutor } = require('../src/server/infrastructure/native-executor.cjs');
const {
  createNativeMemoryWorkBudget,
} = require('../src/server/infrastructure/native-memory-work-budget.cjs');
const MiB = 1024 * 1024;
const tick = () => new Promise(setImmediate);
async function until(predicate) {
  const end = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > end) throw Error('Controlled executor progress timeout');
    await tick();
  }
}
function routing(owner) {
  for (let n = 0; ; n++) {
    const key = 'synthetic-owner-' + n;
    let hash = 2166136261;
    for (const c of key) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0;
    if (hash % 2 === owner) return key;
  }
}
function budget() {
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
function fixture(t, options = {}, factory = createNativeExecutor) {
  const workers = [],
    b = Object.hasOwn(options, 'workBudget') ? options.workBudget : budget();
  class FakeWorker extends EventEmitter {
    constructor() {
      super();
      this.sent = [];
      this.exited = false;
      setImmediate(() =>
        this.emit('message', {
          ready: true,
          queryFeatures166: { version: 1, capacity: 2, replyCredit: true },
        }),
      );
    }
    postMessage(message, transfer) {
      this.sent.push(structuredClone(message, { transfer: transfer || [] }));
    }
    reply(tag, bytes = 8) {
      const item = this.sent.find((v) => v.metadata?.tag === tag);
      assert.ok(item, 'Synthetic job was dispatched');
      this.emit('message', {
        id: item.id,
        result: { status: 200, headers: {}, body: Uint8Array.from(Buffer.alloc(bytes)).buffer },
      });
    }
    exit() {
      if (this.exited) return;
      this.exited = true;
      this.emit('exit', 0);
    }
    terminate() {
      setImmediate(() => this.exit());
      return Promise.resolve(0);
    }
  }
  const executor = factory({
    filename: path.join(ROOT, 'src/server/infrastructure/native-query-worker.cjs'),
    concurrency: 2,
    strictAffinity: true,
    timeoutMs: 2000,
    startupMs: 2000,
    cancelGraceMs: 100,
    boundedRead: () => true,
    workBudget: b,
    workerFactory() {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    ...options,
  });
  t.after(async () => {
    const closed = executor.close({ force: true });
    workers.forEach((w) => w.exit());
    await closed;
    b?.close?.();
  });
  return {
    executor,
    workers,
    b,
    run(tag, owner = 0, signal) {
      const p = executor.run(
        { kind: 'query', metadata: { tag } },
        { affinityKey: routing(owner), signal },
      );
      p.catch(() => {});
      return p;
    },
    sent(tag) {
      return workers.findIndex((w) => w.sent.some((v) => v.metadata?.tag === tag));
    },
  };
}
async function finish(f, tag, pending, bytes = 8) {
  f.workers[f.sent(tag)].reply(tag, bytes);
  const out = await pending;
  out.release();
  return out;
}

test('184 busy owner cannot steal another worker or block its queued work; owner FIFO', async (t) => {
  const f = fixture(t);
  await f.executor.ready();
  const a = f.run('a'),
    b = f.run('b');
  await until(() => f.sent('b') === 0);
  const c = f.run('c'),
    d = f.run('d'),
    other = f.run('other', 1);
  await until(() => f.sent('other') === 1);
  assert.equal(f.sent('c'), -1);
  assert.equal(f.sent('d'), -1);
  assert.equal(f.executor.stats().pending, 2);
  await finish(f, 'a', a);
  await until(() => f.sent('c') === 0);
  assert.equal(f.sent('d'), -1);
  await finish(f, 'b', b);
  await until(() => f.sent('d') === 0);
  await finish(f, 'c', c);
  await finish(f, 'd', d);
  await finish(f, 'other', other);
  assert.equal(f.b.stats().usedBytes, 0);
  assert.equal(f.executor.stats().reservedBytes, 0);
});

test('184 one shared-FIFO work waiter, cancellation and no speculative owner reservations', async (t) => {
  const f = fixture(t);
  await f.executor.ready();
  const full = await f.b.acquire('command-exclusive');
  const abort = new AbortController(),
    a = f.run('cancelled', 0, abort.signal),
    b = f.run('b', 1);
  await until(() => f.b.stats().pending === 1);
  await tick();
  assert.equal(f.b.stats().pending, 1);
  assert.equal(f.executor.stats().pending, 2);
  abort.abort();
  await assert.rejects(a, { code: 'NATIVE_CANCELLED' });
  await until(() => f.b.stats().pending === 1);
  assert.equal(f.sent('cancelled'), -1);
  full.release();
  await until(() => f.sent('b') === 1);
  await finish(f, 'b', b);
  assert.equal(f.b.stats().usedBytes, 0);
  assert.equal(f.b.stats().pending, 0);
});

test('184 pending cancellation followed by a late work grant releases it exactly once', async (t) => {
  let resolve,
    released = 0;
  const waiting = new Promise((r) => {
    resolve = r;
  });
  const b = {
    waitMs: 1000,
    supports: (k) => k === 'query-probe',
    acquire: () => waiting,
    close() {},
  };
  const f = fixture(t, { workBudget: b });
  await f.executor.ready();
  const abort = new AbortController(),
    p = f.run('late', 0, abort.signal);
  abort.abort();
  await assert.rejects(p, { code: 'NATIVE_CANCELLED' });
  resolve({
    release() {
      released++;
    },
    reduceTo() {},
  });
  await tick();
  assert.equal(released, 1);
  assert.equal(f.sent('late'), -1);
  assert.equal(f.executor.stats().pending, 0);
});

test('184 bounded reply-credit priority remains global across eligible owner heads', async (t) => {
  const f = fixture(t, { maxResponseBytes: 65536, maxRetainedBytes: 131072 });
  await f.executor.ready();
  const a = f.run('a', 0),
    b = f.run('b', 1);
  await until(() => f.sent('a') === 0 && f.sent('b') === 1);
  f.workers[0].reply('a', 65536);
  f.workers[1].reply('b', 65536);
  const ra = await a,
    rb = await b;
  const c = f.run('c', 0),
    d = f.run('d', 1);
  await tick();
  assert.equal(f.sent('c'), -1);
  assert.equal(f.sent('d'), -1);
  assert.equal(f.b.stats().pending, 0);
  assert.equal(f.executor.stats().retainedBytes, 131072);
  ra.release();
  await until(() => f.sent('c') === 0);
  assert.equal(f.sent('d'), -1);
  rb.release();
  await until(() => f.sent('d') === 1);
  await finish(f, 'c', c);
  await finish(f, 'd', d);
  assert.equal(f.executor.stats().retainedBytes, 0);
  assert.equal(f.b.stats().usedBytes, 0);
});

test('184 missing owner waits for its stable replacement; another owner progresses, no replay', async (t) => {
  const f = fixture(t);
  await f.executor.ready();
  const failed = f.run('failed', 0);
  await until(() => f.sent('failed') === 0);
  f.workers[0].exit();
  await assert.rejects(failed, { code: 'NATIVE_WORKER_EXIT' });
  const queued = f.run('queued', 0),
    other = f.run('other', 1);
  await until(() => f.sent('other') === 1);
  assert.equal(
    f.workers[1].sent.some((v) => v.metadata?.tag === 'queued'),
    false,
  );
  await until(() => f.workers.length === 3 && f.sent('queued') === 2);
  assert.equal(
    f.workers.flatMap((w) => w.sent).filter((v) => v.metadata?.tag === 'failed').length,
    1,
  );
  await finish(f, 'queued', queued);
  await finish(f, 'other', other);
  assert.equal(f.b.stats().usedBytes, 0);
});

test('184 flag absent/false preserves legacy soft-affinity dispatch and public stats', async (t) => {
  const old = fixture(t, { strictAffinity: undefined }),
    current = fixture(t, { strictAffinity: false });
  await Promise.all([old.executor.ready(), current.executor.ready()]);
  const pending = [];
  for (const f of [old, current]) {
    const a = f.run('a', 0);
    await until(() => f.sent('a') === 0);
    const b = f.run('b', 0);
    await until(() => f.sent('b') === 1);
    pending.push([f, a, b]);
  }
  assert.deepEqual(current.executor.stats(), old.executor.stats());
  for (const [f, a, b] of pending) {
    await finish(f, 'a', a);
    await finish(f, 'b', b);
  }
  assert.deepEqual(current.executor.stats(), old.executor.stats());
});

test('184 operator flag validates exact opt-in profile; absent configuration stays identical', () => {
  const current = require('../src/server/config.cjs').configuration;
  const defaults = current({}, {}),
    disabled = current({ nativeQueryAffinity184: false }, {});
  delete disabled.nativeQueryAffinity184;
  assert.deepEqual(disabled, defaults);
  assert.equal(Object.hasOwn(defaults, 'nativeQueryAffinity184'), false);
  for (const value of [null, 1, 'true', {}, []])
    assert.throws(() => current({ nativeQueryAffinity184: value }, {}), /affinity/);
  for (const opts of [
    {},
    { nativeDirectorySnapshots180: true },
    {
      storageBackend: 'postgres',
      postgresRevisionProfile: 3,
      nativeMemoryBudgetVersion: 1,
      nativeMemoryBudgetMiB: 4096,
      nativeDirectorySnapshots180: true,
    },
  ])
    assert.throws(() => current({ ...opts, nativeQueryAffinity184: true }, {}));
  const opts = {
    storageBackend: 'postgres',
    postgres: {
      host: '127.0.0.1',
      port: 5432,
      database: 'synthetic',
      user: 'app',
      password: 'synthetic',
    },
    postgresRevisionProfile: 3,
    nativeMemoryBudgetVersion: 1,
    nativeMemoryBudgetMiB: 8192,
    nativeDirectorySnapshots180: true,
  };
  const valid = current({ ...opts, nativeQueryAffinity184: true }, {});
  assert.equal(valid.nativeQueryAffinity184, true);
});
