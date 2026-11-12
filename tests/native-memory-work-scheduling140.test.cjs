const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  createNativeMemoryWorkBudget,
} = require('../src/server/infrastructure/native-memory-work-budget.cjs');
const { createNativeExecutor } = require('../src/server/infrastructure/native-executor.cjs');
const { createNativeCommandProxy } = require('../src/server/http/native-command-proxy.cjs');
const MiB = 1024 * 1024;
const tick = () => new Promise(setImmediate);
const observed = (promise) => {
  promise.catch(() => {});
  return promise;
};
const schedulingTest = (name, run) => test(name, { timeout: 2000 }, run);

function budget(t, options = {}) {
  const value = createNativeMemoryWorkBudget({
    version: 1,
    maxBytes: 768 * MiB,
    queryBytes: 384 * MiB,
    commandBytes: 512 * MiB,
    maxPending: 32,
    waitMs: 5000,
    estimatedWorkingSet: true,
    rssHardCapClaim: false,
    ...options,
  });
  t.after(() => value.close());
  return value;
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
  reply(queryDiagnostics, body = [1, 2, 3]) {
    this.emit('message', {
      id: this.messages.at(-1).id,
      queryDiagnostics,
      result: { status: 200, headers: {}, body: Uint8Array.from(body).buffer },
    });
  }
  exit() {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', 0);
  }
}
function readers(t, workBudget, options = {}) {
  const workers = [];
  const executor = createNativeExecutor({
    filename: __filename,
    concurrency: 1,
    workBudget,
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
    run: (options) => observed(executor.run({ kind: 'query' }, options)),
    async warm() {
      const ready = executor.ready();
      workers.forEach((worker) => worker.ready());
      await ready;
    },
  };
}
function commands(t, workBudget, options = {}) {
  const calls = [];
  const leases = [];
  let owner = 0;
  const { deferReady = false, ...bounds } = options;
  const proxy = createNativeCommandProxy({
    ownerCount: 1,
    workBudget,
    endpoint: () => ({}),
    reserve(index, ticket) {
      let complete, ready;
      const completed = new Promise((resolve) => {
        complete = resolve;
      });
      const readiness = new Promise((resolve) => {
        ready = resolve;
      });
      const lease = { index, ticket, complete, ready, cancels: 0 };
      leases.push(lease);
      if (!deferReady) ready();
      return { ready: readiness, completed, cancel: () => lease.cancels++ };
    },
    createProxy() {
      const index = owner++;
      let closed = false;
      return {
        run(req) {
          if (closed) return Promise.reject(Error('Synthetic proxy closed'));
          return new Promise((resolve, reject) => calls.push({ index, req, resolve, reject }));
        },
        close() {
          closed = true;
        },
        stats: () => ({}),
      };
    },
    ...bounds,
  });
  t.after(async () => {
    proxy.close();
    calls.forEach((call) => call.resolve());
    leases.forEach((lease) => {
      lease.ready();
      lease.complete();
    });
    await tick();
  });
  return {
    proxy,
    calls,
    leases,
    run() {
      const req = new EventEmitter();
      const res = new EventEmitter();
      req.pauses = 0;
      req.pause = () => req.pauses++;
      return { req, res, result: observed(proxy.run(req, res)) };
    },
  };
}

schedulingTest(
  'a cold reader owns no work estimate and cannot block an executable command',
  async (t) => {
    const b = budget(t);
    const r = readers(t, b);
    const query = r.run();
    await tick();
    assert.equal(r.workers.length, 1);
    assert.equal(r.executor.stats().started, 0);
    assert.equal(b.stats().usedBytes, 0);
    assert.equal(b.stats().pending, 0);
    const c = commands(t, b);
    const manual = c.run();
    await tick();
    assert.equal(c.calls.length, 1);
    assert.equal(manual.req.pauses, 1);
    assert.equal(b.stats().usedBytes, 512 * MiB);
    c.calls[0].resolve();
    c.leases[0].complete();
    await manual.result;
    await tick();
    r.workers[0].ready();
    await tick();
    assert.equal(r.executor.stats().started, 1);
    r.workers[0].reply();
    (await query).release();
    assert.equal(b.stats().usedBytes, 0);
  },
);

schedulingTest(
  'a busy reader follower does not take the work needed by the next command',
  async (t) => {
    const b = budget(t);
    const r = readers(t, b);
    await r.warm();
    const first = r.run();
    await tick();
    const follower = r.run();
    let manual;
    const manualReady = observed(b.acquire('command').then((lease) => (manual = lease)));
    t.after(() => manual?.release());
    await tick();
    assert.equal(b.stats().usedBytes, 384 * MiB);
    assert.equal(b.stats().pending, 1, 'only the executable command joins shared admission');
    r.workers[0].reply();
    const response = await first;
    await tick();
    assert.ok(manual, 'physical query settlement admits the earlier executable command');
    await manualReady;
    assert.equal(r.executor.stats().started, 1);
    assert.equal(b.stats().usedBytes, 512 * MiB + 3);
    response.release();
    manual.release();
    await tick();
    assert.equal(r.executor.stats().started, 2);
    r.workers[0].reply();
    (await follower).release();
    assert.equal(b.stats().usedBytes, 0);
  },
);

schedulingTest(
  'retained response credit blocks dispatch without charging another query estimate',
  async (t) => {
    const b = budget(t);
    const r = readers(t, b, { maxResponseBytes: 8, maxRetainedBytes: 8 });
    await r.warm();
    const first = r.run();
    await tick();
    r.workers[0].reply(undefined, [1]);
    const response = await first;
    const follower = r.run();
    await tick();
    assert.equal(r.executor.stats().started, 1);
    assert.equal(b.stats().usedBytes, 1);
    assert.equal(b.stats().pending, 0);
    const manual = await b.acquire('command');
    assert.equal(b.stats().usedBytes, 512 * MiB + 1);
    manual.release();
    response.release();
    await tick();
    assert.equal(r.executor.stats().started, 2);
    r.workers[0].reply(undefined, [2]);
    (await follower).release();
    assert.equal(b.stats().usedBytes, 0);
  },
);

schedulingTest(
  'a busy command owner never admits its queued body ahead of an executable query',
  async (t) => {
    const b = budget(t, { maxBytes: 1536 * MiB });
    const c = commands(t, b);
    const first = c.run();
    await tick();
    const second = c.run();
    const third = c.run();
    const r = readers(t, b);
    await r.warm();
    const query = r.run();
    await tick();
    assert.equal(c.leases.length, 1);
    assert.equal(c.calls.length, 1);
    assert.equal(second.req.pauses, 1);
    assert.equal(third.req.pauses, 1);
    assert.equal(r.executor.stats().started, 1);
    assert.equal(b.stats().usedBytes, 896 * MiB);
    assert.equal(b.stats().admitted, 2);
    r.workers[0].reply();
    (await query).release();
    c.calls[0].resolve();
    c.leases[0].complete();
    await first.result;
    await tick();
    assert.equal(c.calls[1].req, second.req, 'owner FIFO is preserved');
    c.calls[1].resolve();
    c.leases[1].complete();
    await second.result;
    await tick();
    assert.equal(c.calls[2].req, third.req);
    c.calls[2].resolve();
    c.leases[2].complete();
    await third.result;
    await tick();
    assert.equal(b.stats().usedBytes, 0);
  },
);

schedulingTest(
  'canceling a FIFO command head before its admission callback advances the follower',
  async (t) => {
    const b = budget(t);
    const c = commands(t, b);
    const head = c.run();
    const follower = c.run();
    const failed = assert.rejects(head.result, { status: 499 });
    head.req.aborted = true;
    head.req.emit('aborted');
    await failed;
    await tick();
    assert.equal(c.leases.length, 1);
    assert.equal(c.calls.length, 1);
    assert.equal(c.calls[0].req, follower.req);
    assert.equal(b.stats().usedBytes, 512 * MiB);
    c.calls[0].resolve();
    c.leases[0].complete();
    await follower.result;
    await tick();
    assert.equal(b.stats().usedBytes, 0);
  },
);

for (const blocked of [false, true]) {
  schedulingTest(
    'a failed reader withdraws ' +
      (blocked ? 'pending admission' : 'a late grant') +
      ' until its replacement is ready',
    async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
      let now = 0;
      const b = budget(t, { now: () => now });
      const blocker = blocked ? await b.acquire('command') : null;
      const r = readers(t, b, { now: () => now });
      await r.warm();
      const query = r.run();
      r.workers[0].emit('error', Error('Synthetic reader failure'));
      now = 25;
      t.mock.timers.tick(25);
      await tick();
      assert.equal(b.stats().pending, 0);
      assert.equal(b.stats().usedBytes, blocked ? 512 * MiB : 0);
      assert.equal(r.executor.stats().started, 0);
      assert.equal(r.workers[0].messages.length, 0);
      r.workers[0].exit();
      blocker?.release();
      assert.equal(b.stats().usedBytes, 0);
      now += 100;
      t.mock.timers.tick(100);
      await tick();
      assert.equal(r.workers.length, 2);
      assert.equal(b.stats().usedBytes, 0, 'a replacement before READY cannot acquire work');
      r.workers[1].ready();
      await tick();
      assert.equal(r.executor.stats().started, 1);
      assert.equal(b.stats().usedBytes, 384 * MiB);
      r.workers[1].reply();
      (await query).release();
      assert.equal(b.stats().usedBytes, 0);
      assert.equal(b.stats().admitted, b.stats().released);
    },
  );
}

schedulingTest(
  'query admission uses the remaining original deadline after physical-slot waiting',
  async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    let now = 0;
    const b = budget(t, { now: () => now });
    const waits = [];
    const r = readers(
      t,
      {
        waitMs: b.waitMs,
        acquire(kind, options) {
          waits.push(options.timeoutMs);
          return b.acquire(kind, options);
        },
      },
      { now: () => now, timeoutMs: 1000 },
    );
    await r.warm();
    const first = r.run();
    await tick();
    const second = r.run();
    now = 900;
    r.workers[0].reply();
    (await first).release();
    await tick();
    assert.deepEqual(waits, [1000, 100]);
    assert.equal(r.executor.stats().started, 2);
    const failed = assert.rejects(second, { code: 'NATIVE_TIMEOUT', outcomeUnknown: false });
    now = 1000;
    t.mock.timers.tick(25);
    assert.equal(r.workers[0].terminateCalls, 1);
    assert.equal(b.stats().usedBytes, 384 * MiB, 'timeout cannot release unacknowledged work');
    r.workers[0].exit();
    await failed;
    assert.equal(b.stats().usedBytes, 0);
  },
);

schedulingTest(
  'physical-slot and shared-budget waiting share the five-second enqueue cutoff',
  async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    let now = 0;
    const b = budget(t, { now: () => now });
    const waits = [];
    const r = readers(
      t,
      {
        waitMs: b.waitMs,
        acquire(kind, options) {
          waits.push(options.timeoutMs);
          return b.acquire(kind, options);
        },
      },
      { now: () => now, timeoutMs: 20000 },
    );
    await r.warm();
    const first = r.run();
    await tick();
    const follower = r.run();
    const failed = assert.rejects(follower, {
      code: 'NATIVE_MEMORY_WORK_TIMEOUT',
      outcomeUnknown: false,
    });
    let manual;
    const manualReady = observed(b.acquire('command').then((lease) => (manual = lease)));
    t.after(() => manual?.release());
    now = 4900;
    t.mock.timers.tick(4900);
    r.workers[0].reply();
    (await first).release();
    await tick();
    assert.ok(manual);
    await manualReady;
    assert.deepEqual(waits, [5000, 100]);
    assert.equal(r.executor.stats().started, 1);
    now = 5000;
    t.mock.timers.tick(100);
    await failed;
    assert.equal(
      r.executor.stats().started,
      1,
      'waiting cannot acquire a fresh five-second window',
    );
    assert.equal(r.executor.stats().pending, 0);
    assert.equal(b.stats().usedBytes, 512 * MiB);
    manual.release();
    assert.equal(b.stats().usedBytes, 0);
  },
);

schedulingTest(
  'command admission and owner readiness share the original queue deadline',
  async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    let now = 0;
    const b = budget(t, { now: () => now });
    const waits = [];
    const c = commands(
      t,
      {
        waitMs: b.waitMs,
        acquire(kind, options) {
          waits.push(options.timeoutMs);
          return b.acquire(kind, options);
        },
      },
      { now: () => now, waitMs: 100, deferReady: true },
    );
    const first = c.run();
    await tick();
    c.leases[0].ready();
    await tick();
    const second = c.run();
    now = 80;
    c.calls[0].resolve();
    c.leases[0].complete();
    await first.result;
    await tick();
    assert.deepEqual(waits, [100, 20]);
    assert.equal(c.leases.length, 2);
    const failed = assert.rejects(second.result, { status: 504 });
    now = 99;
    t.mock.timers.tick(19);
    await tick();
    assert.equal(c.calls.length, 1);
    now = 100;
    t.mock.timers.tick(1);
    await failed;
    assert.equal(c.calls.length, 1, 'an unready owner was never forwarded the body');
    assert.equal(c.leases[1].cancels, 1);
    assert.equal(b.stats().usedBytes, 512 * MiB);
    c.leases[1].complete();
    await tick();
    assert.equal(b.stats().usedBytes, 0);
  },
);

function diagnosticSnapshot() {
  const routes = {};
  for (const name of [
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
  ])
    routes[name] = {
      count: 1,
      errors: 0,
      rpcCalls: 2,
      operationSqlCalls: 0,
      authMs: 0.1,
      projectionMs: 0.2,
      serializeMs: 0.3,
      totalMs: 0.6,
    };
  return {
    version: 1,
    routes,
    pool: {
      hits: 1,
      misses: 2,
      opens: 3,
      openErrors: 0,
      evictions: 0,
      closes: 1,
      closeErrors: 0,
      openMs: 1.5,
      closeMs: 0.5,
      connections: 2,
    },
  };
}
schedulingTest(
  'valid closed query diagnostics are cloned on receipt and on every stats read',
  async (t) => {
    const b = budget(t);
    const r = readers(t, b);
    await r.warm();
    const query = r.run();
    await tick();
    const source = diagnosticSnapshot();
    const expected = structuredClone(source);
    r.workers[0].reply(source);
    const response = await query;
    assert.deepEqual(r.executor.stats().queryDiagnostics, [{ index: 0, snapshot: expected }]);
    source.routes.patient.count = 99;
    source.pool.connections = 99;
    const external = r.executor.stats().queryDiagnostics;
    external[0].snapshot.routes.patient.count = 100;
    external[0].snapshot.pool.connections = 100;
    assert.deepEqual(r.executor.stats().queryDiagnostics, [{ index: 0, snapshot: expected }]);
    assert.deepEqual([...response.body], [1, 2, 3]);
    response.release();
  },
);
for (const [name, damage] of [
  [
    'arbitrary URL route',
    (s) => {
      s.routes['https://synthetic.invalid/patient/id'] = s.routes.patient;
      delete s.routes.patient;
    },
  ],
  [
    'arbitrary ID key',
    (s) => {
      s.pool.organizationId = 42;
    },
  ],
  [
    'NaN timing',
    (s) => {
      s.routes.calendar.authMs = NaN;
    },
  ],
  [
    'negative timing',
    (s) => {
      s.pool.openMs = -1;
    },
  ],
  [
    'fractional route count',
    (s) => {
      s.routes.patient.count = 0.5;
    },
  ],
  [
    'fractional pool count',
    (s) => {
      s.pool.connections = 0.5;
    },
  ],
  [
    'infinite timing',
    (s) => {
      s.routes.operation.totalMs = Infinity;
    },
  ],
]) {
  schedulingTest(
    'invalid diagnostics (' + name + ') become null without rejecting a normal reply',
    async (t) => {
      const b = budget(t);
      const r = readers(t, b);
      await r.warm();
      const query = r.run();
      await tick();
      const snapshot = diagnosticSnapshot();
      damage(snapshot);
      r.workers[0].reply(snapshot);
      const response = await query;
      assert.equal(response.status, 200);
      assert.deepEqual([...response.body], [1, 2, 3]);
      assert.deepEqual(r.executor.stats().queryDiagnostics, [{ index: 0, snapshot: null }]);
      assert.equal(r.workers[0].terminateCalls, 0);
      response.release();
    },
  );
}

schedulingTest(
  '153 closed cache diagnostics accept numeric version2 and reject private additions',
  async (t) => {
    const b = budget(t),
      r = readers(t, b);
    await r.warm();
    const valid = {
      ...diagnosticSnapshot(),
      version: 2,
      readViews: {
        hits: 1,
        misses: 2,
        invalidated: 0,
        rejected: 0,
        entries: 1,
        sqlResults: { hits: 3, misses: 1, rejected: 0, entries: 1 },
      },
    };
    for (const privateField of [false, true]) {
      const pending = r.run();
      await tick();
      const value = structuredClone(valid);
      if (privateField) value.readViews.sqlResults.privateSql = 'synthetic-private';
      r.workers[0].reply(value);
      const response = await pending;
      response.release();
      assert.deepEqual(r.executor.stats().queryDiagnostics, [
        { index: 0, snapshot: privateField ? null : valid },
      ]);
    }
  },
);
