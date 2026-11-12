const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  postgresQueryWorkers177Fixture,
} = require('./helpers/postgres-query-workers177-fixture.cjs');
const { gateway } = require('./helpers/native-query-workers177-client.cjs');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const {
  preparePostgresRuntimeConfig,
} = require('../src/server/infrastructure/postgres/prepared-profile.cjs');
const {
  createNativeMemoryBudget,
  nativeMemoryProcess,
} = require('../src/server/infrastructure/native-memory-budget.cjs');
const MiB = 1024 * 1024;
const headers = (actor) => ({
  cookie: 'cartoteca_v2_session=' + actor.token,
  'x-cartoteca-account-id': actor.accountId,
  'x-cartoteca-organization-id': actor.organizationId,
});
async function request(base, actor, url, options = {}) {
  const response = await fetch(base + url, {
    ...options,
    headers: { ...headers(actor), ...options.headers },
    signal: options.signal || AbortSignal.timeout(15000),
  });
  return { status: response.status, body: await response.json() };
}
async function until(read, accept, message, milliseconds = 10000) {
  const end = Date.now() + milliseconds;
  let value;
  do {
    value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < end);
  assert.fail(message);
}
function topology(status, pid, plan) {
  assert.equal(status.closeState, 'open');
  assert.equal(status.owner.state, 'ready');
  assert.equal(status.queries.readyWorkers, 4);
  assert.equal(status.queries.workers, 4);
  assert.equal(status.queries.limits.maxPending, 32);
  assert.equal(status.queries.limits.timeoutMs, 20000);
  assert.equal(status.owner.commands.length, 2);
  assert.equal(status.commandLimit, 2);
  const isolates = [];
  const check = (report, processPlan, count) => {
    assert.ok(report);
    const samples = [report.main, report.database, report.lease].filter(Boolean);
    assert.equal(samples.length, count);
    for (const sample of samples) {
      assert.equal(sample.pid, report.pid);
      assert.equal(sample.heapSizeLimitBytes, processPlan.heapCeilingMiB * MiB);
      assert.equal(Object.hasOwn(sample, 'rssBytes'), sample.threadId === 0);
      isolates.push(sample);
    }
  };
  assert.equal(status.memory.gateway.pid, pid);
  check(status.memory.gateway, nativeMemoryProcess(plan, 'gateway'), 1);
  assert.equal(status.queries.memory.length, 4);
  for (const query of status.queries.memory) {
    assert.equal(query.report.pid, pid);
    assert.ok(query.report.main.threadId > 0);
    assert.ok(query.report.database.threadId > 0);
    check(query.report, nativeMemoryProcess(plan, 'gateway'), 2);
  }
  const records = [status.owner.application, status.owner.background, ...status.owner.commands];
  for (const [index, identity] of ['web', 'background', 'command', 'command-1'].entries()) {
    assert.equal(records[index].exited, false);
    assert.equal(records[index].memory.main.threadId, 0);
    check(
      records[index].memory,
      nativeMemoryProcess(plan, identity),
      identity === 'background' ? 3 : 2,
    );
  }
  assert.equal(new Set([pid, ...records.map((row) => row.pid)]).size, 5);
  assert.equal(isolates.length, 18);
  assert.equal(new Set(isolates.map((row) => row.pid + ':' + row.threadId)).size, 18);
  assert.equal(
    isolates.reduce((sum, row) => sum + row.heapSizeLimitBytes / MiB, 0),
    plan.totals.compatibilityHeapCeilingsMiB,
  );
  assert.equal(plan.topology.sqlWorkers, 8);
  assert.equal(plan.totals.workingAllocatedMiB, 1535);
  assert.equal(plan.totals.workingUnallocatedMiB, 1);
  assert.equal(status.memory.budget.rssHardCapClaim, false);
  assert.equal(status.memory.work.maxBytes, 1024 * MiB);
}

test(
  '177 four physical query workers retain eighteen attested isolates, fresh authority, cancellation and complete closure',
  { timeout: 180000 },
  async (t) => {
    const f = await postgresQueryWorkers177Fixture(t);
    await f.change(3);
    const prepared = await preparePostgresRuntimeConfig({
      ...f.fixture.config,
      dataDir: f.assets,
      storageBackend: 'postgres',
      postgres: f.runtime.application,
      nativeMemoryBudgetVersion: 1,
      nativeMemoryBudgetMiB: 1536,
      nativeQueryWorkers: 4,
    });
    const plan = createNativeMemoryBudget({
      budgetMiB: 1536,
      commandCount: 2,
      postgres: true,
      queryConcurrency: 4,
    });
    assert.equal(prepared.notificationSchema, 19);
    const controlled = await f.owner();
    const [actor, foreign] = f.fixture.actors;
    const cabinets = f.fixture.actors.map((a) =>
      createStorage(path.join(f.assets, 'tenants', a.organizationId), {
        databaseOwner: controlled.owner,
        databaseRoot: f.assets,
        photoOrganizationId: a.organizationId,
      }),
    );
    const server = gateway(t, nativeMemoryProcess(plan, 'gateway'));
    let locked = false;
    try {
      const started = await server.rpc('start', prepared);
      topology(started.status, server.pid, plan);
      const base = 'http://127.0.0.1:' + started.port;
      const url = '/api/cabinet/patient?id=' + actor.patientId;
      const before = cabinets.map((storage) => storage.read());
      await t.test(
        'concurrent native GETs return only their own tenant and never downgrade to the application proxy',
        async () => {
          const beforeStatus = (await server.rpc('stats')).status;
          const initial = beforeStatus.queries.started;
          const replies = await Promise.all(
            Array.from({ length: 8 }, (_, index) => {
              const a = index % 2 ? actor : foreign;
              return request(base, a, '/api/cabinet/patient?id=' + a.patientId);
            }),
          );
          const statusCounts = {};
          for (const response of replies)
            statusCounts[response.status] = (statusCounts[response.status] || 0) + 1;
          if (statusCounts[200] !== 8) {
            const afterStatus = (await server.rpc('stats')).status;
            const queryCounters = (status) =>
              Object.fromEntries(
                [
                  'started',
                  'completed',
                  'refused',
                  'failures',
                  'cancelled',
                  'timedOut',
                  'active',
                  'pending',
                  'readyWorkers',
                  'workers',
                  'workPending',
                  'retainedBytes',
                  'reservedBytes',
                  'queryProbeStarted',
                  'queryUpgradeRequested',
                  'queryUpgradeGranted',
                  'queryUpgradeRefused',
                ].map((name) => [name, status.queries[name]]),
              );
            t.diagnostic(
              JSON.stringify({
                phase: 'parallel-native-reads177',
                statusCounts,
                before: { queries: queryCounters(beforeStatus), work: beforeStatus.memory.work },
                after: { queries: queryCounters(afterStatus), work: afterStatus.memory.work },
                limits: afterStatus.queries.limits,
              }),
            );
          }
          assert.deepEqual(statusCounts, { 200: 8 });
          for (const [index, response] of replies.entries())
            assert.equal(response.body.patients[0].id, (index % 2 ? actor : foreign).patientId);
          assert.equal((await server.rpc('stats')).status.queries.started - initial, 8);
          assert.equal((await request(base, foreign, url)).status, 404);
          const crossed = await request(base, actor, url, {
            headers: { cookie: headers(foreign).cookie },
          });
          assert.equal(crossed.status, 428);
          assert.equal(crossed.body.code, 'AUTH_CONTEXT_CHANGED');
          assert.deepEqual(
            cabinets.map((storage) => storage.read()),
            before,
          );
        },
      );

      const blocked = async () => {
        await f.admin.query('SELECT pg_stat_clear_snapshot()');
        return f.admin
          .query(
            "SELECT count(*)::integer AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE NOT l.granted AND l.locktype='relation' AND l.relation='cartoteca_cabinet.patients'::regclass AND a.datname=current_database() AND a.usename=$1 AND pg_backend_pid()=ANY(pg_blocking_pids(a.pid))",
            [f.runtime.application.user],
          )
          .then((r) => r.rows[0].n);
      };
      const lock = async () => {
        await f.admin.query('BEGIN');
        await f.admin.query('LOCK TABLE cartoteca_cabinet.patients IN ACCESS EXCLUSIVE MODE');
        locked = true;
      };
      const unlock = async () => {
        await f.admin.query('ROLLBACK');
        locked = false;
      };
      await t.test(
        'a revoked membership committed after the owning RR begins is denied by fresh postauth',
        async () => {
          await lock();
          const pending = request(base, actor, url).then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
          try {
            await until(
              blocked,
              (n) => n > 0,
              'native clinical SELECT never reached the held PostgreSQL lock',
            );
            await f.admin.query(
              "UPDATE cartoteca_platform.memberships SET status='suspended' WHERE _store_id=$1 AND account_id=$2",
              [f.scope.storeId, actor.accountId],
            );
            await f.admin.query('COMMIT');
            locked = false;
            const response = await pending;
            assert.equal(response.error, undefined);
            assert.equal(response.value.status, 401);
            assert.equal(Object.hasOwn(response.value.body, 'patients'), false);
          } finally {
            if (locked) await unlock();
            await f.admin.query(
              "UPDATE cartoteca_platform.memberships SET status='active' WHERE _store_id=$1 AND account_id=$2",
              [f.scope.storeId, actor.accountId],
            );
            await pending;
          }
          assert.equal((await request(base, actor, url)).status, 200);
          assert.deepEqual(
            cabinets.map((storage) => storage.read()),
            before,
          );
        },
      );

      await t.test(
        'disconnect cancels a physically blocked read and restores four ready workers with no retained work',
        async () => {
          const cancelStarted = performance.now();
          await lock();
          const abort = new AbortController();
          const cancelledBefore = (await server.rpc('stats')).status.queries.cancelled;
          const pending = request(base, actor, url, { signal: abort.signal }).then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
          try {
            await until(
              blocked,
              (n) => n > 0,
              'cancellable read never reached the physical SQL lock',
            );
            abort.abort();
            await until(
              async () => (await server.rpc('stats')).status.queries.cancelled,
              (count) => count > cancelledBefore,
              'gateway did not register cancellation of the physical query',
            );
            await until(
              async () => ({
                status: (await server.rpc('stats')).status,
                blockedSQL: await blocked(),
              }),
              ({ status, blockedSQL }) =>
                status.queries.active === 0 &&
                status.memory.work.usedBytes === 0 &&
                status.queries.retainedBytes === 0 &&
                status.queries.reservedBytes === 0 &&
                blockedSQL === 0,
              'cancelled physical SQL and active work did not drain while the lock remained held',
            );
          } finally {
            abort.abort();
            if (locked) await unlock();
            await pending;
          }
          const cancelled = await pending;
          assert.equal(cancelled.value, undefined);
          assert.equal(cancelled.error.name, 'AbortError');
          const readyStarted = performance.now();
          const idle = await until(
            async () => (await server.rpc('stats')).status,
            (s) =>
              s.queries.readyWorkers === 4 &&
              s.queries.active === 0 &&
              s.queries.pending === 0 &&
              s.queries.workPending === 0 &&
              s.queries.retainedBytes === 0 &&
              s.queries.reservedBytes === 0 &&
              s.memory.work.usedBytes === 0,
            'cancelled worker did not release work/recover the four-reader pool',
            40000,
          );
          t.diagnostic(
            JSON.stringify({
              phase: 'four-query-worker-cancel-recovery',
              cancelAndDrainMs: readyStarted - cancelStarted,
              readyFourAfterUnlockMs: performance.now() - readyStarted,
              qualification:
                'bounded lifecycle observation, not latency SLO; existing four-start/30s window unchanged',
            }),
          );
          topology(idle, server.pid, plan);
          assert.equal((await request(base, actor, url)).status, 200);
          assert.deepEqual(
            cabinets.map((storage) => storage.read()),
            before,
          );
        },
      );

      const closed = await server.rpc('close');
      assert.equal(closed.status.closeState, 'closed');
      assert.equal(closed.status.queries.closed, true);
      assert.equal(closed.status.queries.workers, 0);
      assert.equal(closed.status.queries.active, 0);
      assert.equal(closed.status.memory.work.usedBytes, 0);
      assert.ok(
        [
          closed.status.owner.application,
          closed.status.owner.background,
          ...closed.status.owner.commands,
        ].every((row) => row.exited),
      );
      assert.deepEqual(await server.exit, { code: 0, signal: null });
    } finally {
      if (locked) await f.admin.query('ROLLBACK');
      await server.close();
      for (const storage of cabinets) storage.close();
      await controlled.close();
    }
  },
);
