const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const legacy = require('./fixtures/native-memory-legacy180.json');
const MiB = 1024 * 1024;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const after = (name) => require('../' + name);
const next = after('src/server/infrastructure/native-memory-budget.cjs');
const old = next; // The independently pinned fixture above verifies every old4096 result.
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
  nativeMemoryBudgetMiB: 8192,
  nativeQueryWorkers: 6,
  nativeCommandOwners: 4,
  nativeCommandIsolation: true,
  ...extra,
});

test('182 existing48legacy and30managed4096 plans retain independently pinned180 JSON hashes', () => {
  assert.equal(legacy.plans.length, 78);
  for (const row of legacy.plans)
    assert.equal(hash(JSON.stringify(next.createNativeMemoryBudget(row.input))), row.jsonSHA256);
});

test('8192 all30 topology plans retain ceilings, operation estimates and external share accounting', () => {
  for (const commandCount of [2, 3, 4])
    for (const queryConcurrency of [2, 3, 4, 5, 6])
      for (const releaseGate of [false, true]) {
        const input = {
          postgres: true,
          commandCount,
          queryConcurrency,
          releaseGate,
        };
        const a = next.createNativeMemoryBudget({ ...input, budgetMiB: 8192 });
        const b = old.createNativeMemoryBudget({ ...input, budgetMiB: 4096 });
        assert.deepEqual(a.topology, b.topology);
        assert.deepEqual(a.workAdmission, b.workAdmission);
        assert.ok(a.totals.workingAllocatedMiB <= 8192);
        assert.equal(a.processes[0].queryCacheBytes, 192 * MiB);
        assert.equal(a.processes[0].cacheBytes, queryConcurrency * 192 * MiB);
        assert.ok(
          a.totals.cacheBytes + a.totals.bufferReserveBytes <= a.reserves.externalMiB * MiB,
        );
        for (let i = 0; i < a.processes.length; i++) {
          assert.deepEqual(a.processes[i].execArgv, b.processes[i].execArgv);
          assert.deepEqual(
            a.processes[i].workerResourceLimits,
            b.processes[i].workerResourceLimits,
          );
          assert.equal(a.processes[i].heapCeilingMiB, b.processes[i].heapCeilingMiB);
          if (i) assert.deepEqual(a.processes[i], b.processes[i]);
        }
        assert.equal(a.rssHardCapClaim, false);
        assert.equal(a.noOomGuarantee, true);
      }
  const p = next.createNativeMemoryBudget({
    budgetMiB: 8192,
    commandCount: 4,
    queryConcurrency: 6,
    postgres: true,
  });
  assert.equal(p.processes[0].workingOldTargetMiB, 93);
  assert.equal(p.processes[0].cacheBytes, 1152 * MiB);
  assert.equal(p.processes[0].queryCacheBytes, 192 * MiB);
  assert.equal(p.totals.workingAllocatedMiB, 6073);
  assert.equal(p.totals.workingUnallocatedMiB, 2119);
  assert.equal((p.totals.cacheBytes + p.totals.bufferReserveBytes) / MiB, 1632);
  assert.equal(p.workAdmission.maxBytes, 3008 * MiB);
});

test('8192 and snapshots fail closed outside managedPG3; enlarged config cache is explicit8192 only', () => {
  const { configuration } = after('src/server/config.cjs');
  const { nativeCommandOwnerCount } = after('src/server/infrastructure/native-command-routes.cjs');
  const config = configuration(
    managed({
      tenantReadCacheBytes: 1152 * MiB,
      nativeDirectorySnapshots180: true,
    }),
    {},
  );
  assert.equal(nativeCommandOwnerCount(config), 4);
  assert.equal(next.configuredNativeMemoryBudget(config, 4).budgetMiB, 8192);
  for (const extra of [
    { storageBackend: 'sqlite' },
    { postgresRevisionProfile: 2 },
    { nativeMemoryBudgetVersion: 0 },
    { nativeCommandIsolation: false },
    { tenantReadCacheBytes: 1152 * MiB + 1 },
    { nativeDirectorySnapshots180: 'true' },
  ])
    assert.throws(() => configuration(managed(extra), {}));
  for (const nativeMemoryBudgetMiB of [1536, 2560, 4096])
    assert.throws(() =>
      configuration(
        managed({
          nativeQueryWorkers: 2,
          nativeCommandOwners: 2,
          nativeMemoryBudgetMiB,
          tenantReadCacheBytes: 513 * MiB,
        }),
        {},
      ),
    );
  assert.throws(() => configuration({ nativeDirectorySnapshots180: true }, {}));
  assert.equal(Object.hasOwn(configuration({}, {}), 'nativeDirectorySnapshots180'), false);
  for (const commandCount of [0, 1, 5])
    assert.throws(() =>
      next.createNativeMemoryBudget({
        budgetMiB: 8192,
        commandCount,
        postgres: true,
      }),
    );
});

test('new directory policy is immutable while old budget shape and charged LRU remain intact', () => {
  const { createReadCacheBudget } = after('src/server/infrastructure/read-cache-budget.cjs');
  const a = createReadCacheBudget({ maxBytes: 10 });
  assert.deepEqual(Object.keys(a), legacy.cacheBudgetKeys);
  assert.deepEqual(a.stats(), legacy.cacheBudgetStats);
  const policy = createReadCacheBudget({
    maxBytes: 10,
    directoryMaxRows: 150000,
  });
  assert.equal(policy.directoryMaxRows, 150000);
  assert.equal(Object.getOwnPropertyDescriptor(policy, 'directoryMaxRows').writable, false);
  for (const directoryMaxRows of [0, 50000, 150001, '150000'])
    assert.throws(() => createReadCacheBudget({ directoryMaxRows }));
  let evicted = 0;
  assert.equal(
    policy.retain({}, 8, () => evicted++),
    true,
  );
  assert.equal(
    policy.retain({}, 8, () => evicted++),
    true,
  );
  assert.equal(evicted, 1);
  assert.equal(
    policy.retain({}, 11, () => evicted++),
    false,
  );
  assert.equal(policy.stats().bytes, 8);
  assert.equal(policy.stats().rejected, 1);
});

test('directory retains1001500-row bases only under the optional policy, and still evicts at its bound', () => {
  const rows = Array.from({ length: 1500 }, (_, n) => ({
    id: String(n),
    name: 'Synthetic ' + n,
  }));
  for (const expanded of [false, true]) {
    delete require.cache[require.resolve('../src/server/modules/cabinet/directory.cjs')];
    const fresh = after,
      { cachedRows } = fresh('src/server/modules/cabinet/directory.cjs');
    const budget = fresh('src/server/infrastructure/read-cache-budget.cjs').createReadCacheBudget({
      maxBytes: 192 * MiB,
      ...(expanded ? { directoryMaxRows: 150000 } : {}),
    });
    const storages = Array.from({ length: expanded ? 101 : 34 }, (_, n) => ({
      filename: 'synthetic-' + n,
      encode() {},
      readCacheBudget: budget,
    }));
    const current = {
      organizationId: 'synthetic',
      accountId: 'synthetic',
      role: 'owner',
    };
    for (const storage of storages.slice(0, expanded ? 100 : 34))
      assert.equal(
        cachedRows(storage, current, { revision: 1, directory: rows }).rows.length,
        1500,
      );
    const mustHit = {
      revision: 1,
      get directory() {
        throw Error('BASE_EVICTED180');
      },
    };
    if (expanded) {
      assert.equal(cachedRows(storages[0], current, mustHit).rows.length, 1500);
      cachedRows(storages[100], current, { revision: 1, directory: rows });
      assert.throws(() => cachedRows(storages[1], current, mustHit), /BASE_EVICTED180/);
    } else assert.throws(() => cachedRows(storages[0], current, mustHit), /BASE_EVICTED180/);
    assert.ok(budget.stats().bytes <= 192 * MiB);
    budget.clear();
  }
});

test('182 isolatedserver propagates192MiB/query and trusted policy atq2/q6 with actual gateway ceiling', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--max-old-space-size=256',
      '--max-semi-space-size=2',
      '--stack-size=2048',
      path.join(__dirname, 'helpers/native-memory-capacity182-client.cjs'),
    ],
    {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 65536,
      env: { ...process.env, NODE_OPTIONS: '' },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const proof = JSON.parse(result.stdout);
  assert.deepEqual(proof.queryCounts, [2, 6]);
  assert.equal(proof.actualGatewayHeapMiB, 262);
  assert.equal(proof.mockedApplicationOwners, true);
});
