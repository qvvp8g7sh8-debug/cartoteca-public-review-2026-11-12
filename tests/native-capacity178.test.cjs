const test = require('node:test');
const assert = require('node:assert/strict');
const { configuration } = require('../src/server/config.cjs');
const {
  nativeCommandOwnerCount,
} = require('../src/server/infrastructure/native-command-routes.cjs');
const {
  createNativeMemoryBudget,
  configuredNativeMemoryBudget,
  nativeMemoryProcess,
} = require('../src/server/infrastructure/native-memory-budget.cjs');
const MiB = 1024 * 1024;
const managed = (extra = {}) => ({
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
  nativeMemoryBudgetMiB: 4096,
  nativeCommandIsolation: true,
  ...extra,
});

test('178 trusted options retain legacy default two owners/readers and do not derive counts from environment', () => {
  const defaults = configuration(
    {},
    { CARTOTECA_NATIVE_QUERY_WORKERS: '6', CARTOTECA_NATIVE_COMMAND_OWNERS: '4' },
  );
  assert.equal(defaults.nativeQueryWorkers, 2);
  assert.equal(defaults.nativeCommandOwners, 2);
  for (const budgetMiB of [1536, 2560]) {
    const options = managed({ nativeMemoryBudgetMiB: budgetMiB });
    const implicit = configuration(options, {});
    const explicit = configuration(
      { ...options, nativeQueryWorkers: 2, nativeCommandOwners: 2 },
      {},
    );
    assert.equal(nativeCommandOwnerCount(implicit), 2);
    assert.equal(
      JSON.stringify(configuredNativeMemoryBudget(implicit, nativeCommandOwnerCount(implicit))),
      JSON.stringify(configuredNativeMemoryBudget(explicit, nativeCommandOwnerCount(explicit))),
    );
    const plan = configuredNativeMemoryBudget(implicit, 2);
    assert.equal(plan.topology.isolateCount, 14);
    assert.equal(plan.totals.workingAllocatedMiB, budgetMiB);
    assert.equal(plan.totals.compatibilityHeapCeilingsMiB, 6740);
  }
});

test('178 managed4096 models all supported owner/reader combinations within one unchanged operation contract', () => {
  for (const nativeCommandOwners of [2, 3, 4])
    for (const nativeQueryWorkers of [2, 3, 4, 5, 6]) {
      const config = configuration(managed({ nativeCommandOwners, nativeQueryWorkers }), {});
      assert.equal(nativeCommandOwnerCount(config), nativeCommandOwners);
      const plan = configuredNativeMemoryBudget(config, nativeCommandOwners);
      assert.equal(plan.topology.processCount, 3 + nativeCommandOwners);
      assert.equal(plan.topology.sqlWorkers, 2 + nativeQueryWorkers + nativeCommandOwners);
      assert.equal(plan.topology.queryWorkers, nativeQueryWorkers);
      assert.ok(plan.totals.workingAllocatedMiB <= 4096);
      assert.equal(plan.workAdmission.maxBytes, 3008 * MiB);
      assert.equal(plan.workAdmission.commandBytes, 512 * MiB);
      assert.equal(plan.workAdmission.queryBytes, 384 * MiB);
      assert.equal(plan.workAdmission.queryProbeBytes, 96 * MiB);
      assert.equal(plan.workAdmission.maxPending, 32);
      assert.equal(plan.workAdmission.waitMs, 5000);
      assert.equal(plan.rssHardCapClaim, false);
      const gate = createNativeMemoryBudget({
        budgetMiB: 4096,
        commandCount: nativeCommandOwners,
        queryConcurrency: nativeQueryWorkers,
        postgres: true,
        releaseGate: true,
      });
      assert.equal(gate.topology.isolateCount, plan.topology.isolateCount - 1);
      for (const process of plan.processes)
        assert.equal(
          process.oldGenerationMiB,
          ['gateway', 'background'].includes(process.role) ? 256 : 768,
        );
    }
  const plan = createNativeMemoryBudget({
    budgetMiB: 4096,
    commandCount: 4,
    queryConcurrency: 6,
    postgres: true,
  });
  assert.deepEqual(
    plan.processes.map((p) => p.identity),
    ['gateway', 'web', 'background', 'command', 'command-1', 'command-2', 'command-3'],
  );
  assert.deepEqual(plan.topology, {
    processCount: 7,
    queryWorkers: 6,
    sqlWorkers: 12,
    leaseWorkers: 1,
    isolateCount: 26,
  });
  assert.equal(plan.totals.workingAllocatedMiB, 4085);
  assert.equal(plan.totals.workingUnallocatedMiB, 11);
  assert.equal(nativeMemoryProcess(plan, 'command-3').role, 'command');
  assert.throws(() => nativeMemoryProcess(plan, 'command-4'));
});

test('178 extra owners/readers and4096 profile fail closed outside the explicit managed PostgreSQL isolation', () => {
  for (const extra of [
    { nativeCommandOwners: 4, nativeMemoryBudgetMiB: 1536 },
    { nativeCommandOwners: 3, nativeMemoryBudgetMiB: 2560 },
    { nativeQueryWorkers: 5, nativeMemoryBudgetMiB: 1536 },
    { nativeQueryWorkers: 6, nativeMemoryBudgetMiB: 2560 },
    { nativeCommandIsolation: false },
    { storageBackend: 'sqlite' },
    { postgresRevisionProfile: 2 },
    { nativeMemoryBudgetVersion: 0 },
  ])
    assert.throws(() => configuration(managed(extra), {}));
  for (const value of [0, 1, 5, -1, 2.5, NaN, Infinity, '', 'bad'])
    assert.throws(() => configuration(managed({ nativeCommandOwners: value }), {}));
  for (const value of [0, 1, 7, -1, 2.5, NaN, Infinity, '', 'bad'])
    assert.throws(() => configuration(managed({ nativeQueryWorkers: value }), {}));
  for (const commandCount of [0, 1, 5])
    assert.throws(() =>
      createNativeMemoryBudget({
        budgetMiB: 4096,
        commandCount,
        queryConcurrency: 6,
        postgres: true,
      }),
    );
  assert.throws(() =>
    createNativeMemoryBudget({
      budgetMiB: 4096,
      commandCount: 4,
      queryConcurrency: 6,
      postgres: false,
    }),
  );
  assert.throws(() =>
    nativeCommandOwnerCount({
      ...managed(),
      nativeCommandOwners: 4,
      nativeCommandIsolation: false,
    }),
  );
});
