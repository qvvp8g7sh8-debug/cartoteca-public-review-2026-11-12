// Synthetic harness only. This proposal is intentionally not run by its author;
// the root runs focused PostgreSQL validation after closing LOAD166.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { calendarFixture163 } = require('./helpers/postgres-calendar163-fixture.cjs');
const {
  createPostgresReadOperations,
} = require('../src/server/infrastructure/postgres/read-operations145.cjs');
const { createNativeQueryKernel } = require('../src/server/infrastructure/native-query-kernel.cjs');
const {
  prepareReadScopes163,
} = require('../src/server/infrastructure/postgres/read-scope-prepare163.cjs');
const {
  platformGuard167,
  fenceRow167,
  catalogRow167,
} = require('../src/server/infrastructure/postgres/read-phase-guards167.cjs');
const { KEYS } = require('../src/server/infrastructure/postgres/lock-intents.cjs');

test(
  '167 actual native guards, ordered tail, fresh authority and missing-component compatibility preserve the owning RR',
  { timeout: 180000 },
  async (t) => {
    const f = await calendarFixture163(t),
      opened = [],
      traces = [];
    const original = Client.prototype.query,
      states = new WeakMap(),
      order = [];
    let tracing = false,
      commitFailure = null,
      revokeBeforeSubmission = null,
      cancelScope = null,
      jsonHook = null;
    t.mock.method(Client.prototype, 'query', function (input, ...args) {
      const text = typeof input === 'string' ? input : input.text;
      if (!tracing || this.user !== f.runtime.application.user)
        return original.call(this, input, ...args);
      let state = states.get(this);
      if (!state) {
        state = {};
        states.set(this, state);
      }
      const values = typeof input === 'string' ? args[0] : input.values;
      traces.push({ client: this, text, values });
      if (text === 'COMMIT' && commitFailure) {
        const error = commitFailure;
        commitFailure = null;
        return Promise.reject(error);
      }
      if (/fence_locked/.test(text) && state.postQueued) {
        state.postQueued = false;
        if (revokeBeforeSubmission) {
          const revoke = revokeBeforeSubmission;
          revokeBeforeSubmission = null;
          return state.actualCommit.then(async (result) => {
            assert.equal(result.command, 'COMMIT');
            order.push('physicalCOMMIT');
            await revoke();
            order.push('revokeCOMMITTED');
            order.push('actualPOSTAUTHsubmit');
            return original.call(this, input, ...args);
          });
        }
      }
      const pending = original.call(this, input, ...args);
      if (text === 'COMMIT') {
        state.actualCommit = pending;
        state.postQueued = true;
      }
      if (cancelScope && /^SELECT set_config/.test(text) && values?.[0] === 'cabinet') {
        const cancel = cancelScope;
        cancelScope = null;
        return pending.then((result) => {
          cancel();
          return result;
        });
      }
      return pending;
    });
    async function make() {
      tracing = false;
      const db = await f.open();
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
        databaseOwner: db.owner,
      };
      const operations = await createPostgresReadOperations(config, { readOwnerCapacity166: 2 });
      const borrow = operations.borrow166;
      operations.borrow166 = () => {
        const lease = borrow();
        if (!lease) return null;
        return {
          ...lease,
          run(context, execution) {
            return lease.run(
              {
                ...context,
                json(...args) {
                  const result = context.json(...args);
                  if (jsonHook) {
                    const hook = jsonHook;
                    jsonHook = null;
                    hook();
                  }
                  return result;
                },
              },
              execution,
            );
          },
        };
      };
      const value = {
        operations,
        kernel: createNativeQueryKernel(config, { readOperations: operations }),
      };
      opened.push(value);
      tracing = true;
      traces.length = 0;
      return value;
    }
    async function closeAll() {
      tracing = false;
      for (const item of opened.splice(0)) await item.kernel.close();
    }
    function metadata(url, actor = f.actors[0]) {
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
    async function run(k, url = f.url, actor = f.actors[0], cancel = null) {
      const reply = await k.kernel.run(metadata(url, actor), cancel, {
        memoryClass: 'query-probe',
        requestMemoryClass: async () => {},
      });
      return { status: reply.status, body: JSON.parse(Buffer.from(reply.body).toString()) };
    }
    const status = (active) =>
      f.a.p
        .prepare('UPDATE memberships SET status=? WHERE organization_id=? AND account_id=?')
        .run(active ? 'active' : 'inactive', f.organizations[0], f.actors[0].accountId);
    let componentRemoved = false;
    try {
      await t.test(
        'mandatory fence release survives zero catalog rows and leaves no session lock',
        async () => {
          const held = await f.admin.query('SELECT pg_try_advisory_lock_shared($1::bigint) held', [
            KEYS.maintenance,
          ]);
          assert.equal(held.rows[0].held, true);
          await f.admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          try {
            const plan = platformGuard167({
              platform: { kind: 'platform', storeId: '00000000-0000-4000-8000-000000000000' },
              locks: [{ key: KEYS.maintenance, shared: true }],
            });
            const row = fenceRow167(await f.admin.query(plan.text, plan.values));
            assert.deepEqual(row.locked, [true]);
            assert.deepEqual(row.released, [true]);
            assert.equal(catalogRow167(row, { metadata: { version: 19 }, hash: 'unused' }), false);
            assert.equal(
              (
                await f.admin.query('SELECT pg_advisory_unlock_shared($1::bigint) held', [
                  KEYS.maintenance,
                ])
              ).rows[0].held,
              false,
            );
          } finally {
            await f.admin.query('ROLLBACK');
          }
          assert.equal(
            Number(
              (
                await f.admin.query(
                  "SELECT count(*) n FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'",
                )
              ).rows[0].n,
            ),
            0,
          );
        },
      );
      const k = await make();
      const cold = await run(k);
      assert.equal(cold.status, 200, JSON.stringify(cold));
      await t.test(
        'warm scalar route uses nine SQL commands, one owning client and fresh pre/post statements',
        async () => {
          traces.length = 0;
          const before = k.operations.sqlCalls();
          const warm = await run(k, f.conditional(cold.body));
          assert.equal(warm.status, 200, JSON.stringify(warm));
          assert.equal(warm.body.unchanged, true);
          assert.equal(k.operations.sqlCalls() - before, 9);
          assert.equal(new Set(traces.map((row) => row.client)).size, 1);
          assert.equal(traces.filter((row) => /fence_locked/.test(row.text)).length, 2);
          const guard = traces.find((row) => row.text.startsWith('WITH ct_xact167'));
          assert.ok(guard);
          assert.match(guard.text, /read_scope_versions163/);
          assert.equal(
            traces.filter((row) => row.text.startsWith('SELECT c.version,c.catalog_hash')).length,
            1,
            'platform clock came from this RR bootstrap',
          );
          assert.equal(
            traces.some((row) => /octet_length/.test(row.text)),
            false,
          );
          const commit = traces.findIndex((row) => row.text === 'COMMIT'),
            post = traces.findLastIndex((row) => /fence_locked/.test(row.text));
          assert.ok(commit > 0 && post > commit);
          assert.equal(traces[commit].client, traces[post].client);
        },
      );
      await t.test(
        'invalid current catalog still releases its fence and rolls back before any payload',
        async () => {
          const before = (
            await f.admin.query(
              "SELECT metadata FROM cartoteca_catalog.stores WHERE kind='platform' AND store_id=$1",
              [f.platform.storeId],
            )
          ).rows[0].metadata;
          try {
            await f.admin.query(
              "UPDATE cartoteca_catalog.stores SET metadata=$1::jsonb WHERE kind='platform' AND store_id=$2",
              [{ synthetic167invalid: true }, f.platform.storeId],
            );
            traces.length = 0;
            const reply = await run(k);
            assert.equal(reply.status, 503, JSON.stringify(reply));
            assert.equal(traces.filter((row) => row.text === 'ROLLBACK').length, 1);
            assert.equal(traces.filter((row) => row.text === 'COMMIT').length, 0);
            assert.equal(
              traces.some((row) => /octet_length/.test(row.text)),
              false,
            );
            const pids = [...new Set(traces.map((row) => row.client.processID))];
            assert.equal(
              Number(
                (
                  await f.admin.query(
                    "SELECT count(*) n FROM pg_locks WHERE pid=ANY($1::integer[]) AND locktype='advisory'",
                    [pids],
                  )
                ).rows[0].n,
              ),
              0,
            );
          } finally {
            await f.admin.query(
              "UPDATE cartoteca_catalog.stores SET metadata=$1::jsonb WHERE kind='platform' AND store_id=$2",
              [before, f.platform.storeId],
            );
          }
          assert.equal((await run(k)).status, 200);
        },
      );
      await t.test('cold and platform-only routes do not request bootstrap clocks', async () => {
        for (const url of [
          '/api/cabinet/directory?q=Synthetic&today=2035-01-01&limit=1',
          '/api/cabinet/time-zone',
        ]) {
          traces.length = 0;
          const reply = await run(k, url);
          assert.equal(reply.status, 200, JSON.stringify(reply));
          const guard = traces.find((row) => row.text.startsWith('WITH ct_xact167'));
          assert.ok(guard);
          assert.doesNotMatch(guard.text, /read_scope_versions163/);
        }
      });
      await t.test(
        'COMMIT failure cannot accept/publish the cold wire response or replay a second owner',
        async () => {
          const before = k.operations.viewStats().directoryResponses165.entries;
          traces.length = 0;
          commitFailure = Object.assign(Error('Synthetic167 COMMIT failure'), { code: '08006' });
          const reply = await run(k, '/api/cabinet/directory?q=NoMatch167&today=2035-01-01');
          assert.ok([500, 503].includes(reply.status), JSON.stringify(reply));
          assert.equal(k.operations.viewStats().directoryResponses165.entries, before);
          assert.equal(
            traces.filter((row) => row.text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
              .length,
            1,
          );
          assert.equal(traces.filter((row) => row.text === 'ROLLBACK').length, 1);
          assert.equal((await run(k)).status, 200);
        },
      );
      await t.test(
        'revoke committed after physical COMMIT and before actual postauth submission denies the old DTO',
        async () => {
          order.length = 0;
          revokeBeforeSubmission = () => status(false);
          const before = k.operations.viewStats().directoryResponses165.entries;
          try {
            const reply = await run(k, '/api/cabinet/directory?q=NoMatch167Deny&today=2035-01-01');
            assert.ok([401, 403, 428].includes(reply.status), JSON.stringify(reply));
            assert.deepEqual(order, ['physicalCOMMIT', 'revokeCOMMITTED', 'actualPOSTAUTHsubmit']);
            assert.equal(reply.body.directory, undefined);
            assert.equal(
              k.operations.viewStats().directoryResponses165.entries,
              before,
              'failed fresh acceptance cannot publish a new cold wire response',
            );
          } finally {
            status(true);
          }
        },
      );
      await t.test(
        'the existing context.json before-COMMIT revocation still invalidates the final authority',
        async () => {
          jsonHook = () => status(false);
          try {
            const reply = await run(k);
            assert.ok([401, 403, 428].includes(reply.status), JSON.stringify(reply));
          } finally {
            status(true);
          }
          assert.equal((await run(k)).status, 200);
        },
      );
      await t.test(
        'cancelled scope transition rolls back, clears scope ownership and leaves both clients usable',
        async () => {
          const shared = new SharedArrayBuffer(4),
            word = new Int32Array(shared);
          cancelScope = () => Atomics.store(word, 0, 1);
          traces.length = 0;
          assert.equal((await run(k, f.url, f.actors[0], shared)).status, 499);
          assert.equal(traces.filter((row) => row.text === 'ROLLBACK').length, 1);
          assert.equal(traces.filter((row) => row.text === 'COMMIT').length, 0);
          assert.equal((await run(k)).status, 200);
          assert.equal((await run(k, f.url, f.actors[1])).status, 200);
          assert.equal(k.operations.ownerStats166().borrowed, 0);
        },
      );
      await closeAll();
      await t.test(
        'absent163 component uses the existing native compatibility path without clock reads',
        async () => {
          await f.admin.query('BEGIN');
          await prepareReadScopes163(f.admin, f.runtime.application.user, { rollback: true });
          await f.admin.query('COMMIT');
          componentRemoved = true;
          const legacy = await make();
          traces.length = 0;
          const reply = await run(legacy);
          assert.equal(reply.status, 200, JSON.stringify(reply));
          assert.ok(Array.isArray(reply.body.appointments));
          assert.equal(
            traces.some((row) => /read_scope_versions163/.test(row.text)),
            false,
          );
          await closeAll();
          await f.admin.query('BEGIN');
          await prepareReadScopes163(f.admin, f.runtime.application.user);
          await f.admin.query('COMMIT');
          componentRemoved = false;
        },
      );
    } finally {
      commitFailure = revokeBeforeSubmission = cancelScope = jsonHook = null;
      await closeAll();
      if (componentRemoved) {
        await f.admin.query('BEGIN');
        await prepareReadScopes163(f.admin, f.runtime.application.user);
        await f.admin.query('COMMIT');
      }
      await f.close();
    }
  },
);
