const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter, once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const { createNativeCommandProxy } = require('../src/server/http/native-command-proxy.cjs');
const {
  createNativeMemoryWorkBudget,
} = require('../src/server/infrastructure/native-memory-work-budget.cjs');
const {
  createCommandResponseBudget,
  createCommandTicketState,
  commandRetainedFloor,
  commandRetainedLimit,
} = require('../src/server/infrastructure/native-command-ticket.cjs');
const {
  nativeCommandOwnerCount,
} = require('../src/server/infrastructure/native-command-routes.cjs');
const {
  createNativeMemoryBudget,
} = require('../src/server/infrastructure/native-memory-budget.cjs');
const MiB = 1024 ** 2;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const turn = () => new Promise((resolve) => setImmediate(resolve));
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
function pair() {
  const req = new EventEmitter(),
    res = new EventEmitter();
  req.pause = () => {};
  req.aborted = false;
  res.destroyed = false;
  return { req, res };
}
function fixture() {
  const work = budget(),
    done = deferred(),
    wire = deferred();
  let cancelled = 0;
  const proxy = createNativeCommandProxy({
    ownerCount: 1,
    workBudget: work,
    endpoint: () => ({}),
    reserve: () => ({
      ready: Promise.resolve(),
      completed: done.promise,
      cancel() {
        cancelled++;
      },
    }),
    createProxy: () => ({ run: () => wire.promise, close() {}, stats: () => ({}) }),
  });
  return {
    work,
    done,
    wire,
    proxy,
    get cancelled() {
      return cancelled;
    },
  };
}
test('actual paused HTTP drain admits a real query after measured physical completion without freeing command owner', async () => {
  const work = budget(),
    completed = deferred(),
    observed = deferred();
  const upstream = http.createServer((req, res) => {
    req.resume();
    const retained = createCommandResponseBudget(res);
    res.end(Buffer.alloc(12 * MiB, 97));
    const bytes = retained();
    completed.resolve({ retainedBytes: bytes });
    observed.resolve(bytes);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const proxy = createNativeCommandProxy({
    ownerCount: 1,
    workBudget: work,
    endpoint: () => ({
      host: '127.0.0.1',
      port: upstream.address().port,
      transportToken: 'fixture',
    }),
    reserve: () => ({ ready: Promise.resolve(), completed: completed.promise, cancel() {} }),
  });
  const gateway = http.createServer((req, res) => {
    void proxy.run(req, res).catch((error) => res.destroy(error));
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  let request, response, query;
  try {
    const got = deferred();
    request = http.get({ host: '127.0.0.1', port: gateway.address().port, path: '/' }, (res) => {
      response = res;
      res.pause();
      got.resolve();
    });
    request.on('error', got.reject);
    await got.promise;
    const bytes = await observed.promise;
    await turn();
    assert.equal(bytes, commandRetainedFloor + 36 * MiB);
    assert.equal(proxy.stats().active, 1);
    assert.equal(work.stats().usedBytes, bytes);
    query = await work.acquire('query', { timeoutMs: 1000 });
    assert.equal(work.stats().usedBytes, bytes + 384 * MiB);
    assert.equal(proxy.stats().active, 1, 'physical ACK must not make a draining owner reusable');
    query.release();
    query = null;
    response.resume();
    await once(response, 'end');
    for (let i = 0; i < 100 && proxy.stats().active; i++) await sleep(5);
    assert.equal(proxy.stats().active, 0);
    assert.equal(work.stats().usedBytes, 0);
  } finally {
    query?.release();
    request?.destroy();
    response?.destroy();
    proxy.close();
    gateway.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise((r) => gateway.close(r)),
      new Promise((r) => upstream.close(r)),
    ]);
    work.close();
  }
});
test('late physical ACK retains full working lease after HTTP finish until actual owner completion', async () => {
  const f = fixture(),
    { req, res } = pair();
  const run = f.proxy.run(req, res);
  await turn();
  assert.equal(f.work.stats().usedBytes, 512 * MiB);
  f.wire.resolve();
  await run;
  await turn();
  assert.equal(f.proxy.stats().active, 1);
  assert.equal(f.work.stats().usedBytes, 512 * MiB);
  f.done.resolve({ retainedBytes: commandRetainedFloor });
  await turn();
  assert.equal(f.proxy.stats().active, 0);
  assert.equal(f.work.stats().usedBytes, 0);
  f.proxy.close();
  f.work.close();
});
test('owner measurement preserves exact UTF8 chunks, restores methods and fails closed on unended or oversized output', () => {
  const originalWrite = function () {
      return true;
    },
    originalEnd = function () {
      return this;
    };
  let res = { write: originalWrite, end: originalEnd };
  let finish = createCommandResponseBudget(res);
  res.write('Юлия');
  res.end(Buffer.from('123'));
  assert.equal(finish(), commandRetainedFloor + 3 * (Buffer.byteLength('Юлия') + 3));
  assert.equal(res.write, originalWrite);
  assert.equal(res.end, originalEnd);
  res = { write: originalWrite, end: originalEnd };
  finish = createCommandResponseBudget(res);
  res.write('unsettled');
  assert.equal(finish(), null);
  res = { write: originalWrite, end: originalEnd };
  finish = createCommandResponseBudget(res);
  const chunk = Buffer.alloc(3 * MiB);
  for (let i = 0; i < 64; i++) res.write(chunk);
  res.end();
  assert.equal(
    finish(),
    null,
    'large valid replies retain full admission, never change response semantics',
  );
  const calls = [];
  const tickets = createCommandTicketState((...args) => calls.push(args));
  const id = '11111111-1111-1111-1111-111111111111';
  assert(tickets.reserve(id));
  const complete = tickets.begin(id);
  complete(commandRetainedFloor);
  complete(0);
  assert.deepEqual(calls, [[id, commandRetainedFloor]]);
});
test('invalid or absent retained metadata cannot reduce a draining command reservation', async () => {
  for (const bytes of [undefined, 0, -1, NaN, commandRetainedLimit + 1]) {
    const f = fixture(),
      { req, res } = pair();
    const run = f.proxy.run(req, res);
    await turn();
    f.done.resolve({ retainedBytes: bytes });
    await turn();
    assert.equal(f.work.stats().usedBytes, 512 * MiB);
    assert.equal(f.proxy.stats().active, 1);
    f.wire.resolve();
    await run;
    await turn();
    assert.equal(f.work.stats().usedBytes, 0);
    f.proxy.close();
    f.work.close();
  }
});
test('failed or cancelled HTTP never releases a running transaction before private physical settlement', async () => {
  for (const code of ['ROLLBACK', 'CANCELLED']) {
    const f = fixture(),
      { req, res } = pair();
    const run = f.proxy.run(req, res);
    const rejected = assert.rejects(run, { code });
    await turn();
    f.wire.reject(Object.assign(Error(code), { code }));
    await rejected;
    await turn();
    assert.equal(f.cancelled, 1);
    assert.equal(f.work.stats().usedBytes, 512 * MiB);
    assert.equal(f.proxy.stats().active, 1);
    f.done.resolve({ retainedBytes: null });
    await turn();
    assert.equal(f.proxy.stats().active, 0);
    assert.equal(f.work.stats().usedBytes, 0);
    f.proxy.close();
    f.work.close();
  }
});

test('151/152 managed profiles retain two bounded owners and preserve the mixed work bound', async () => {
  const config = { storageBackend: 'postgres', postgresRevisionProfile: 3 };
  assert.equal(nativeCommandOwnerCount(config), 2);
  assert.equal(
    nativeCommandOwnerCount({
      ...config,
      nativeMemoryBudgetVersion: 1,
      nativeMemoryBudgetMiB: 2560,
    }),
    2,
  );
  const count = nativeCommandOwnerCount({
    ...config,
    nativeMemoryBudgetVersion: 1,
    nativeMemoryBudgetMiB: 1536,
  });
  assert.equal(count, 2);
  const plan = createNativeMemoryBudget({ budgetMiB: 1536, commandCount: count, postgres: true });
  assert.equal(plan.topology.processCount, 5);
  assert.equal(plan.topology.isolateCount, 14);
  assert.equal(plan.totals.workingUnallocatedMiB, 0);
  assert.equal(plan.workAdmission.maxBytes, 1024 * MiB);
  assert.equal(plan.workAdmission.queryBytes, 384 * MiB);
  assert.equal(plan.workAdmission.commandBytes, 512 * MiB);
  const work = createNativeMemoryWorkBudget(plan.workAdmission);
  const query = await work.acquire('query');
  const command = await work.acquire('command');
  assert.equal(work.stats().usedBytes, 896 * MiB);
  const blocked = work.acquire('command', { timeoutMs: 20 });
  const rejected = assert.rejects(blocked, { code: 'NATIVE_MEMORY_WORK_TIMEOUT' });
  await sleep(30);
  await rejected;
  command.release();
  query.release();
  work.close();
});
