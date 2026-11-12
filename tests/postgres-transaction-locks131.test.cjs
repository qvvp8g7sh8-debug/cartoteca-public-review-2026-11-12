const test = require('node:test');
const assert = require('node:assert/strict');
const {
  lockBatch,
  runLockBatch,
} = require('../src/server/infrastructure/postgres/transaction-locks.cjs');
const { lockPlan } = require('../src/server/infrastructure/postgres/lock-intents.cjs');
const locks = [
  { key: '11', shared: true },
  { key: '12', shared: false },
  { key: '-13', shared: true },
];
test('ordered try-lock batches retain bound keys, exact modes and prefix dependencies', () => {
  for (const operation of ['session', 'transaction']) {
    const plan = lockBatch(locks, operation);
    assert.deepEqual(plan.values, ['11', '12', '-13']);
    assert.equal((plan.text.match(/AS MATERIALIZED/g) || []).length, 3);
    assert.equal((plan.text.match(/CASE WHEN locked THEN/g) || []).length, 2);
    assert.match(plan.text, /ct_lock_1 AS MATERIALIZED .* FROM ct_lock_0\)/);
    assert.match(plan.text, /ct_lock_2 AS MATERIALIZED .* FROM ct_lock_1\)/);
    assert.ok(!plan.text.includes('11'));
    assert.ok(
      plan.text.includes(
        operation === 'session' ? 'pg_try_advisory_lock(' : 'pg_try_advisory_xact_lock(',
      ),
    );
  }
});
test('ordered unlock batches attempt every supplied key even after a false result', () => {
  const plan = lockBatch([...locks].reverse(), 'release');
  assert.deepEqual(plan.values, ['-13', '12', '11']);
  assert.ok(!plan.text.includes('CASE WHEN'));
  assert.match(plan.text, /pg_advisory_unlock_shared\(\$1::bigint\)/);
  assert.match(plan.text, /pg_advisory_unlock\(\$2::bigint\).* FROM ct_lock_0/);
});
test('closed batch inputs reject duplicate, injected, invalid and out-of-range lock keys', () => {
  for (const invalid of [
    [{ key: '1;SELECT 1', shared: true }],
    [{ key: '9223372036854775808', shared: true }],
    [{ key: '-9223372036854775809', shared: true }],
    [{ key: '-0', shared: true }],
    [{ key: '01', shared: true }],
    [{ key: '1', shared: 1 }],
    [locks[0], locks[0]],
    Array.from({ length: 17 }, (_, index) => ({ key: String(index), shared: true })),
  ])
    assert.throws(() => lockBatch(invalid, 'session'), { code: 'POSTGRES_LOCK_BATCH_INVALID' });
  assert.throws(() => lockBatch(locks, 'caller-supplied-function'), {
    code: 'POSTGRES_LOCK_BATCH_INVALID',
  });
});
test('one SQL query returns a validated confirmed prefix and empty plans perform no SQL', async () => {
  const calls = [],
    client = {
      query: async (text, values) => {
        calls.push({ text, values });
        return { rows: [{ locked: [true, false, false] }] };
      },
    };
  assert.deepEqual(await runLockBatch(client, [], 'session'), []);
  assert.equal(calls.length, 0);
  assert.deepEqual(await runLockBatch(client, locks, 'session'), [true, false, false]);
  assert.equal(calls.length, 1);
});
test('missing, malformed and non-prefix acquisition results fail closed', async () => {
  for (const reply of [
    {},
    { rows: [] },
    { rows: [{ locked: [true] }] },
    { rows: [{ locked: [true, 1, false] }] },
    { rows: [{ locked: [false, true, true] }] },
    { rows: [{ locked: [true, false, true] }] },
    { rows: [{ locked: [true, true, true] }, { locked: [true, true, true] }] },
  ])
    await assert.rejects(runLockBatch({ query: async () => reply }, locks, 'session'), {
      code: 'POSTGRES_LOCK_BATCH_INVALID',
    });
  assert.deepEqual(
    await runLockBatch(
      { query: async () => ({ rows: [{ locked: [false, true, false] }] }) },
      locks,
      'release',
    ),
    [false, true, false],
  );
});
test('all existing root plans use three lock queries around BEGIN without dropping any key', async () => {
  const platform = { kind: 'platform', storeId: 'synthetic-platform' },
    cabinet = { kind: 'cabinet', storeId: 'synthetic-cabinet' };
  for (const [scope, mode] of [
    [platform, 'IMMEDIATE'],
    [platform, 'QUEUE'],
    [cabinet, 'IMMEDIATE'],
    [cabinet, 'READONLY'],
  ]) {
    const requested = lockPlan(scope, mode, mode === 'IMMEDIATE' || mode === 'QUEUE'),
      calls = [],
      client = {
        query: async (_text, values) => {
          calls.push(values);
          return { rows: [{ locked: values.map(() => true) }] };
        },
      };
    await runLockBatch(client, requested, 'session');
    await runLockBatch(client, requested, 'transaction');
    await runLockBatch(client, [...requested].reverse(), 'release');
    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls[0],
      requested.map((x) => x.key),
    );
    assert.deepEqual(calls[1], calls[0]);
    assert.deepEqual(calls[2], [...calls[0]].reverse());
    if (scope === platform && mode === 'IMMEDIATE') assert.equal(requested.length * 3 + 1, 10);
  }
});

function lockFaultWorker() {
  const { EventEmitter } = require('node:events');
  const { workerData } = require('node:worker_threads');
  const proof = new Int32Array(workerData.proof);
  class Client extends EventEmitter {
    async connect() {}
    async query(text, values = []) {
      if (text.startsWith('WITH ct_lock_0 AS MATERIALIZED')) {
        if (text.includes('pg_try_advisory_lock')) {
          Atomics.store(proof, 0, 1); // A real prefix may exist before the fault.
          if (workerData.failMode === 'query')
            throw Object.assign(Error('Synthetic partial batch query failure'), { code: '57014' });
          if (workerData.failMode === 'reply') return { rows: [{ locked: [true, false, true] }] };
        }
        if (text.includes('pg_advisory_unlock') && workerData.failMode === 'unlock')
          return { rows: [{ locked: values.map((_, index) => index !== 1) }] };
        return { rows: [{ locked: values.map(() => true) }] };
      }
      return { rows: [] };
    }
    async end() {
      Atomics.store(proof, 1, 1);
    }
  }
  require.cache[workerData.pgPath] = {
    id: workerData.pgPath,
    filename: workerData.pgPath,
    loaded: true,
    exports: { Client, Query: EventEmitter, types: { setTypeParser() {} } },
  };
  require(workerData.driverFile);
}
test('real driver worker poisons and closes unknown partial batches and failed session cleanup', async (t) => {
  const { Worker } = require('node:worker_threads');
  const { createTransport } = require('../src/server/infrastructure/postgres/transport.cjs');
  for (const failMode of ['query', 'reply', 'unlock'])
    await t.test(failMode, async (t) => {
      const proof = new SharedArrayBuffer(8),
        counters = new Int32Array(proof),
        transport = createTransport({
          timeoutMs: 3000,
          workerFactory: (driverFile, settings) =>
            new Worker(`(${lockFaultWorker.toString()})()`, {
              ...settings,
              eval: true,
              workerData: {
                ...settings.workerData,
                proof,
                failMode,
                driverFile,
                pgPath: require.resolve('pg'),
              },
            }),
        });
      t.after(() => transport.close());
      await transport.ready();
      assert.throws(
        () =>
          transport.request({
            op: 'begin',
            scope: { kind: 'platform', storeId: 'synthetic-batch131' },
            mode: 'IMMEDIATE',
          }),
        (error) =>
          error.channelPoisoned === true &&
          error.retryableBeforeBegin !== true &&
          (failMode !== 'query' || error.code === '57014'),
      );
      assert.equal(Atomics.load(counters, 0), 1);
      assert.equal(
        Atomics.load(counters, 1),
        1,
        'unknown session ownership closes its physical connection',
      );
      assert.equal(transport.stats().poisoned, true);
      assert.throws(
        () =>
          transport.request({
            op: 'begin',
            scope: { kind: 'platform', storeId: 'synthetic-batch131' },
            mode: 'IMMEDIATE',
          }),
        (error) => error.channelPoisoned === true,
        'poisoned connection cannot be reused or retried',
      );
    });
});
