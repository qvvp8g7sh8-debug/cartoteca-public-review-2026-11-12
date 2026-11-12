// Actual PG + actual native-query-worker proposal; no direct-kernel substitute.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { calendarFixture163 } = require('./helpers/postgres-calendar163-fixture.cjs');
const {
  prepareHotMetadata169,
} = require('../src/server/infrastructure/postgres/hot-metadata-prepare169.cjs');
const { createNativeExecutor } = require('../src/server/infrastructure/native-executor.cjs');
const {
  createNativeMemoryWorkBudget,
} = require('../src/server/infrastructure/native-memory-work-budget.cjs');
const {
  isPostgresReadOperation,
} = require('../src/server/infrastructure/postgres/read-operation-routes145.cjs');
const MiB = 1024 * 1024;
test(
  '169 actual PG worker transfers two hot1SQL unchanged replies with original limits',
  { timeout: 120000 },
  async (t) => {
    const f = await calendarFixture163(t),
      replies = [],
      live = new Set();
    let executor,
      spawned = 0,
      peak = 0;
    const config = {
      dataDir: f.dir,
      storageBackend: 'postgres',
      postgres: f.runtime.application,
      postgresRevisionProfile: 3,
      cabinetSchema: 2,
      notificationSchema: 19,
      origin: 'http://127.0.0.1:4174',
      host: '127.0.0.1',
      port: 4174,
      production: false,
      sharedCabinetWrites: true,
      commonNotificationsEnabled: true,
      maxEnabled: false,
      pushEnabled: false,
      tenantReadCacheBytes: 8 * MiB,
    };
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
    function metadata(url, actor) {
      return {
        method: 'GET',
        url,
        headers: {
          host: '127.0.0.1:4174',
          cookie: 'cartoteca_v2_session=' + actor.token,
          'x-cartoteca-account-id': actor.accountId,
          'x-cartoteca-organization-id': actor.organizationId,
        },
        runtime: {
          timestamp: Date.now(),
          telegram: { configured: false, connected: false, botId: '' },
          providers: {
            telegram: { configured: false, connected: false, botId: '' },
            max: { configured: false, connected: false, botId: '' },
          },
        },
      };
    }
    async function get(url, actor) {
      const r = await executor.run({ kind: 'query', metadata: metadata(url, actor) });
      replies.push(r);
      assert.equal(r.status, 200, r.body.toString());
      assert.ok(r.body.byteLength <= 65536);
      const body = JSON.parse(r.body.toString());
      r.release();
      return body;
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
      await f.admin.query('BEGIN');
      try {
        await prepareHotMetadata169(f.admin, f.runtime.application.user, {
          marker: f.identity.lineage,
        });
        await f.admin.query('COMMIT');
      } catch (error) {
        await f.admin.query('ROLLBACK');
        throw error;
      }
      executor = createNativeExecutor({
        filename,
        workerData: { config },
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
          w.on('message', (message) => {
            if (message.result || message.error) live.delete(message.id);
          });
          return w;
        },
      });
      await executor.ready();
      const actors = [f.actors[0], f.actors[1]],
        cold = await Promise.all(actors.map((a) => get(f.url, a))),
        before = snapshot();
      assert.ok(cold.every((b) => String(b.version).startsWith('c163.')));
      const hot = await Promise.all(actors.map((a, i) => get(f.conditional(cold[i]), a))),
        after = snapshot();
      for (let i = 0; i < hot.length; i++)
        assert.deepEqual(hot[i], { revision: cold[i].revision, unchanged: true });
      assert.equal(
        after.routes.calendar.operationSqlCalls - before.routes.calendar.operationSqlCalls,
        2,
        'one actual SQL for each hot reply',
      );
      assert.equal(after.routes.calendar.count - before.routes.calendar.count, 2);
      assert.equal(after.routes.calendar.rpcCalls, 0);
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
