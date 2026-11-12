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
const MiB = 1024 * 1024;
const tick = () => new Promise(setImmediate);
function fixture(transportFailure) {
  const plan = createNativeMemoryBudget({
    budgetMiB: 4096,
    commandCount: 4,
    postgres: true,
    queryConcurrency: 6,
  });
  const budget = createNativeMemoryWorkBudget(plan.workAdmission);
  const calls = [],
    tickets = new Map();
  let reserved = 0;
  const proxy = createNativeCommandProxy({
    ownerCount: 4,
    endpoint: (index) => ({ index }),
    workBudget: budget,
    reserve(index, ticket) {
      reserved++;
      let complete;
      const completed = new Promise((resolve) => {
        complete = resolve;
      });
      tickets.set(ticket, complete);
      return {
        ready: Promise.resolve(),
        completed,
        cancel() {
          complete({ retainedBytes: 2 * MiB });
        },
      };
    },
    createProxy: ({ endpoint }) => ({
      run(req) {
        const selected = endpoint();
        if (transportFailure) {
          calls.push({ org: req.headers['x-cartoteca-organization-id'], index: selected.index });
          return Promise.reject(transportFailure);
        }
        return new Promise((resolve) =>
          calls.push({
            org: req.headers['x-cartoteca-organization-id'],
            index: selected.index,
            finish() {
              tickets.get(selected.commandTicket)({ retainedBytes: 2 * MiB });
              resolve();
            },
          }),
        );
      },
      stats: () => ({}),
      close() {},
    }),
  });
  const run = (org, method = 'POST') =>
    proxy.run(
      Object.assign(new EventEmitter(), {
        method,
        headers: { 'x-cartoteca-organization-id': org },
        pause() {},
      }),
      new EventEmitter(),
    );
  return { proxy, budget, calls, run, reservations: () => reserved };
}

test('178 four distinct cabinet POSTs own four slots; same cabinet orders and full PATCH waits for all owners', async () => {
  const f = fixture();
  const active = ['a', 'b', 'c', 'd'].map((org) => f.run(org));
  await tick();
  assert.equal(f.calls.length, 4);
  assert.equal(new Set(f.calls.map((call) => call.index)).size, 4);
  assert.equal(f.budget.stats().usedBytes, 2048 * MiB);
  const same = f.run('a'),
    exclusive = f.run('exclusive', 'PATCH');
  for (const index of [1, 2, 3]) f.calls[index].finish();
  await Promise.all(active.slice(1));
  await tick();
  assert.equal(f.calls.length, 4);
  f.calls[0].finish();
  await active[0];
  await tick();
  assert.equal(f.calls[4].org, 'exclusive');
  assert.equal(f.budget.stats().usedBytes, 3008 * MiB);
  let readAdmitted = false;
  const read = f.budget.acquire('query-probe').then((lease) => {
    readAdmitted = true;
    lease.release();
  });
  await tick();
  assert.equal(readAdmitted, false);
  f.calls[4].finish();
  await exclusive;
  await read;
  await tick();
  assert.equal(f.calls[5].org, 'a');
  f.calls[5].finish();
  await same;
  await tick();
  assert.equal(f.reservations(), 6);
  assert.equal(f.budget.stats().usedBytes, 0);
  f.proxy.close();
  f.budget.close();
});

test('178 an uncertain forwarded POST is never replayed through another free owner', async () => {
  const uncertain = Object.assign(Error('Synthetic unknown after forward'), {
    status: 503,
    outcomeUnknown: true,
  });
  const f = fixture(uncertain);
  await assert.rejects(f.run('a'), (error) => error === uncertain && !isCommandNotStarted(error));
  await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.reservations(), 1);
  assert.equal(f.budget.stats().usedBytes, 0);
  f.proxy.close();
  f.budget.close();
});

test('178 closing four active owners refuses waiting work without returning active memory before completion', async () => {
  const f = fixture();
  const active = ['a', 'b', 'c', 'd'].map((org) => f.run(org));
  await tick();
  const waiting = assert.rejects(f.run('e'), (error) => isCommandNotStarted(error));
  f.proxy.close();
  await waiting;
  assert.equal(f.budget.stats().usedBytes, 2048 * MiB);
  for (const call of f.calls) call.finish();
  await Promise.all(active);
  await tick();
  assert.equal(f.calls.length, 4);
  assert.equal(f.budget.stats().usedBytes, 0);
  f.budget.close();
});
