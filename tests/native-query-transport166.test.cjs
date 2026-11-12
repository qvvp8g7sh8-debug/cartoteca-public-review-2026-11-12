const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createNativeExecutor } = require('../src/server/infrastructure/native-executor.cjs');
const {
  createNativeMemoryWorkBudget,
} = require('../src/server/infrastructure/native-memory-work-budget.cjs');
const MiB = 1024 * 1024;
test('166 actual two-worker transfer preserves per-job bodies and closed v3 snapshots with two jobs per worker', async (t) => {
  const workBudget = createNativeMemoryWorkBudget({
    version: 1,
    maxBytes: 1024 * MiB,
    queryBytes: 384 * MiB,
    queryProbeBytes: 96 * MiB,
    commandBytes: 512 * MiB,
    waitMs: 1000,
    estimatedWorkingSet: true,
    rssHardCapClaim: false,
  });
  const executor = createNativeExecutor({
    filename: path.resolve(__dirname, 'fixtures/query-worker166.cjs'),
    concurrency: 2,
    workBudget,
    boundedRead: () => true,
    timeoutMs: 3000,
    startupMs: 3000,
    cancelGraceMs: 100,
  });
  t.after(async () => {
    await executor.close({ force: true });
    workBudget.close();
  });
  await executor.ready();
  const replies = await Promise.all(
    ['a', 'b', 'c', 'd'].map((tag, index) =>
      executor.run({
        kind: 'query',
        metadata: { tag, bytes: index === 3 ? 128 * 1024 : 31 },
      }),
    ),
  );
  assert.equal(new Set(replies.map((reply) => reply.headers['x-thread'])).size, 2);
  assert.equal(
    replies.every((reply) => reply.headers['x-peak'] === '2'),
    true,
  );
  for (let index = 0; index < replies.length; index++) {
    assert.equal(replies[index].body.length, index === 3 ? 128 * 1024 : 31);
    assert.equal(
      replies[index].body.every((byte) => byte === 'abcd'.charCodeAt(index)),
      true,
    );
  }
  const stats = executor.stats();
  assert.equal(stats.workers, 2);
  assert.equal(stats.active, 0);
  assert.equal(stats.reservedBytes, 0);
  assert.equal(
    stats.queryDiagnostics.every((row) => row.snapshot?.version === 3),
    true,
  );
  assert.equal(
    stats.queryDiagnostics.every((row) => row.snapshot.routes.directory.count === 2),
    true,
  );
  assert.equal(JSON.stringify(stats.queryDiagnostics).includes('directoryResponses165'), true);
  replies.forEach((reply) => reply.release());
  assert.equal(executor.stats().retainedBytes, 0);
  assert.equal(workBudget.stats().usedBytes, 0);
});
