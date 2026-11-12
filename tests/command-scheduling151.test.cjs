const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createNativeCommandProxy } = require('../src/server/http/native-command-proxy.cjs');
const {
  createNativeMemoryBudget,
} = require('../src/server/infrastructure/native-memory-budget.cjs');
const {
  createNativeMemoryWorkBudget,
} = require('../src/server/infrastructure/native-memory-work-budget.cjs');
const {
  isCommandNotStarted,
} = require('../src/server/infrastructure/native-command-outcome151.cjs');
const tick = () => new Promise(setImmediate);
test('151 different cabinets execute independently, one cabinet stays ordered and full writes are exclusive', async () => {
  const memory = createNativeMemoryBudget({ budgetMiB: 1536, commandCount: 2, postgres: true });
  assert.equal(memory.totals.workingAllocatedMiB, 1536);
  const budget = createNativeMemoryWorkBudget(memory.workAdmission),
    calls = [],
    tickets = [];
  const proxy = createNativeCommandProxy({
    endpoint: (index) => ({ index }),
    workBudget: budget,
    reserve(index) {
      let complete;
      const completed = new Promise((yes) => (complete = yes));
      tickets[index] = complete;
      return { ready: Promise.resolve(), completed, cancel: complete };
    },
    createProxy: ({ endpoint }) => ({
      run(req) {
        return new Promise((resolve) =>
          calls.push({
            org: req.headers['x-cartoteca-organization-id'],
            finish() {
              tickets[endpoint().index]({ retainedBytes: 2 * 1024 ** 2 });
              resolve();
            },
          }),
        );
      },
      stats: () => ({}),
      close() {},
    }),
  });
  const run = (org, method = 'POST') => {
    const req = Object.assign(new EventEmitter(), {
        method,
        headers: { 'x-cartoteca-organization-id': org },
        pause() {},
      }),
      res = new EventEmitter();
    return proxy.run(req, res);
  };
  const a = run('a');
  await tick();
  const same = run('a'),
    b = run('b');
  await tick();
  assert.deepEqual(
    calls.map((c) => c.org),
    ['a', 'b'],
  );
  assert.equal(budget.stats().usedBytes, 1024 * 1024 ** 2);
  const heavy = run('c', 'PATCH');
  calls[1].finish();
  await b;
  await tick();
  assert.equal(calls.length, 2);
  calls[0].finish();
  await a;
  await tick();
  assert.equal(calls[2].org, 'c');
  assert.equal(budget.stats().usedBytes, 1024 * 1024 ** 2);
  let readAdmitted = false;
  const read = budget.acquire('query-probe').then((lease) => {
    readAdmitted = true;
    lease.release();
  });
  await tick();
  assert.equal(readAdmitted, false);
  calls[2].finish();
  await heavy;
  await read;
  await tick();
  assert.equal(calls[3].org, 'a');
  calls[3].finish();
  await same;
  await tick();
  assert.equal(budget.stats().usedBytes, 0);
  proxy.close();
  budget.close();
});
test('151 only a private before-forward proof classifies a failed command as not started', async () => {
  const error = Object.assign(Error('SQL unknown'), { status: 503 });
  const proxy = createNativeCommandProxy({
    endpoint: () => ({}),
    ownerCount: 1,
    reserve() {
      throw error;
    },
    createProxy: () => ({
      run() {
        assert.fail('must not forward');
      },
      close() {},
      stats: () => ({}),
    }),
  });
  const req = Object.assign(new EventEmitter(), { pause() {} }),
    res = new EventEmitter();
  await assert.rejects(proxy.run(req, res), (e) => isCommandNotStarted(e));
  proxy.close();
  assert.equal(
    isCommandNotStarted(Object.assign(Error('forged'), { code: 'CABINET_COMMAND_NOT_STARTED' })),
    false,
  );
});
