// Proposed166: actual PostgreSQL + actual native-query-worker startup/IPC.
// No direct-kernel or synthetic query-job substitute for this transport test.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { calendarFixture163 } = require('./helpers/postgres-calendar163-fixture.cjs');
const { createNativeExecutor } = require('../src/server/infrastructure/native-executor.cjs');
const {
  createNativeMemoryWorkBudget,
} = require('../src/server/infrastructure/native-memory-work-budget.cjs');
const {
  isPostgresReadOperation,
} = require('../src/server/infrastructure/postgres/read-operation-routes145.cjs');
const MiB = 1024 * 1024;

test(
  '166 actual PG query worker advertises two owners and transfers non-null v3 diagnostics',
  { timeout: 120000 },
  async (t) => {
    const f = await calendarFixture163(t);
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
    const live = new Set(),
      replies = [];
    let executor,
      spawned = 0,
      peak = 0,
      feature;
    const metadata = (url, actor = f.actors[0]) => ({
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
    });
    async function get(url, actor) {
      const response = await executor.run({ kind: 'query', metadata: metadata(url, actor) });
      replies.push(response);
      assert.equal(response.status, 200, response.body.toString());
      assert.ok(
        response.body.byteLength <= 65536,
        'this startup/protocol fixture stays a small probe',
      );
      const body = JSON.parse(response.body.toString());
      response.release();
      return body;
    }
    try {
      executor = createNativeExecutor({
        filename,
        workerData: { config },
        concurrency: 1,
        workBudget: work,
        boundedRead: isPostgresReadOperation,
        timeoutMs: 30000,
        startupMs: 30000,
        cancelGraceMs: 100,
        workerFactory(actualFilename, options) {
          assert.equal(path.resolve(actualFilename), filename);
          assert.deepEqual(
            options.resourceLimits,
            {
              maxOldGenerationSizeMb: 256,
              maxYoungGenerationSizeMb: 32,
              stackSizeMb: 4,
            },
            'the existing worker heap envelope is unchanged',
          );
          const worker = new Worker(actualFilename, options),
            post = worker.postMessage.bind(worker);
          spawned++;
          worker.postMessage = (message, transfer) => {
            if (message.kind === 'query') {
              live.add(message.id);
              peak = Math.max(peak, live.size);
            }
            return post(message, transfer);
          };
          worker.on('message', (message) => {
            if (message.ready) feature = message.queryFeatures166;
            if (message.result || message.error) live.delete(message.id);
          });
          return worker;
        },
      });
      await executor.ready();
      assert.deepEqual(feature, { version: 1, capacity: 2, replyCredit: true });
      const directory = '/api/cabinet/directory?q=Synthetic&today=2035-01-01&limit=1';
      const [owner, staff] = await Promise.all([
        get(directory, f.actors[0]),
        get(directory, f.actors[1]),
      ]);
      assert.equal(owner.directory[0].id, 'patient');
      assert.equal(staff.directory[0].id, 'patient');
      const [warm, zone] = await Promise.all([
        get(directory, f.actors[0]),
        get('/api/cabinet/time-zone', f.actors[0]),
      ]);
      assert.deepEqual(warm, owner);
      assert.equal(zone.timeZone, 'Europe/Moscow');
      assert.equal(spawned, 1, 'two owning clients stay inside one actual query worker');
      assert.equal(peak, 2, 'capacity advertisement must admit two physical live jobs');
      const stats = executor.stats();
      assert.equal(stats.started, 4);
      assert.equal(stats.completed, 4);
      assert.equal(stats.active, 0);
      assert.equal(stats.reservedBytes, 0);
      assert.equal(stats.retainedBytes, 0);
      assert.equal(stats.queryUpgradeRequested, 0);
      assert.equal(stats.queryDiagnostics.length, 1);
      const snapshot = stats.queryDiagnostics[0].snapshot;
      assert.ok(snapshot, 'closed parent validation must retain actual-worker diagnostics');
      assert.equal(snapshot.version, 3);
      assert.equal(snapshot.routes.directory.count, 3);
      assert.equal(snapshot.routes.timeZone.count, 1);
      for (const key of ['hits', 'misses', 'invalidated', 'rejected', 'entries'])
        assert.ok(Number.isSafeInteger(snapshot.readViews.directoryResponses165[key]));
      assert.ok(snapshot.readViews.directoryResponses165.hits >= 1);
      assert.ok(snapshot.routes.directory.operationSqlCalls > 0);
      assert.equal(snapshot.routes.directory.rpcCalls, 0);
      assert.equal(snapshot.routes.timeZone.rpcCalls, 0);
      assert.equal(work.stats().usedBytes, 0);
      assert.ok(work.stats().peakBytes <= 192 * MiB + 4 * 65536);
    } finally {
      for (const response of replies) response.release();
      await executor?.close({ force: true });
      work.close();
      await f.close();
    }
  },
);
