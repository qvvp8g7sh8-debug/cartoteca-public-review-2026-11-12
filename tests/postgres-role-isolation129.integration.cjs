const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setTimeout: sleep } = require('node:timers/promises');
const { Client } = require('pg');
const ROOT =
  path.basename(path.dirname(__dirname)) === 'lease129-ttl-candidate'
    ? path.resolve(__dirname, '../../../..')
    : path.resolve(__dirname, '..');
const { nativeIsolatedFixture } = require(
  path.join(ROOT, 'tests/helpers/native-isolated-fixture.cjs'),
);
const { startPostgresTestRuntime } = require(path.join(ROOT, 'scripts/postgres-test-runtime.cjs'));
const { migratePostgresData } = require(
  path.join(ROOT, 'src/server/infrastructure/postgres/migration.cjs'),
);
const { readRuntime } = require(path.join(ROOT, 'src/server/infrastructure/postgres/runtime.cjs'));
const { createIsolatedServer } = require(
  path.join(ROOT, 'src/server/application/isolated-server.cjs'),
);
const { KEYS } = require(path.join(ROOT, 'src/server/infrastructure/postgres/lock-intents.cjs'));
// Forthcoming coherent TTL source, not the rejected session-lock-only candidate.
const { createProcessRoleChannel } = require(
  path.join(ROOT, 'src/server/infrastructure/postgres/process-role-channel.cjs'),
);
const { LEASE_MS } = require(
  path.join(ROOT, 'src/server/infrastructure/postgres/process-role-authority.cjs'),
);
const { validateRoleLeaseSchema } = require(
  path.join(ROOT, 'src/server/infrastructure/postgres/process-role-schema.cjs'),
);
const HOLD_MS = 70000;
const APPLICATION_NAME = 'cartoteca-process-role-lease';
const TTL_TABLE = 'cartoteca_catalog.process_role_leases';
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
function coordinates(key) {
  const value = BigInt.asUintN(64, BigInt(key));
  return { high: (value >> 32n).toString(), low: (value & 0xffffffffn).toString() };
}
const GUARD_PROOF = `WITH expected AS (
  SELECT (j->>'high')::oid AS high, (j->>'low')::oid AS low
  FROM pg_catalog.jsonb_array_elements($1::jsonb) AS items(j)
)
SELECT count(*)::int AS guards FROM pg_catalog.pg_locks l
JOIN expected e ON l.classid=e.high AND l.objid=e.low
WHERE l.pid=$2 AND l.locktype='advisory' AND l.granted
  AND l.mode='ExclusiveLock' AND l.objsubid=1
  AND l.database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())`;
async function backend(observer) {
  const rows = (
    await observer.query(
      `SELECT pid,backend_start::text AS backend_start FROM pg_catalog.pg_stat_activity
     WHERE datname=current_database() AND application_name=$1 ORDER BY pid`,
      [APPLICATION_NAME],
    )
  ).rows;
  assert.ok(rows.length === 1, 'exactly one dedicated background lease backend is expected');
  const row = rows[0];
  assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0 && typeof row.backend_start === 'string');
  return row;
}
async function activeLease(observer, platformStoreId) {
  const rows = (
    await observer.query(
      `SELECT (extract(epoch FROM expires_at)*1000)::bigint AS expires_ms,
       expires_at>clock_timestamp() AS valid FROM ${TTL_TABLE}
     WHERE platform_store_id=$1 AND role='background'`,
      [platformStoreId],
    )
  ).rows;
  assert.ok(
    rows.length === 1 && rows[0].valid === true,
    'one persisted unexpired background TTL must exist',
  );
  const value = Number(rows[0].expires_ms);
  assert.ok(Number.isSafeInteger(value), 'expiry is a finite technical timestamp');
  return value;
}
async function privateLease(observer, platformStoreId, owner) {
  const rows = (
    await observer.query(
      `SELECT token_hash,expires_at::text AS expiry,expires_at>clock_timestamp() AS valid
     FROM ${TTL_TABLE} WHERE platform_store_id=$1 AND owner=$2`,
      [platformStoreId, owner],
    )
  ).rows;
  assert.ok(rows.length === 1, 'the exact synthetic lease row must remain present');
  const row = rows[0];
  assert.ok(Buffer.isBuffer(row.token_hash) && row.token_hash.length === 32);
  return row; // Private in memory only: never diagnostic/console output.
}
function identities(server) {
  const s = server.isolationStatus();
  assert.ok(
    s.closeState === 'open' && s.owner.state === 'ready',
    'gateway and native owner stay open',
  );
  assert.ok(s.owner.application.ready && !s.owner.application.exited, 'web must remain alive');
  assert.ok(s.owner.background.ready && !s.owner.background.exited, 'background must remain alive');
  assert.ok(
    s.queries.readyWorkers === 2 && s.queries.closed === false,
    'both query workers stay ready',
  );
  return { web: s.owner.application.pid, background: s.owner.background.pid };
}
async function response(base, actor, route, signal, overrides = {}) {
  const headers = new Headers(overrides);
  if (actor) {
    headers.set('cookie', 'cartoteca_v2_session=' + actor.token);
    headers.set('x-cartoteca-account-id', actor.accountId);
    headers.set('x-cartoteca-organization-id', actor.organizationId);
    for (const [key, value] of Object.entries(overrides)) headers.set(key, value);
  }
  const result = await fetch(base + route, {
    headers,
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  const text = await result.text();
  assert.ok(Buffer.byteLength(text) <= 1024 * 1024, 'bounded synthetic response');
  return { status: result.status, text, json: () => JSON.parse(text) };
}
async function closeServer(server) {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test(
  'actual isolated PostgreSQL durable process-role TTL survives business contention and socket loss safely',
  { timeout: 180000 },
  async (t) => {
    assert.equal(LEASE_MS, 60000, 'cross the real unshortened lease/watchdog');
    const f = await nativeIsolatedFixture(t, { organizations: 2 });
    const [actor, foreign] = f.actors;
    const originalClose = f.platform.close;
    let sourceClosed = false;
    f.platform.close = () => {
      if (!sourceClosed) {
        sourceClosed = true;
        originalClose();
      }
    };
    f.platform.close();
    const runtime = await startPostgresTestRuntime();
    const admin = new Client({ ...runtime.admin, query_timeout: 10000, statement_timeout: 8000 });
    const observer = new Client({ ...runtime.admin, query_timeout: 6000, statement_timeout: 5000 });
    let connected = false,
      observerConnected = false,
      holding = false,
      server;
    const channels = [];
    try {
      await admin.connect();
      connected = true;
      await observer.connect();
      observerConnected = true;
      const destination = path.join(runtime.root, 'assets');
      const migrated = await migratePostgresData({
        source: f.directory,
        destination,
        client: admin,
        applicationRole: runtime.application.user,
        offline: true,
        dryRun: false,
      });
      assert.ok(migrated.sourceUnchanged && migrated.cutover === false);
      const marker = readRuntime(destination);
      // Do NOT call ensureRoleLeaseSchema here: that would hide migration wiring.
      const schema = (await admin.query('SELECT to_regclass($1) AS native_table', [TTL_TABLE]))
        .rows[0];
      assert.ok(
        schema.native_table !== null,
        'fresh native migration must provision the TTL table',
      );
      await validateRoleLeaseSchema(admin, runtime.application.user);
      const config = {
        ...f.config,
        dataDir: destination,
        storageBackend: 'postgres',
        postgres: runtime.application,
        commonNotificationsEnabled: false,
        pushAutostart: false,
      };

      await t.test(
        'at least six real renewals commit during a70s global fence and common revision-row hold',
        async () => {
          let fatalEvents = 0;
          server = await createIsolatedServer(config);
          server.on('backgroundError', () => {
            fatalEvents++;
          });
          server.on('error', () => {
            fatalEvents++;
          });
          try {
            server.listen(0, '127.0.0.1');
            await once(server, 'listening');
            const base = 'http://127.0.0.1:' + server.address().port;
            const processes = identities(server),
              leaseBackend = await backend(observer);
            let lastExpiry = await activeLease(observer, marker.platformStoreId),
              advances = 0;
            const initial = await response(
              base,
              actor,
              '/api/cabinet/bootstrap?paged=1&limit=5',
              t.signal,
            );
            assert.ok(
              initial.status === 200 &&
                initial.json().directory.some((row) => row.id === actor.patientId),
            );
            await admin.query('SET idle_in_transaction_session_timeout=0');
            await admin.query('SET lock_timeout=5000');
            await admin.query('BEGIN');
            holding = true;
            for (const key of [KEYS.maintenance, KEYS.policy, KEYS.writer])
              await admin.query('SELECT pg_advisory_xact_lock($1::bigint)', [key]);
            const revision = (
              await admin.query(
                "SELECT revision FROM cartoteca_catalog.stores WHERE kind='platform' AND store_id=$1 FOR UPDATE",
                [marker.platformStoreId],
              )
            ).rows;
            assert.ok(revision.length === 1, 'the actual shared revision row is locked');
            const blocker = (
              await admin.query('SELECT pg_backend_pid() pid,txid_current()::text tx')
            ).rows[0];
            const guards = [KEYS.maintenance, KEYS.policy, KEYS.writer].map(coordinates);
            const start = performance.now();
            let polls = 0,
              refusedProtectedReads = 0;
            // Start the expiry counter only after every business/row lock is held.
            lastExpiry = await activeLease(observer, marker.platformStoreId);
            try {
              while (performance.now() - start < HOLD_MS) {
                t.signal.throwIfAborted();
                const page = await response(base, null, '/login.html', t.signal);
                assert.ok(
                  page.status === 200 && /<html/i.test(page.text),
                  'public login stays available',
                );
                const now = identities(server);
                assert.ok(
                  now.web === processes.web && now.background === processes.background,
                  'no web/background restart may stand in for successful renewal',
                );
                assert.ok(fatalEvents === 0, 'no fatal event may be ignored');
                const currentBackend = await backend(observer);
                assert.ok(
                  currentBackend.pid === leaseBackend.pid &&
                    currentBackend.backend_start === leaseBackend.backend_start,
                  'the same dedicated lease connection must remain alive',
                );
                const expiry = await activeLease(observer, marker.platformStoreId);
                assert.ok(expiry >= lastExpiry, 'persisted expiry must not move backwards');
                if (expiry > lastExpiry) {
                  advances++;
                  lastExpiry = expiry;
                }
                const held = (
                  await observer.query(GUARD_PROOF, [JSON.stringify(guards), blocker.pid])
                ).rows[0];
                assert.ok(held.guards === 3, 'all global business guards remain held');
                if (polls === 0 || performance.now() - start >= LEASE_MS + 5000) {
                  const denied = await response(
                    base,
                    actor,
                    '/api/cabinet/bootstrap?paged=1&limit=5',
                    t.signal,
                  );
                  assert.ok(
                    denied.status === 503 && !denied.json().directory,
                    'protected503 is expected under maintenance and is not accepted as data success',
                  );
                  refusedProtectedReads++;
                }
                polls++;
                await sleep(
                  Math.min(5000, Math.max(0, HOLD_MS - (performance.now() - start))),
                  undefined,
                  { signal: t.signal },
                );
              }
              assert.ok(performance.now() - start >= HOLD_MS, 'no shortened TTL/time shortcut');
              const endExpiry = await activeLease(observer, marker.platformStoreId);
              if (endExpiry > lastExpiry) advances++;
              assert.ok(
                advances >= 6,
                'at least six real persisted expiry advances must be observed',
              );
              const endBackend = await backend(observer);
              assert.ok(
                endBackend.pid === leaseBackend.pid &&
                  endBackend.backend_start === leaseBackend.backend_start,
              );
              const stillHeld = (
                await admin.query('SELECT pg_backend_pid() pid,txid_current()::text tx')
              ).rows[0];
              assert.ok(
                stillHeld.pid === blocker.pid && stillHeld.tx === blocker.tx,
                'same open blocking transaction',
              );
              const unchanged = (
                await admin.query(
                  "SELECT revision FROM cartoteca_catalog.stores WHERE kind='platform' AND store_id=$1",
                  [marker.platformStoreId],
                )
              ).rows[0];
              assert.ok(
                unchanged.revision === revision[0].revision,
                'lease renewals must not touch the locked common revision',
              );
              assert.ok(refusedProtectedReads >= 2 && fatalEvents === 0);
              t.diagnostic(
                JSON.stringify({
                  heldAtLeast70s: true,
                  realExpiryAdvances: advances,
                  publicHttpPolls: polls,
                  sameProcessesAndLeaseBackend: true,
                  protectedDuringHold: '503; not passed data reads',
                  fatalEvents: 0,
                }),
              );
            } finally {
              await admin.query('ROLLBACK');
              holding = false;
            }
            const resumed = await response(
              base,
              actor,
              '/api/cabinet/bootstrap?paged=1&limit=5',
              t.signal,
            );
            assert.ok(
              resumed.status === 200 &&
                resumed.json().directory.some((row) => row.id === actor.patientId),
            );
            const own = await response(
              base,
              actor,
              '/api/cabinet/patient?id=' + actor.patientId,
              t.signal,
            );
            assert.ok(own.status === 200 && own.json().patients[0].id === actor.patientId);
            const denied = await response(
              base,
              actor,
              '/api/cabinet/patient?id=' + foreign.patientId,
              t.signal,
            );
            assert.ok(denied.status === 404 && !denied.json().patients);
            const anonymous = await response(
              base,
              null,
              '/api/cabinet/bootstrap?paged=1',
              t.signal,
            );
            assert.ok(anonymous.status === 401 && !anonymous.json().directory);
            const mismatch = await response(
              base,
              actor,
              '/api/cabinet/patient?id=' + actor.patientId,
              t.signal,
              { 'x-cartoteca-organization-id': foreign.organizationId },
            );
            assert.ok(mismatch.status === 428 && mismatch.json().code === 'AUTH_CONTEXT_CHANGED');
            const other = await response(
              base,
              foreign,
              '/api/cabinet/patient?id=' + foreign.patientId,
              t.signal,
            );
            assert.ok(other.status === 200 && other.json().patients[0].id === foreign.patientId);
            const end = identities(server);
            assert.ok(
              end.web === processes.web &&
                end.background === processes.background &&
                fatalEvents === 0,
            );
          } finally {
            if (holding) {
              await admin.query('ROLLBACK');
              holding = false;
            }
            await closeServer(server);
            server = null;
          }
        },
      );

      await t.test(
        'terminated lease socket cannot admit another background owner before durable expiry',
        async () => {
          const remaining = (
            await observer.query(
              `SELECT count(*)::int n FROM ${TTL_TABLE}
          WHERE platform_store_id=$1 AND expires_at>clock_timestamp()`,
              [marker.platformStoreId],
            )
          ).rows[0];
          assert.ok(remaining.n === 0, 'normal server stop must release its own lease');
          const first = await createProcessRoleChannel({ connection: runtime.application, marker });
          channels.push(first);
          const firstOwner = randomUUID(),
            nextOwner = randomUUID();
          const firstToken = first.acquire('background', firstOwner);
          assert.ok(typeof firstToken === 'string' && UUID.test(firstToken));
          const original = await privateLease(observer, marker.platformStoreId, firstOwner);
          assert.ok(original.valid, 'the durable lease starts valid');
          const originalBackend = await backend(observer);
          const terminated = (
            await admin.query('SELECT pg_terminate_backend($1) AS terminated', [
              originalBackend.pid,
            ])
          ).rows[0];
          assert.ok(terminated.terminated === true);
          const afterLoss = await privateLease(observer, marker.platformStoreId, firstOwner);
          assert.ok(
            afterLoss.valid &&
              afterLoss.expiry === original.expiry &&
              afterLoss.token_hash.equals(original.token_hash),
            'socket loss must preserve the existing row, token hash and confirmed expiry',
          );
          let oldRenewed = false;
          try {
            oldRenewed = first.renew(firstOwner, firstToken) === true;
          } catch {
            /* closed channel is fail-closed */
          }
          assert.ok(!oldRenewed, 'a dead channel can never authorize renewal');
          const second = await createProcessRoleChannel({
            connection: runtime.application,
            marker,
          });
          channels.push(second);
          let refused = false;
          try {
            second.acquire('background', nextOwner);
          } catch (error) {
            refused =
              error.code === 'POSTGRES_ROLE_AUTHORITY_CONFLICT' ||
              error.code === 'POSTGRES_ROLE_AUTHORITY_BUSY';
          }
          assert.ok(
            refused,
            'a distinct background must refuse while the persisted old TTL remains valid',
          );
          const preserved = await privateLease(observer, marker.platformStoreId, firstOwner);
          assert.ok(
            preserved.valid &&
              preserved.expiry === original.expiry &&
              preserved.token_hash.equals(original.token_hash),
            'refused acquire must not overwrite an unexpired owner',
          );
          await second.close().catch(() => {});
          // This is a synthetic test-only expiry after the refusal proof, not a
          // shortened production TTL or a replacement for the real70s case above.
          const expired = await admin.query(
            `UPDATE ${TTL_TABLE}
          SET expires_at=clock_timestamp()-interval '1 second' WHERE platform_store_id=$1 AND owner=$2`,
            [marker.platformStoreId, firstOwner],
          );
          assert.ok(expired.rowCount === 1);
          const third = await createProcessRoleChannel({ connection: runtime.application, marker });
          channels.push(third);
          const nextToken = third.acquire('background', nextOwner);
          assert.ok(
            typeof nextToken === 'string' && UUID.test(nextToken) && nextToken !== firstToken,
          );
          const current = await privateLease(observer, marker.platformStoreId, nextOwner);
          assert.ok(current.valid && !current.token_hash.equals(original.token_hash));
          assert.ok(
            third.renew(firstOwner, firstToken) === false,
            'stale token cannot renew through a healthy new channel',
          );
          assert.ok(
            third.release(firstOwner, firstToken) === false,
            'stale token cannot release the new owner',
          );
          const retained = await privateLease(observer, marker.platformStoreId, nextOwner);
          assert.ok(
            retained.valid &&
              retained.token_hash.equals(current.token_hash) &&
              retained.expiry === current.expiry,
            'stale operations must leave the replacement row unchanged',
          );
          assert.ok(third.release(nextOwner, nextToken) === true);
          t.diagnostic(
            JSON.stringify({
              socketLossPreservedUnexpiredTtl: true,
              newOwnerRefusedBeforeExpiry: true,
              syntheticExpiryUsedOnlyAfterRefusalProof: true,
              staleTokenDenied: true,
            }),
          );
        },
      );

      await t.test(
        'application role RLS cannot read or alter a different platform lease scope',
        async () => {
          const app = new Client({
            ...runtime.application,
            query_timeout: 6000,
            statement_timeout: 5000,
          });
          const seededOwner = randomUUID();
          await admin.query(
            `INSERT INTO ${TTL_TABLE}(platform_store_id,owner,role,token_hash,expires_at)
          VALUES($1,$2,'background',$3,clock_timestamp()+interval '60 seconds')`,
            [marker.platformStoreId, seededOwner, Buffer.alloc(32)],
          );
          const seeded = await privateLease(observer, marker.platformStoreId, seededOwner);
          assert.ok(
            seeded.valid,
            'a real existing native row prevents vacuous RLS SELECT/UPDATE checks',
          );
          try {
            await app.connect();
            const foreignPlatform = randomUUID();
            await app.query(
              "SELECT set_config('cartoteca.kind','platform',false),set_config('cartoteca.store_id',$1,false)",
              [foreignPlatform],
            );
            const selected = await app.query(
              `SELECT count(*)::int n FROM ${TTL_TABLE} WHERE platform_store_id=$1`,
              [marker.platformStoreId],
            );
            assert.ok(selected.rows[0].n === 0);
            const changed = await app.query(
              `UPDATE ${TTL_TABLE} SET expires_at=clock_timestamp()
            WHERE platform_store_id=$1`,
              [marker.platformStoreId],
            );
            assert.ok(changed.rowCount === 0);
            let denied = false;
            try {
              await app.query(
                `INSERT INTO ${TTL_TABLE}(platform_store_id,owner,role,token_hash,expires_at)
            VALUES($1,$2,'background',$3,clock_timestamp()+interval '60 seconds')`,
                [marker.platformStoreId, randomUUID(), Buffer.alloc(32)],
              );
            } catch (error) {
              denied = error.code === '42501';
            }
            assert.ok(denied, 'foreign-scope INSERT must be rejected by native RLS');
            const retained = await privateLease(observer, marker.platformStoreId, seededOwner);
            assert.ok(
              retained.expiry === seeded.expiry && retained.token_hash.equals(seeded.token_hash),
            );
          } finally {
            try {
              await app.end();
            } finally {
              await admin.query(
                `DELETE FROM ${TTL_TABLE} WHERE platform_store_id=$1 AND owner=$2`,
                [marker.platformStoreId, seededOwner],
              );
            }
          }
        },
      );
    } finally {
      if (holding) await admin.query('ROLLBACK').catch(() => {});
      const closed = await Promise.allSettled([
        closeServer(server),
        ...channels.map((channel) => channel.close()),
        ...(observerConnected ? [observer.end()] : []),
        ...(connected ? [admin.end()] : []),
      ]);
      await runtime.close();
      assert.ok(
        closed.every((item) => item.status === 'fulfilled'),
        'every owned synthetic resource must close',
      );
    }
  },
);
