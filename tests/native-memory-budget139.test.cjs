const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  createNativeMemoryBudget,
  nativeMemoryProcess,
  assertNativeMemoryEnvironment,
  configuredNativeMemoryBudget,
} = require('../src/server/infrastructure/native-memory-budget.cjs');
const {
  sampleIsolateMemory,
  normalizeNativeMemoryReport,
} = require('../src/server/infrastructure/native-memory-observation.cjs');
const MiB = 1024 * 1024;
const helper = path.join(__dirname, 'helpers/native-memory-physical139.cjs');
const branch = (label, children = []) => ({ label, children });
const topology = {
  gateway: [branch('query-0', [branch('sql-0')]), branch('query-1', [branch('sql-1')])],
  web: [branch('sql')],
  background: [branch('sql'), branch('lease')],
  command: [branch('sql')],
  'command-1': [branch('sql')],
};
function flat(report) {
  return [report, ...report.children.flatMap(flat)];
}
async function probe(t, processPlan, options = {}) {
  const child = spawn(process.execPath, [...(options.flags ?? processPlan.execArgv), helper], {
    env: { ...process.env, NODE_OPTIONS: '', MEMORY_PROBE_SECRET: 'PRIVATE_PHYSICAL_SENTINEL' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const output = [];
  let bytes = 0,
    stderrBytes = 0,
    closed = false,
    exceeded = false;
  const timer = setTimeout(() => {
    exceeded = true;
    child.kill();
  }, 20000);
  t.after(() => {
    clearTimeout(timer);
    if (!closed) child.kill();
  });
  child.stdout.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > 65536) {
      exceeded = true;
      child.kill();
    } else output.push(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 65536) {
      exceeded = true;
      child.kill();
    }
  });
  const outcome = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      closed = true;
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(
      JSON.stringify({
        processPlan,
        label: processPlan.identity,
        tree: topology[processPlan.identity],
        unattested: options.unattested === true,
        clearWorkerExecArgv: options.clearWorkerExecArgv === true,
      }),
    );
  });
  assert.deepEqual(
    { ...outcome, exceeded, stderrBytes },
    {
      code: 0,
      signal: null,
      exceeded: false,
      stderrBytes: 0,
    },
  );
  const raw = Buffer.concat(output).toString('utf8');
  assert.equal(raw.includes('PRIVATE_PHYSICAL_SENTINEL'), false);
  return JSON.parse(raw);
}
for (const budgetMiB of [1536, 2560]) {
  test(
    `actual CLI compatibility ceilings and working targets ${budgetMiB} remain distinct across fourteen isolates`,
    {
      timeout: 45000,
    },
    async (t) => {
      const plan = createNativeMemoryBudget({ budgetMiB, commandCount: 2, postgres: true });
      const compatible = {
        gateway: 256,
        web: 768,
        background: 256,
        command: 768,
        'command-1': 768,
      };
      const working =
        budgetMiB === 1536
          ? { gateway: 48, web: 64, background: 64, command: 64, 'command-1': 64 }
          : { gateway: 80, web: 112, background: 112, command: 96, 'command-1': 96 };
      let observed = 0,
        actualHeapCeilingsMiB = 0;
      for (const processPlan of plan.processes) {
        assert.equal(processPlan.oldGenerationMiB, compatible[processPlan.identity]);
        assert.equal(processPlan.workingOldTargetMiB, working[processPlan.identity]);
        assert.equal(processPlan.semiSpaceMiB, 2);
        assert.equal(processPlan.stackMiB, 2);
        const result = await probe(t, processPlan);
        const isolates = flat(result);
        assert.equal(isolates.length, processPlan.isolateCount);
        observed += isolates.length;
        for (const isolate of isolates) {
          actualHeapCeilingsMiB += isolate.sample.heapSizeLimitBytes / MiB;
          assert.equal(isolate.accepted, true);
          assert.equal(isolate.sample.heapSizeLimitBytes, processPlan.heapCeilingMiB * MiB);
          assert.deepEqual(isolate.attestation, {
            version: 1,
            identity: processPlan.identity,
            heapSizeLimitBytes: isolate.sample.heapSizeLimitBytes,
          });
          assert.equal(isolate.sample.pid, result.sample.pid);
        }
        assert.equal(new Set(isolates.map((row) => row.sample.threadId)).size, isolates.length);
        assert.equal(result.sample.threadId, 0);
      }
      assert.equal(observed, 14);
      assert.equal(plan.topology.isolateCount, observed);
      assert.equal(actualHeapCeilingsMiB, 6740);
      assert.equal(actualHeapCeilingsMiB, plan.totals.compatibilityHeapCeilingsMiB);
      assert.equal(plan.totals.oldGenerationMiB, 6656);
      assert.equal(plan.totals.workingOldTargetMiB, budgetMiB === 1536 ? 816 : 1344);
      assert.equal(plan.totals.workingAllocatedMiB, budgetMiB);
      assert.equal(plan.totals.workingUnallocatedMiB, 0);
      assert.equal(Object.hasOwn(plan.totals, 'allocatedMiB'), false);
      assert.equal(Object.hasOwn(plan.totals, 'unallocatedMiB'), false);
      assert.equal(plan.model, 'working-targets-and-compatible-ceilings-v2');
      assert.equal(plan.heapCeilingsOverSubscribed, true);
      assert.equal(
        plan.rssHardCapClaim,
        false,
        'V8 ceilings and working targets are not an RSS guarantee',
      );
    },
  );
}
test(
  'actual parent CLI overrides requested Worker limits even with empty worker execArgv',
  {
    timeout: 20000,
  },
  async (t) => {
    const plan = createNativeMemoryBudget({ budgetMiB: 1536, commandCount: 2, postgres: true });
    const processPlan = nativeMemoryProcess(plan, 'gateway');
    const result = await probe(t, processPlan, {
      flags: ['--max-old-space-size=768', '--max-semi-space-size=2', '--stack-size=2048'],
      unattested: true,
      clearWorkerExecArgv: true,
    });
    for (const isolate of flat(result)) {
      assert.equal(isolate.accepted, true);
      assert.equal(isolate.attestation, null);
      assert.equal(isolate.sample.heapSizeLimitBytes, result.sample.heapSizeLimitBytes);
      assert.ok(isolate.sample.heapSizeLimitBytes > processPlan.heapCeilingMiB * MiB);
    }
  },
);
test(
  'missing or wrong actual CLI cap cannot attest readiness or start descendants',
  {
    timeout: 30000,
  },
  async (t) => {
    const plan = createNativeMemoryBudget({ budgetMiB: 1536, commandCount: 2, postgres: true });
    const processPlan = nativeMemoryProcess(plan, 'gateway');
    for (const flags of [[], ['--max-old-space-size=768', '--max-semi-space-size=2']]) {
      const result = await probe(t, processPlan, { flags });
      assert.equal(result.accepted, false);
      assert.equal(result.code, 'NATIVE_MEMORY_BUDGET_MISMATCH');
      assert.equal(result.descendantsStarted, 0);
      assert.deepEqual(result.children, []);
      assert.notEqual(result.sample.heapSizeLimitBytes, processPlan.heapCeilingMiB * MiB);
    }
  },
);
test('public memory diagnostics keep only physical counters and never worker RSS or secrets', () => {
  const actual = sampleIsolateMemory();
  const secret = 'PRIVATE_MEMORY_PASSWORD_ACTOR_SQL_ARGUMENT';
  const dirty = (threadId) => ({
    ...actual,
    threadId,
    rssBytes: actual.rssBytes,
    message: secret,
    stack: secret,
    sql: secret,
    connection: secret,
    env: { TOKEN: secret },
    argv: [secret],
    account: secret,
  });
  const report = normalizeNativeMemoryReport({
    pid: actual.pid,
    main: dirty(0),
    database: dirty(1),
    lease: dirty(2),
    token: secret,
  });
  assert.ok(report);
  assert.deepEqual(Object.keys(report).sort(), ['database', 'lease', 'main', 'pid']);
  const scalar = [
    'pid',
    'threadId',
    'heapSizeLimitBytes',
    'heapUsedBytes',
    'heapTotalBytes',
    'externalBytes',
    'arrayBuffersBytes',
    'sampleAtMs',
  ];
  assert.deepEqual(Object.keys(report.main).sort(), [...scalar, 'rssBytes'].sort());
  for (const sample of [report.database, report.lease]) {
    assert.deepEqual(Object.keys(sample).sort(), [...scalar].sort());
    assert.equal(Object.hasOwn(sample, 'rssBytes'), false);
  }
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(JSON.stringify(actual).includes('PRIVATE_'), false);
});
test('memory report rejects wrong thread roles, duplicate worker identities and cross-process samples', () => {
  const actual = sampleIsolateMemory();
  const worker = (threadId) => {
    const sample = { ...actual, threadId };
    delete sample.rssBytes;
    return sample;
  };
  const base = { pid: actual.pid, main: actual, database: worker(1), lease: worker(2) };
  for (const changed of [
    { ...base, main: worker(3) },
    { ...base, database: actual },
    { ...base, lease: worker(1) },
    { ...base, database: { ...worker(1), pid: actual.pid + 1 } },
    { ...base, main: { ...actual, externalBytes: NaN } },
  ]) {
    assert.throws(() => normalizeNativeMemoryReport(changed), {
      code: 'NATIVE_MEMORY_BUDGET_MISMATCH',
    });
  }
  const nested = normalizeNativeMemoryReport(
    {
      pid: actual.pid,
      main: worker(3),
      database: worker(4),
      lease: null,
    },
    { allowWorkerMain: true },
  );
  assert.equal(nested.main.threadId, 3);
  assert.equal(Object.hasOwn(nested.main, 'rssBytes'), false);
  assert.equal(Object.hasOwn(nested.database, 'rssBytes'), false);
  assert.throws(
    () =>
      normalizeNativeMemoryReport(
        {
          pid: actual.pid,
          main: worker(3),
          database: worker(3),
          lease: null,
        },
        { allowWorkerMain: true },
      ),
    { code: 'NATIVE_MEMORY_BUDGET_MISMATCH' },
  );
});
test('legacy memory mode remains opt-in and incompatible explicit budgets fail closed', () => {
  assert.equal(configuredNativeMemoryBudget({ storageBackend: 'postgres' }, 2), null);
  assert.equal(
    configuredNativeMemoryBudget({ nativeMemoryBudgetVersion: 0, nativeMemoryBudgetMiB: 0 }, 2),
    null,
  );
  for (const config of [
    { nativeMemoryBudgetVersion: 0, nativeMemoryBudgetMiB: 1536 },
    { nativeMemoryBudgetVersion: 1, nativeMemoryBudgetMiB: 768 },
  ])
    assert.throws(() => configuredNativeMemoryBudget(config, 2), {
      code: 'NATIVE_MEMORY_BUDGET_INVALID',
    });
});
test('environment conflicts reject without exposing values and benign preloads remain untouched', () => {
  for (const flag of [
    '--max_old_space_size=512',
    '"--max-semi-space-size=8"',
    '--max-old-space-size-percentage=50',
    '--stack_size=4096',
    '--max-heap-size 512',
  ]) {
    const environment = { NODE_OPTIONS: `${flag} --title=PRIVATE_NODE_ARGUMENT` };
    const original = environment.NODE_OPTIONS;
    assert.throws(
      () => assertNativeMemoryEnvironment(environment),
      (error) => {
        assert.equal(error.code, 'NATIVE_MEMORY_FLAGS_CONFLICT');
        assert.equal(
          JSON.stringify({ message: error.message, code: error.code }).includes('PRIVATE_'),
          false,
        );
        return true;
      },
    );
    assert.equal(environment.NODE_OPTIONS, original);
  }
  const environment = { NODE_OPTIONS: '--require "synthetic preload.cjs" --trace-warnings' };
  assert.doesNotThrow(() => assertNativeMemoryEnvironment(environment));
  assert.equal(environment.NODE_OPTIONS, '--require "synthetic preload.cjs" --trace-warnings');
});
