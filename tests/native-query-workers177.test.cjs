const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { configuration } = require('../src/server/config.cjs');
const { createIsolatedServer } = require('../src/server/application/isolated-server.cjs');
const {
  createNativeMemoryBudget,
  configuredNativeMemoryBudget,
  nativeMemoryProcess,
} = require('../src/server/infrastructure/native-memory-budget.cjs');
const MiB = 1024 * 1024;
const managed = (workers, budget = 1536) => ({
  storageBackend: 'postgres',
  postgresRevisionProfile: 3,
  postgres: {
    host: '127.0.0.1',
    port: 5432,
    database: 'synthetic',
    user: 'synthetic',
    password: 'synthetic',
  },
  nativeMemoryBudgetVersion: 1,
  nativeMemoryBudgetMiB: budget,
  nativeQueryWorkers: workers,
});

test('177 omitted query count is byte-for-byte explicit two across the existing plan matrix', () => {
  assert.equal(configuration({}, {}).nativeQueryWorkers, 2);
  assert.equal(configuration({}, { CARTOTECA_NATIVE_QUERY_WORKERS: '4' }).nativeQueryWorkers, 2);
  for (const budgetMiB of [1536, 2560])
    for (const commandCount of [0, 1, 2])
      for (const releaseGate of [false, true]) {
        const options = { budgetMiB, commandCount, releaseGate, postgres: true };
        const implicit = createNativeMemoryBudget(options);
        const explicit = createNativeMemoryBudget({ ...options, queryConcurrency: 2 });
        assert.equal(JSON.stringify(implicit), JSON.stringify(explicit));
        assert.deepEqual(
          configuredNativeMemoryBudget({ ...managed(2, budgetMiB), releaseGate }, commandCount),
          explicit,
        );
      }
  assert.equal(configuredNativeMemoryBudget({ storageBackend: 'postgres' }, 2), null);
});

test('177 three/four readers redistribute fixed targets while retaining caps, work window and cache allocation', () => {
  for (const budgetMiB of [1536, 2560]) {
    const baseline = createNativeMemoryBudget({ budgetMiB, commandCount: 2, postgres: true });
    for (const queryConcurrency of [3, 4]) {
      const plan = createNativeMemoryBudget({
        budgetMiB,
        commandCount: 2,
        postgres: true,
        queryConcurrency,
      });
      assert.equal(
        configuration(managed(queryConcurrency, budgetMiB), {}).nativeQueryWorkers,
        queryConcurrency,
      );
      assert.deepEqual(configuredNativeMemoryBudget(managed(queryConcurrency, budgetMiB), 2), plan);
      assert.deepEqual(plan.workAdmission, baseline.workAdmission);
      assert.deepEqual(plan.reserves, baseline.reserves);
      assert.equal(plan.topology.processCount, 5);
      assert.equal(plan.topology.queryWorkers, queryConcurrency);
      assert.equal(plan.topology.sqlWorkers, queryConcurrency + 4);
      assert.equal(plan.topology.isolateCount, queryConcurrency === 3 ? 16 : 18);
      const gateway = nativeMemoryProcess(plan, 'gateway');
      const original = nativeMemoryProcess(baseline, 'gateway');
      assert.equal(gateway.cacheBytes, original.cacheBytes);
      assert.equal(gateway.queryCacheBytes, Math.floor(original.cacheBytes / queryConcurrency));
      assert.ok(gateway.queryCacheBytes * queryConcurrency <= original.cacheBytes);
      assert.equal(gateway.heapCeilingMiB, original.heapCeilingMiB);
      assert.deepEqual(gateway.execArgv, original.execArgv);
      assert.deepEqual(gateway.workerResourceLimits, original.workerResourceLimits);
      for (const identity of ['web', 'background', 'command', 'command-1'])
        assert.deepEqual(
          nativeMemoryProcess(plan, identity),
          nativeMemoryProcess(baseline, identity),
        );
      assert.ok(plan.totals.workingAllocatedMiB <= budgetMiB);
      assert.equal(plan.rssHardCapClaim, false);
      assert.equal(plan.workAdmission.maxPending, 32);
      assert.equal(plan.workAdmission.waitMs, 5000);
      const gate = createNativeMemoryBudget({
        budgetMiB,
        commandCount: 2,
        postgres: true,
        queryConcurrency,
        releaseGate: true,
      });
      assert.equal(gate.topology.isolateCount, plan.topology.isolateCount - 1);
    }
  }
  const three = createNativeMemoryBudget({
    budgetMiB: 1536,
    commandCount: 2,
    postgres: true,
    queryConcurrency: 3,
  });
  const four = createNativeMemoryBudget({
    budgetMiB: 1536,
    commandCount: 2,
    postgres: true,
    queryConcurrency: 4,
  });
  assert.equal(nativeMemoryProcess(three, 'gateway').workingOldTargetMiB, 32);
  assert.equal(nativeMemoryProcess(three, 'gateway').queryCacheBytes, 5592405);
  assert.equal(three.totals.workingAllocatedMiB, 1536);
  assert.equal(nativeMemoryProcess(four, 'gateway').workingOldTargetMiB, 23);
  assert.equal(nativeMemoryProcess(four, 'gateway').queryCacheBytes, 4 * MiB);
  assert.equal(four.totals.workingAllocatedMiB, 1535);
  assert.equal(four.totals.workingUnallocatedMiB, 1);
});

test('177 invalid and unmanaged counts are refused before isolated startup creates data or workers', async () => {
  const invalid = [0, 1, 5, -1, 2.5, NaN, Infinity, '', ' ', 'garbage'];
  for (const count of invalid) {
    assert.throws(() =>
      createNativeMemoryBudget({
        budgetMiB: 1536,
        commandCount: 2,
        postgres: true,
        queryConcurrency: count,
      }),
    );
    const directory = path.join(os.tmpdir(), 'cartoteca-reject177-' + randomUUID());
    await assert.rejects(
      createIsolatedServer({ ...managed(count), dataDir: directory }),
      /Invalid native query workers|4096\/8192 MiB/,
    );
    assert.equal(fs.existsSync(directory), false);
  }
  for (const options of [
    { nativeQueryWorkers: 4 },
    { ...managed(3), postgresRevisionProfile: 2 },
    { ...managed(4), nativeMemoryBudgetVersion: 0, nativeMemoryBudgetMiB: 0 },
    { ...managed(4), storageBackend: 'sqlite' },
  ]) {
    const directory = path.join(os.tmpdir(), 'cartoteca-unmanaged177-' + randomUUID());
    await assert.rejects(createIsolatedServer({ ...options, dataDir: directory }));
    assert.equal(fs.existsSync(directory), false);
    assert.throws(() => configuredNativeMemoryBudget(options, 2));
  }
  assert.throws(() =>
    createNativeMemoryBudget({
      budgetMiB: 1536,
      commandCount: 2,
      postgres: false,
      queryConcurrency: 4,
    }),
  );
});
