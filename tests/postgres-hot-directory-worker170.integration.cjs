const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { hotDirectoryFixture170 } = require('./helpers/postgres-hot-directory170-fixture.cjs');
const { createNativeExecutor } = require('../src/server/infrastructure/native-executor.cjs');
const {
  createNativeMemoryWorkBudget,
} = require('../src/server/infrastructure/native-memory-work-budget.cjs');
const {
  isPostgresReadOperation,
} = require('../src/server/infrastructure/postgres/read-operation-routes145.cjs');
const MiB = 1024 * 1024;

test(
  '170 actual native worker transfers independent hot1SQL directory UTF8 with original limits',
  { timeout: 180000 },
  async (t) => {
    const f = await hotDirectoryFixture170(t),
      replies = [],
      live = new Set();
    let executor,
      spawned = 0,
      peak = 0;
    const work = createNativeMemoryWorkBudget({
      version: 1,
      maxBytes: 1024 * MiB,
      queryBytes: 384 * MiB,
      queryProbeBytes: 96 * MiB,
      commandBytes: 512 * MiB,
      estimatedWorkingSet: true,
      rssHardCapClaim: false,
    });
    const filename = path.resolve(
      __dirname,
      '../src/server/infrastructure/native-query-worker.cjs',
    );
    async function get(actor) {
      const r = await executor.run({ kind: 'query', metadata: f.metadata(f.directoryUrl, actor) });
      replies.push(r);
      assert.equal(r.status, 200, r.body.toString());
      assert.ok(r.body.byteLength <= 65536);
      const bytes = Buffer.from(r.body);
      r.release();
      return bytes;
    }
    function snapshot() {
      const q = executor.stats().queryDiagnostics;
      assert.equal(q.length, 1);
      const s = q[0].snapshot;
      assert.ok(s);
      assert.equal(s.version, 3);
      return s;
    }
    try {
      executor = createNativeExecutor({
        filename,
        workerData: { config: f.config },
        concurrency: 1,
        workBudget: work,
        boundedRead: isPostgresReadOperation,
        timeoutMs: 30000,
        startupMs: 30000,
        cancelGraceMs: 100,
        workerFactory(file, options) {
          assert.equal(path.resolve(file), filename);
          assert.deepEqual(options.resourceLimits, {
            maxOldGenerationSizeMb: 256,
            maxYoungGenerationSizeMb: 32,
            stackSizeMb: 4,
          });
          const w = new Worker(file, options),
            post = w.postMessage.bind(w);
          spawned++;
          w.postMessage = (message, transfer) => {
            if (message.kind === 'query') {
              live.add(message.id);
              peak = Math.max(peak, live.size);
            }
            return post(message, transfer);
          };
          w.on('message', (m) => {
            if (m.result || m.error) live.delete(m.id);
          });
          return w;
        },
      });
      await executor.ready();
      const actors = [f.actors[0], f.actors[1]];
      const cold = await Promise.all(actors.map(get));
      const before = snapshot();
      const hot = await Promise.all(actors.map(get));
      const after = snapshot();
      for (let i = 0; i < hot.length; i++) assert.deepEqual(hot[i], cold[i]);
      assert.match(cold[0].toString('utf8'), /Бета/);
      hot[0].fill(0);
      assert.deepEqual(
        await get(actors[0]),
        cold[0],
        'transfer/mutation cannot detach or alter retained cache',
      );
      assert.equal(
        after.routes.directory.operationSqlCalls - before.routes.directory.operationSqlCalls,
        2,
      );
      assert.equal(after.routes.directory.count - before.routes.directory.count, 2);
      assert.equal(after.routes.directory.rpcCalls, 0);
      assert.equal(spawned, 1);
      assert.equal(peak, 2);
      assert.equal(executor.stats().active, 0);
      assert.equal(executor.stats().reservedBytes, 0);
      assert.equal(executor.stats().retainedBytes, 0);
      assert.equal(executor.stats().queryUpgradeRequested, 0);
      assert.equal(work.stats().usedBytes, 0);
      assert.ok(work.stats().peakBytes <= 192 * MiB + 4 * 65536);
    } finally {
      for (const r of replies) r.release();
      await executor?.close({ force: true });
      work.close();
      await f.close();
    }
  },
);
