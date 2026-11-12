const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { largePatient } = require('./helpers/native-memory-large139.cjs');
const { queueFixture } = require('./helpers/postgres-queue134-fixture.cjs');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { writeReceipt } = require('../src/server/infrastructure/mutation-receipts.cjs');
const { createNativeQueryKernel } = require('../src/server/infrastructure/native-query-kernel.cjs');
const {
  createReadOperationClient,
} = require('../src/server/infrastructure/postgres/read-operation-client145.cjs');
const { createNativeExecutor } = require('../src/server/infrastructure/native-executor.cjs');
const {
  createNativeMemoryWorkBudget,
} = require('../src/server/infrastructure/native-memory-work-budget.cjs');
const {
  isPostgresReadOperation,
} = require('../src/server/infrastructure/postgres/read-operation-routes145.cjs');
const {
  createAppointmentConfirmations,
} = require('../src/server/modules/cabinet/confirmations.cjs');
const {
  createPostgresReadOperations,
} = require('../src/server/infrastructure/postgres/read-operations145.cjs');

test(
  'actual async PG145 operations preserve complete read DTOs, RR, fresh revocation and heavy cards',
  { timeout: 120000 },
  async (t) => {
    const f = await queueFixture(t, { cabinetVersion: 1 });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-read145-'));
    t.after(() => {
      assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('cartoteca-read145-'));
      fs.rmSync(directory, { recursive: true, force: true });
    });
    fs.mkdirSync(path.join(directory, 'platform'));
    fs.writeFileSync(
      path.join(directory, 'postgresql-runtime.json'),
      JSON.stringify(f.identity.lineage),
    );
    fs.writeFileSync(path.join(directory, 'platform/platform.key'), crypto.randomBytes(32));
    fs.writeFileSync(path.join(directory, 'encryption.key'), crypto.randomBytes(32));
    const database = createPlatformDatabase(path.join(directory, 'platform'), {
      notificationSchema: 19,
      databaseOwner: f.a.owner,
      sharedCabinetWrites: true,
    });
    const storage = createStorage(directory, {
      cabinetSchema: 1,
      databaseOwner: f.a.owner,
      databaseRoot: directory,
      photoOrganizationId: f.organizations[0],
    });
    const account = crypto.randomUUID(),
      token = 'synthetic-read145-session',
      now = Date.now();
    f.a.p.prepare('UPDATE organizations SET value=? WHERE id=?').run(
      database.seal({
        name: 'Synthetic',
        legacyData: true,
        timeZone: 'Europe/Moscow',
        personalEvents: { version: 1, revision: 0, events: [] },
      }),
      f.organizations[0],
    );
    f.a.p
      .prepare(
        'INSERT INTO accounts(id,email_hash,value,global_admin,status,created_at) VALUES(?,?,?,?,?,?)',
      )
      .run(
        account,
        'synthetic-read145-email',
        database.seal({ displayName: 'Synthetic owner', email: 'synthetic@invalid.test' }),
        0,
        'active',
        now,
      );
    f.a.p
      .prepare(
        'INSERT INTO memberships(organization_id,account_id,role,status,created_at) VALUES(?,?,?,?,?)',
      )
      .run(f.organizations[0], account, 'owner', 'active', now);
    f.a.p
      .prepare(
        'INSERT INTO subscriptions(organization_id,plan,status,limits,changed_at) VALUES(?,?,?,?,?)',
      )
      .run(
        f.organizations[0],
        'free',
        'active',
        database.seal({ automaticNotifications: true, patients: 20000, photos: 20000 }),
        now,
      );
    f.a.p
      .prepare(
        'INSERT INTO platform_sessions(token_hash,id,account_id,organization_id,value,expires_at) VALUES(?,?,?,?,?,?)',
      )
      .run(
        database.tokenHash(token),
        crypto.randomUUID(),
        account,
        f.organizations[0],
        database.seal({}),
        now + 3600000,
      );
    storage.write({
      revision: 0,
      services: [],
      patients: [
        {
          id: 'patient',
          name: 'Synthetic Patient',
          createdBy: account,
          notes: 'Synthetic notes',
          visits: [],
          appointments: [
            {
              id: 'appointment',
              date: '2035-01-02',
              time: '10:00',
              duration: 60,
              service: 'Synthetic',
              staffId: account,
            },
          ],
        },
      ],
    });
    storage.set('mutation-receipt:synthetic-unrelated', { payload: 'x'.repeat(1024 * 1024) });
    const statusId = 'synthetic-status148-native',
      statusUrl = '/api/cabinet/operation?id=' + statusId + '&statusOnly=1',
      statusActor = { accountId: account, organizationId: f.organizations[0], role: 'owner' },
      statusSaved = storage.readSelected(['patient']);
    storage.transaction(() =>
      writeReceipt(
        storage,
        statusActor,
        { id: statusId, hash: 'synthetic-status148' },
        statusSaved,
        {
          patients: [{ id: 'patient', before: null, after: statusSaved.patients[0] }],
          services: [],
        },
        true,
      ),
    );
    const statusProof = storage.get('mutation-outcome-index').at(-1).key;
    // Even a retained 1 MiB replay must not force a compact proof into heavy work.
    storage.set(statusProof.replace(/:committed$/, ''), {
      ...storage.get(statusProof.replace(/:committed$/, '')),
      extra: 'x'.repeat(1024 * 1024),
    });
    const config = {
      dataDir: directory,
      storageBackend: 'postgres',
      postgres: f.runtime.application,
      postgresRevisionProfile: 3,
      databaseOwner: f.a.owner,
      cabinetSchema: 1,
      notificationSchema: 19,
      host: '127.0.0.1',
      port: 4174,
      origin: 'http://127.0.0.1:4174',
      production: false,
      sharedCabinetWrites: true,
      commonNotificationsEnabled: true,
      maxEnabled: false,
      pushEnabled: false,
    };
    const manual = createAppointmentConfirmations({
      ...require('../src/server/infrastructure/platform-constants.cjs'),
      ...database,
    });
    const initialAppointment = storage.readSelected(['patient']).patients[0].appointments[0];
    f.a.p.exec('BEGIN IMMEDIATE');
    try {
      manual.set(
        f.organizations[0],
        'patient',
        initialAppointment,
        'Europe/Moscow',
        account,
        true,
        now,
      );
      f.a.p.exec('COMMIT');
    } catch (error) {
      f.a.p.exec('ROLLBACK');
      throw error;
    }
    const operations = await createPostgresReadOperations(config);
    const legacy = createNativeQueryKernel(config),
      kernel = createNativeQueryKernel(config, { readOperations: operations });
    const metadata = (url) => ({
      method: 'GET',
      url,
      headers: {
        host: '127.0.0.1:4174',
        cookie: 'cartoteca_v2_session=' + token,
        'x-cartoteca-account-id': account,
        'x-cartoteca-organization-id': f.organizations[0],
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
    const decode = (reply) => JSON.parse(Buffer.from(reply.body).toString());
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      await kernel.close();
      legacy.close();
      storage.close();
      database.closeWriter();
      database.db.close();
    };
    t.after(async () => {
      await cleanup();
      assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('cartoteca-read145-'));
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const measurements = {};
    try {
      await t.test(
        'calendar, directory and full patient match existing HTTP contracts',
        async () => {
          for (const url of [
            '/api/cabinet/calendar?from=2035-01-01&to=2035-01-03',
            '/api/cabinet/directory?today=2035-01-01',
            '/api/cabinet/patient?id=patient',
          ]) {
            const old = await legacy.run(metadata(url));
            const before = f.a.owner.stats().calls,
              direct = operations.sqlCalls(),
              at = performance.now();
            const result = await kernel.run(metadata(url));
            assert.equal(old.status, 200, JSON.stringify(decode(old)));
            assert.equal(result.status, 200, JSON.stringify(decode(result)));
            assert.deepEqual(decode(result), decode(old));
            if (url.includes('/patient?'))
              assert.equal(
                decode(result).patients[0].appointments[0].manualConfirmedBy,
                'Synthetic owner',
              );
            measurements[url.split('?')[0]] = {
              legacyIpcCalls: f.a.owner.stats().calls - before,
              directSqlCalls: operations.sqlCalls() - direct,
              observedMs: performance.now() - at,
            };
          }
        },
      );
      await t.test(
        'schema1 card remains explicitly unsupported before a full clinical read',
        async () => {
          assert.deepEqual(
            decode(await kernel.run(metadata('/api/cabinet/patient?id=patient&view=card'))),
            { viewUnsupported: true },
          );
        },
      );
      await t.test(
        'compact status equals legacy without exposing or loading a clinical replay',
        async () => {
          const old = await legacy.run(metadata(statusUrl));
          let upgrades = 0;
          const result = await kernel.run(metadata(statusUrl), null, {
            memoryClass: 'query-probe',
            async requestMemoryClass() {
              upgrades++;
            },
          });
          assert.equal(result.status, 200, JSON.stringify(decode(result)));
          assert.deepEqual(decode(result), decode(old));
          assert.equal(decode(result).status, 'committed');
          assert.equal(upgrades, 0, 'live proof never loads its 1 MiB replay');
          const compact = storage.get(statusProof);
          storage.db.prepare('DELETE FROM meta WHERE key=?').run(statusProof);
          try {
            const legacyOnly = await kernel.run(metadata(statusUrl), null, {
              memoryClass: 'query-probe',
              async requestMemoryClass(kind) {
                assert.equal(kind, 'query');
                upgrades++;
              },
            });
            assert.equal(legacyOnly.status, 200, JSON.stringify(decode(legacyOnly)));
            assert.deepEqual(decode(legacyOnly), {
              status: 'committed',
              revision: statusSaved.revision,
            });
            assert.equal(upgrades, 1, 'legacy replay is bounded before its larger metadata fetch');
          } finally {
            storage.set(statusProof, compact);
          }
          assert.deepEqual(
            decode(
              await kernel.run(
                metadata(statusUrl.replace(statusId, 'synthetic-status148-missing')),
              ),
            ),
            { status: 'unknown' },
          );
          assert.equal(
            (await kernel.run(metadata('/api/cabinet/operation?statusOnly=1'))).status,
            400,
          );
          const foreign = metadata(statusUrl);
          foreign.headers['x-cartoteca-organization-id'] = f.organizations[1];
          assert.equal((await kernel.run(foreign)).status, 428);
        },
      );
      await t.test('foreign cabinet context remains rejected', async () => {
        const data = metadata('/api/cabinet/patient?id=patient');
        data.headers['x-cartoteca-organization-id'] = f.organizations[1];
        assert.equal((await kernel.run(data)).status, 428);
      });

      await t.test(
        '152 native views reuse unchanged clinical rows and observe direct writes, deletes and rollback',
        async () => {
          const url = '/api/cabinet/directory?limit=10&today=2035-01-01';
          const first = decode(await kernel.run(metadata(url)));
          const before = operations.viewStats();
          assert.deepEqual(decode(await kernel.run(metadata(url))), first);
          assert.equal(operations.viewStats().hits, before.hits + 1);
          assert.ok(operations.viewStats().sqlResults.hits > before.sqlResults.hits);
          // Another cabinet changes the global MVCC snapshot without invalidating ours.
          f.a.c[1]
            .prepare('INSERT INTO meta(key,value) VALUES(?,?)')
            .run('synthetic-other-152', Buffer.from('opaque'));
          const prior = operations.viewStats().hits;
          assert.deepEqual(decode(await kernel.run(metadata(url))), first);
          assert.equal(operations.viewStats().hits, prior + 1);
          const saved = storage.db
            .prepare("SELECT value FROM cabinet_summaries WHERE patient_id=? AND audience='*'")
            .get('patient').value;
          const changed = { ...storage.decode(saved), visitCount: 123 };
          storage.db
            .prepare("UPDATE cabinet_summaries SET value=? WHERE patient_id=? AND audience='*'")
            .run(storage.encode(changed), 'patient');
          assert.equal(
            decode(await kernel.run(metadata(url))).directory[0].visitCount,
            123,
            'raw SQL changed no cabinet revision',
          );
          storage.db
            .prepare("DELETE FROM cabinet_summaries WHERE patient_id=? AND audience='*'")
            .run('patient');
          assert.equal(decode(await kernel.run(metadata(url))).directory.length, 0);
          storage.db
            .prepare('INSERT INTO cabinet_summaries(patient_id,audience,value) VALUES(?,?,?)')
            .run('patient', '*', saved);
          assert.deepEqual(decode(await kernel.run(metadata(url))), first);
          storage.db.exec('BEGIN IMMEDIATE');
          storage.db
            .prepare("UPDATE cabinet_summaries SET value=? WHERE patient_id=? AND audience='*'")
            .run(storage.encode(changed), 'patient');
          storage.db.exec('ROLLBACK');
          assert.deepEqual(decode(await kernel.run(metadata(url))), first);
          const counters = kernel.stats().routes.directory;
          assert.equal(counters.rpcCalls, 0, 'fresh native authorization uses no blocking bridge');
        },
      );
      await t.test(
        '152 warm calendar still observes confirmation and actor changes from platform',
        async () => {
          const url = '/api/cabinet/calendar?from=2035-01-01&to=2035-01-03';
          assert.ok(decode(await kernel.run(metadata(url))).appointments[0].manualConfirmedAt);
          const before = operations.viewStats().hits;
          f.a.p.exec('BEGIN IMMEDIATE');
          manual.set(
            f.organizations[0],
            'patient',
            initialAppointment,
            'Europe/Moscow',
            account,
            false,
            now,
          );
          f.a.p.exec('COMMIT');
          assert.equal(
            decode(await kernel.run(metadata(url))).appointments[0].manualConfirmedAt,
            null,
          );
          assert.equal(
            operations.viewStats().hits,
            before + 1,
            'only undecorated clinical view was reused',
          );
          f.a.p.exec('BEGIN IMMEDIATE');
          manual.set(
            f.organizations[0],
            'patient',
            initialAppointment,
            'Europe/Moscow',
            account,
            true,
            now,
          );
          f.a.p.exec('COMMIT');
          const value = f.a.p.prepare('SELECT value FROM accounts WHERE id=?').get(account).value;
          f.a.p
            .prepare('UPDATE accounts SET value=? WHERE id=?')
            .run(
              database.seal({ ...database.open(value), displayName: 'Fresh actor152' }),
              account,
            );
          assert.equal(
            decode(await kernel.run(metadata(url))).appointments[0].manualConfirmedBy,
            'Fresh actor152',
          );
          f.a.p.prepare('UPDATE accounts SET value=? WHERE id=?').run(value, account);
        },
      );
      await t.test('152 a warm clinical cache cannot mask fresh catalog tampering', async () => {
        const url = '/api/cabinet/directory?today=2035-01-01';
        assert.equal((await kernel.run(metadata(url))).status, 200);
        const saved = await f.admin.query(
          "SELECT metadata FROM cartoteca_catalog.stores WHERE kind='cabinet' AND store_id=$1",
          [f.cabinets[0].storeId],
        );
        await f.admin.query(
          "UPDATE cartoteca_catalog.stores SET metadata=metadata||'{\"syntheticTampered152\":true}'::jsonb WHERE kind='cabinet' AND store_id=$1",
          [f.cabinets[0].storeId],
        );
        try {
          assert.equal((await kernel.run(metadata(url))).status, 503);
        } finally {
          await f.admin.query(
            "UPDATE cartoteca_catalog.stores SET metadata=$1 WHERE kind='cabinet' AND store_id=$2",
            [saved.rows[0].metadata, f.cabinets[0].storeId],
          );
        }
        assert.equal((await kernel.run(metadata(url))).status, 200);
      });
      await t.test(
        'large accepted history upgrades before full fetch and reads its original RR after a concurrent commit',
        async () => {
          const before = storage.readSelected(['patient']);
          const appointments = before.patients[0].appointments;
          before.patients[0] = {
            ...largePatient('patient', { createdBy: account, notes: 'original' }, 40),
            appointments,
          };
          storage.write(before, { changedIds: { patients: ['patient'], services: [] } });
          let upgraded = false;
          const result = await kernel.run(metadata('/api/cabinet/patient?id=patient'), null, {
            memoryClass: 'query-probe',
            async requestMemoryClass(kind) {
              assert.equal(kind, 'query');
              upgraded = true;
              const next = storage.readSelected(['patient']);
              next.patients[0].notes = 'concurrent changed';
              storage.write(next, { changedIds: { patients: ['patient'], services: [] } });
            },
          });
          assert.equal(result.status, 200, JSON.stringify(decode(result)));
          assert.equal(upgraded, true);
          assert.equal(decode(result).patients[0].notes, 'original');
          assert.equal(decode(result).patients[0].visits.length, 40);
          assert.equal(
            decode(await kernel.run(metadata('/api/cabinet/patient?id=patient'))).patients[0].notes,
            'concurrent changed',
          );
        },
      );
      await t.test(
        'cumulative probes upgrade memory once for the same physical operation',
        async () => {
          const client = await createReadOperationClient(config);
          let upgrades = 0;
          try {
            await client.run(
              {
                scope: f.cabinets[0],
                assertActive() {},
                probeClass: true,
                async requestMemoryClass(kind) {
                  assert.equal(kind, 'query');
                  upgrades++;
                },
              },
              async (operation) => {
                const sources = [
                  {
                    scope: operation.scope,
                    catalog: operation.cabinetCatalog,
                    table: 'patients',
                    where: 's.id=$2',
                    values: ['patient'],
                  },
                ];
                await operation.probe(sources);
                await operation.probe(sources);
              },
            );
            assert.equal(upgrades, 1);
          } finally {
            await client.close();
          }
        },
      );

      await t.test(
        '151 typed batches keep BLOBs, text, empty branches, scope and SQL call bounds',
        async () => {
          const client = await createReadOperationClient(config);
          try {
            for (let attempt = 0; attempt < 2; attempt++)
              await client.run(
                { scope: f.cabinets[0], assertActive() {}, probeClass: false },
                async (op) => {
                  const db = op.rows.store(op.scope, op.cabinetCatalog);
                  await op.probe([
                    {
                      scope: op.scope,
                      catalog: op.cabinetCatalog,
                      table: 'meta',
                      where: 'true',
                      values: [],
                    },
                  ]);
                  const statements = [
                    ['SELECT key,value FROM meta WHERE key=?', 'revision'],
                    ['SELECT value FROM meta WHERE key=?', 'initialized'],
                    ['SELECT key,value FROM meta WHERE key=?', "missing' $1 \\x636970686572"],
                  ];
                  const before = client.sqlCalls();
                  await db.prefetchAll(
                    statements.map(([sql, key]) => db.prepare(sql).readRequest('get', [key])),
                  );
                  assert.equal(client.sqlCalls() - before, 1, 'three lookups use one physical SQL');
                  const first = db.prepare(statements[0][0]).get('revision');
                  assert.equal(first.key, 'revision');
                  assert.ok(Buffer.isBuffer(first.value));
                  assert.ok(Buffer.isBuffer(db.prepare(statements[1][0]).get('initialized').value));
                  assert.equal(db.prepare(statements[2][0]).get(statements[2][1]), undefined);
                },
              );
          } finally {
            await client.close();
          }
        },
      );
      await t.test(
        'a missing aggregate source is rejected before executing the unbounded clinical SELECT',
        async () => {
          const client = await createReadOperationClient(config);
          try {
            await assert.rejects(
              client.run(
                { scope: f.cabinets[0], assertActive() {}, probeClass: false },
                async (op) => {
                  await op.probe([
                    {
                      scope: op.scope,
                      catalog: op.cabinetCatalog,
                      table: 'meta',
                      where: 'true',
                      values: [],
                    },
                  ]);
                  const db = op.rows.store(op.scope, op.cabinetCatalog),
                    before = client.sqlCalls();
                  await assert.rejects(
                    db.prefetchAll([
                      db
                        .prepare('SELECT id,value FROM patients WHERE id=?')
                        .readRequest('get', ['patient']),
                    ]),
                    { code: 'POSTGRES_READ_OPERATION_SOURCE_UNCOVERED' },
                  );
                  assert.equal(client.sqlCalls(), before, 'rejected before PG fetch');
                  throw Error('synthetic-undercoverage');
                },
              ),
              /synthetic-undercoverage/,
            );
          } finally {
            await client.close();
          }
        },
      );
      await t.test(
        'the ordinary native query worker uses the new repository and physical probe-to-heavy ACK',
        async () => {
          const MiB = 1024 * 1024;
          const work = createNativeMemoryWorkBudget({
            version: 1,
            maxBytes: 896 * MiB,
            queryBytes: 384 * MiB,
            queryProbeBytes: 96 * MiB,
            commandBytes: 512 * MiB,
            estimatedWorkingSet: true,
            rssHardCapClaim: false,
          });
          const { databaseOwner: _owner, ...workerConfig } = config;
          const executor = createNativeExecutor({
            filename: path.join(__dirname, '../src/server/infrastructure/native-query-worker.cjs'),
            workerData: { config: workerConfig },
            concurrency: 1,
            workBudget: work,
            boundedRead: isPostgresReadOperation,
          });
          try {
            await executor.ready();
            const small = await executor.run({
              kind: 'query',
              metadata: metadata('/api/cabinet/directory?today=2035-01-01'),
            });
            try {
              assert.equal(small.status, 200, small.body.toString());
            } finally {
              small.release();
            }
            assert.equal(
              work.stats().peakBytes,
              96 * MiB,
              'unrelated retained mutation receipts do not upgrade bounded directory reads',
            );
            const command = await work.acquire('command');
            try {
              const status = await executor.run({ kind: 'query', metadata: metadata(statusUrl) });
              try {
                assert.equal(status.status, 200, status.body.toString());
                assert.equal(decode(status).status, 'committed');
                assert.equal(work.stats().peakBytes, 608 * MiB);
              } finally {
                status.release();
              }
            } finally {
              command.release();
            }
            const large = await executor.run({
              kind: 'query',
              metadata: metadata('/api/cabinet/patient?id=patient'),
            });
            try {
              assert.equal(large.status, 200, large.body.toString());
              assert.equal(decode(large).patients[0].visits.length, 40);
            } finally {
              large.release();
            }
            const diagnostics = executor.stats().queryDiagnostics;
            assert.ok(diagnostics);
            assert.equal(work.stats().usedBytes, 0);
            assert.ok(work.stats().peakBytes >= 384 * MiB);
          } finally {
            await executor.close();
            work.close();
          }
        },
      );
      await t.test(
        'revocation during async projection is observed outside the data snapshot before bytes are returned',
        async () => {
          let injected = 0;
          const wrapped = {
            ...operations,
            borrow166() {
              const borrowed = operations.borrow166();
              if (!borrowed) return null;
              return {
                ...borrowed,
                async run(context, execution) {
                  const json = context.json;
                  return borrowed.run(
                    {
                      ...context,
                      json(...args) {
                        injected++;
                        f.a.p
                          .prepare(
                            "UPDATE memberships SET status='inactive' WHERE organization_id=? AND account_id=?",
                          )
                          .run(f.organizations[0], account);
                        return json(...args);
                      },
                    },
                    execution,
                  );
                },
              };
            },
          };
          const revoked = createNativeQueryKernel(config, { readOperations: wrapped });
          for (const url of ['/api/cabinet/directory?today=2035-01-01', statusUrl]) {
            f.a.p
              .prepare(
                "UPDATE memberships SET status='active' WHERE organization_id=? AND account_id=?",
              )
              .run(f.organizations[0], account);
            assert.equal((await revoked.run(metadata(url))).status, 401);
          }
          assert.equal(
            injected,
            2,
            'both actual leased projections must revoke before fresh postauthority',
          );
          // The kernel remains owned by the outer test, avoiding a second close of its shared coordinator.
        },
      );
      t.diagnostic('PG145 observations ' + JSON.stringify(measurements));
    } finally {
      await cleanup();
    }
  },
);

test(
  'native worker145 pages prepared schema2 history with bounded fresh appointment decoration',
  { timeout: 120000 },
  async (t) => {
    const { digest } = require('../src/server/infrastructure/postgres/catalog-sqlite.cjs');
    const f = await queueFixture(t);
    let opened = f.a;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-read145-pages-'));
    t.after(() => {
      assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('cartoteca-read145-'));
      fs.rmSync(directory, { recursive: true, force: true });
    });
    fs.mkdirSync(path.join(directory, 'platform'));
    fs.writeFileSync(
      path.join(directory, 'postgresql-runtime.json'),
      JSON.stringify(f.identity.lineage),
    );
    fs.writeFileSync(path.join(directory, 'platform/platform.key'), crypto.randomBytes(32));
    fs.writeFileSync(path.join(directory, 'encryption.key'), crypto.randomBytes(32));
    const tenantDirectory = path.join(directory, 'tenants', f.organizations[1]);
    fs.mkdirSync(tenantDirectory, { recursive: true });
    fs.writeFileSync(path.join(tenantDirectory, 'encryption.key'), crypto.randomBytes(32));
    const database = createPlatformDatabase(path.join(directory, 'platform'), {
      notificationSchema: 19,
      databaseOwner: opened.owner,
      sharedCabinetWrites: true,
    });
    const storage = createStorage(directory, {
      cabinetSchema: 2,
      databaseOwner: opened.owner,
      databaseRoot: directory,
      photoOrganizationId: f.organizations[0],
    });
    const account = crypto.randomUUID(),
      token = 'synthetic-read145-page-session',
      now = Date.now();
    opened.p.prepare('UPDATE organizations SET value=? WHERE id=?').run(
      database.seal({
        name: 'Synthetic',
        legacyData: true,
        timeZone: 'Europe/Moscow',
        personalEvents: { version: 1, revision: 0, events: [] },
      }),
      f.organizations[0],
    );
    opened.p
      .prepare(
        'INSERT INTO accounts(id,email_hash,value,global_admin,status,created_at) VALUES(?,?,?,?,?,?)',
      )
      .run(
        account,
        'synthetic-read145-page-email',
        database.seal({ displayName: 'Synthetic owner', email: 'synthetic-page@invalid.test' }),
        0,
        'active',
        now,
      );
    opened.p
      .prepare(
        'INSERT INTO memberships(organization_id,account_id,role,status,created_at) VALUES(?,?,?,?,?)',
      )
      .run(f.organizations[0], account, 'owner', 'active', now);
    opened.p
      .prepare(
        'INSERT INTO subscriptions(organization_id,plan,status,limits,changed_at) VALUES(?,?,?,?,?)',
      )
      .run(
        f.organizations[0],
        'free',
        'active',
        database.seal({ automaticNotifications: true, patients: 20000, photos: 20000 }),
        now,
      );
    opened.p
      .prepare(
        'INSERT INTO platform_sessions(token_hash,id,account_id,organization_id,value,expires_at) VALUES(?,?,?,?,?,?)',
      )
      .run(
        database.tokenHash(token),
        crypto.randomUUID(),
        account,
        f.organizations[0],
        database.seal({}),
        now + 3600000,
      );
    const patient = {
      id: 'patient',
      name: 'Synthetic Patient',
      createdBy: account,
      notes: 'Complete profile',
      visits: Array.from({ length: 137 }, (_, i) => ({
        id: 'visit-' + i,
        date: '2020-01-01',
        staffId: account,
        procedure: 'Synthetic',
        photos: [],
      })),
      appointments: Array.from({ length: 61 }, (_, i) => ({
        id: 'appointment-' + i,
        date: '2035-01-02',
        time: '10:00',
        duration: 60,
        service: 'Synthetic',
        staffId: account,
      })),
    };
    storage.write({ revision: 0, services: [], patients: [patient] });
    const manual = createAppointmentConfirmations({
      ...require('../src/server/infrastructure/platform-constants.cjs'),
      ...database,
    });
    opened.p.exec('BEGIN IMMEDIATE');
    try {
      manual.set(
        f.organizations[0],
        patient.id,
        patient.appointments[0],
        'Europe/Moscow',
        account,
        true,
        now,
      );
      opened.p.exec('COMMIT');
    } catch (error) {
      opened.p.exec('ROLLBACK');
      throw error;
    }
    storage.close();
    database.closeWriter();
    database.db.close();
    await opened.owner.close();
    const {
      preparePostgresPatientHistory,
    } = require('../src/server/infrastructure/postgres/history-prepare145.cjs');
    const {
      MARKER,
      acquireOfflinePreparation145,
    } = require('../src/server/infrastructure/postgres/assistant-prepare145.cjs');
    const markerFile = path.join(directory, 'postgresql-runtime.json');
    const gate = path.join(directory, '.restore-in-progress');
    fs.writeFileSync(gate, MARKER);
    const offline = await acquireOfflinePreparation145({ client: f.admin, directory });
    try {
      await f.admin.query('BEGIN');
      const prepared = await preparePostgresPatientHistory({
        client: f.admin,
        directory,
        applicationRole: f.runtime.application.user,
        runtime: f.identity.lineage,
      });
      f.identity.lineage = prepared.runtime;
      f.identity.markerHash = digest(prepared.runtime);
      await f.admin.query(
        "UPDATE cartoteca_catalog.asset_profiles SET marker_hash=$1 WHERE kind='platform' AND store_id=$2",
        [f.identity.markerHash, f.platform.storeId],
      );
      await f.admin.query('COMMIT');
      fs.writeFileSync(markerFile, JSON.stringify(f.identity.lineage));
    } catch (error) {
      await f.admin.query('ROLLBACK');
      throw error;
    } finally {
      await offline.release();
    }
    fs.unlinkSync(gate);
    opened = await f.open();
    const config = {
      dataDir: directory,
      storageBackend: 'postgres',
      postgres: f.runtime.application,
      postgresRevisionProfile: 3,
      cabinetSchema: 2,
      notificationSchema: 19,
      host: '127.0.0.1',
      port: 4174,
      origin: 'http://127.0.0.1:4174',
      production: false,
      sharedCabinetWrites: true,
      commonNotificationsEnabled: true,
      maxEnabled: false,
      pushEnabled: false,
    };
    const metadata = (url) => ({
      method: 'GET',
      url,
      headers: {
        host: '127.0.0.1:4174',
        cookie: 'cartoteca_v2_session=' + token,
        'x-cartoteca-account-id': account,
        'x-cartoteca-organization-id': f.organizations[0],
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
    const MiB = 1024 * 1024,
      work = createNativeMemoryWorkBudget({
        version: 1,
        maxBytes: 896 * MiB,
        queryBytes: 384 * MiB,
        queryProbeBytes: 96 * MiB,
        commandBytes: 512 * MiB,
        estimatedWorkingSet: true,
        rssHardCapClaim: false,
      });
    const executor = createNativeExecutor({
      filename: path.join(__dirname, '../src/server/infrastructure/native-query-worker.cjs'),
      workerData: { config },
      concurrency: 1,
      workBudget: work,
      boundedRead: isPostgresReadOperation,
    });
    const legacy = createNativeQueryKernel({ ...config, databaseOwner: opened.owner });
    const get = async (url, status = 200) => {
      const reply = await executor.run({ kind: 'query', metadata: metadata(url) });
      try {
        const data = JSON.parse(reply.body.toString());
        assert.equal(reply.status, status, JSON.stringify(data));
        return data;
      } finally {
        reply.release();
      }
    };
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      await executor.close();
      work.close();
      legacy.close();
      storage.close();
      database.closeWriter();
      database.db.close();
    };
    t.after(async () => {
      await cleanup();
      assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('cartoteca-read145-pages-'));
      fs.rmSync(directory, { recursive: true, force: true });
    });
    try {
      await executor.ready();
      await t.test(
        '161 native edit snapshot fetches exactly one canonical appointment without full history',
        async () => {
          const result = await get(
            '/api/cabinet/patient?id=patient&view=appointment&appointmentId=appointment-0',
          );
          assert.equal(result.kind, 'appointment-edit-v1');
          assert.equal(result.patient.id, 'patient');
          assert.equal(result.appointment.id, 'appointment-0');
          assert.equal('visits' in result.patient, false);
          assert.equal('appointments' in result.patient, false);
          assert.equal('patients' in result, false);
          assert.deepEqual(result.appointment, patient.appointments[0]);
          const detailed = await get(
            '/api/cabinet/patient?id=patient&view=appointment&appointmentId=appointment-0&details=1',
          );
          assert.equal(detailed.displayAppointment.id, 'appointment-0');
          assert.ok(detailed.displayAppointment.confirmationKey);
          assert.deepEqual(detailed.appointment, patient.appointments[0]);
          await get('/api/cabinet/patient?id=patient&view=appointment&appointmentId=missing', 404);
        },
      );
      await t.test(
        '152 native page bundle preserves the existing canonical projector',
        async () => {
          const operations = await createPostgresReadOperations({
            ...config,
            databaseOwner: opened.owner,
          });
          try {
            const authority = await operations.authorize(token, () => {});
            for (const address of [
              '/api/cabinet/patient?id=patient&view=card',
              '/api/cabinet/patient/history?id=patient',
              '/api/cabinet/patient/upcoming?id=patient',
            ]) {
              const value = await operations.run({
                req: metadata(address),
                url: new URL(address, config.origin),
                current: authority.current,
                assertActive() {},
                res: {},
                json: (_res, status, data) => ({ status, data }),
                providers: {
                  telegram: { status: () => ({ configured: false, connected: false, botId: '' }) },
                  max: { status: () => ({ configured: false, connected: false, botId: '' }) },
                },
              });
              assert.equal(value.status, 200);
            }
          } finally {
            await operations.close();
          }
        },
      );
      await t.test(
        'schema2 directory and calendar use the real worker without enrolling clinical records for LIMIT0',
        async () => {
          for (const url of [
            '/api/cabinet/directory?limit=5',
            '/api/cabinet/calendar?from=2035-01-01&to=2035-01-03',
          ]) {
            const value = await get(url);
            const prior = await legacy.run(metadata(url));
            assert.equal(prior.status, 200, Buffer.from(prior.body).toString());
            assert.deepEqual(value, JSON.parse(Buffer.from(prior.body).toString()));
          }
          const client = await createReadOperationClient(config);
          try {
            await assert.rejects(
              client.run(
                { scope: f.cabinets[0], assertActive() {}, probeClass: false },
                async (operation) => {
                  await operation.probe([
                    {
                      scope: operation.scope,
                      catalog: operation.cabinetCatalog,
                      table: 'meta',
                      where: "s.key IN ('revision','initialized')",
                      values: [],
                    },
                  ]);
                  const db = operation.rows.store(operation.scope, operation.cabinetCatalog);
                  await db.prefetchAll([
                    db
                      .prepare(
                        'SELECT kind,id,patient_id,position,value FROM cabinet_patient_records LIMIT 0',
                      )
                      .readRequest('all', []),
                  ]);
                  assert.deepEqual(
                    db
                      .prepare(
                        'SELECT kind,id,patient_id,position,value FROM cabinet_patient_records LIMIT 0',
                      )
                      .all(),
                    [],
                  );
                  const before = client.sqlCalls();
                  await assert.rejects(
                    db.prefetchAll([
                      db
                        .prepare(
                          'SELECT kind,id,patient_id,position,value FROM cabinet_patient_records WHERE patient_id=?',
                        )
                        .readRequest('all', ['patient']),
                    ]),
                    { code: 'POSTGRES_READ_OPERATION_SOURCE_UNCOVERED' },
                  );
                  assert.equal(
                    client.sqlCalls(),
                    before,
                    'catalog-only check never enrolls a clinical table',
                  );
                  throw Error('synthetic-uncovered-records');
                },
              ),
              /synthetic-uncovered-records/,
            );
          } finally {
            await client.close();
          }
        },
      );

      await t.test(
        '152 warm owner cache cannot grant staff access and canonical witness corruption fails closed',
        async () => {
          const staff = crypto.randomUUID(),
            outsider = crypto.randomUUID();
          const actors = [];
          for (const id of [staff, outsider]) {
            const rawToken = 'synthetic-staff152-' + crypto.randomUUID();
            opened.p
              .prepare(
                'INSERT INTO accounts(id,email_hash,value,global_admin,status,created_at) VALUES(?,?,?,?,?,?)',
              )
              .run(
                id,
                'synthetic-' + id,
                database.seal({ displayName: 'Synthetic staff', email: 'staff@invalid.test' }),
                0,
                'active',
                now,
              );
            opened.p
              .prepare(
                'INSERT INTO memberships(organization_id,account_id,role,status,created_at) VALUES(?,?,?,?,?)',
              )
              .run(f.organizations[0], id, 'cosmetologist', 'active', now);
            opened.p
              .prepare(
                'INSERT INTO platform_sessions(token_hash,id,account_id,organization_id,value,expires_at) VALUES(?,?,?,?,?,?)',
              )
              .run(
                database.tokenHash(rawToken),
                crypto.randomUUID(),
                id,
                f.organizations[0],
                database.seal({}),
                now + 3600000,
              );
            actors.push({ id, token: rawToken });
          }
          const dataStore = createStorage(directory, {
            cabinetSchema: 2,
            databaseOwner: opened.owner,
            databaseRoot: directory,
            photoOrganizationId: f.organizations[0],
          });
          try {
            const next = dataStore.readSelected(['patient']);
            next.patients[0].visits[0].staffId = staff;
            dataStore.write(next, { changedIds: { patients: ['patient'], services: [] } });
            await get('/api/cabinet/patient?id=patient&view=card');
            const scoped = async (actor, url, status = 200) => {
              const request = metadata(url);
              request.headers.cookie = 'cartoteca_v2_session=' + actor.token;
              request.headers['x-cartoteca-account-id'] = actor.id;
              const reply = await executor.run({ kind: 'query', metadata: request });
              try {
                const value = JSON.parse(reply.body.toString());
                assert.equal(reply.status, status, JSON.stringify(value));
                return value;
              } finally {
                reply.release();
              }
            };
            const owned = await scoped(actors[0], '/api/cabinet/patient?id=patient&view=card');
            assert.equal(owned.patient.visits.length, 1);
            assert.equal(owned.patient.appointments.length, 0);
            assert.equal(owned.patient.visits[0].staffId, staff);
            await scoped(actors[1], '/api/cabinet/patient?id=patient&view=card', 404);
            assert.equal(
              (await scoped(actors[1], '/api/cabinet/directory?limit=10')).directory.length,
              0,
            );
            assert.equal(
              (await scoped(actors[1], '/api/cabinet/calendar?from=2035-01-01&to=2035-01-03'))
                .appointments.length,
              0,
            );
            const prior = dataStore.db
              .prepare(
                "SELECT value FROM cabinet_patient_records WHERE patient_id=? AND kind='visit' AND id=?",
              )
              .get('patient', 'visit-0').value;
            dataStore.db
              .prepare(
                "UPDATE cabinet_patient_records SET value=? WHERE patient_id=? AND kind='visit' AND id=?",
              )
              .run(
                dataStore.encode({ ...dataStore.decode(prior), staffId: account }),
                'patient',
                'visit-0',
              );
            await scoped(actors[0], '/api/cabinet/patient?id=patient&view=card', 503);
            dataStore.db
              .prepare(
                "UPDATE cabinet_patient_records SET value=? WHERE patient_id=? AND kind='visit' AND id=?",
              )
              .run(prior, 'patient', 'visit-0');
            assert.equal(
              (await scoped(actors[0], '/api/cabinet/patient?id=patient&view=card')).patient.visits
                .length,
              1,
            );
          } finally {
            dataStore.close();
          }
        },
      );
      await t.test(
        'card and upcoming retain bounded canonical statuses, manual actor and complete full-edit response',
        async () => {
          const card = await get('/api/cabinet/patient?id=patient&view=card');
          assert.equal(card.history.entries.length, 50);
          assert.equal(card.history.total, 137);
          assert.equal(card.upcoming.entries.length, 50);
          assert.equal(card.upcoming.total, 61);
          assert.equal(card.patient.visits.length, 50);
          assert.equal(card.patient.appointments.length, 50);
          assert.equal(card.upcoming.entries[0].manualConfirmedBy, 'Synthetic owner');
          assert.ok(card.upcoming.entries[0].confirmationKey);
          assert.equal(card.upcoming.entries[0].deliveryReady, true);
          assert.deepEqual(card.patient.appointments[0], card.upcoming.entries[0]);
          const old = await legacy.run(metadata('/api/cabinet/patient?id=patient&view=card'));
          assert.equal(old.status, 200, old.body.toString());
          const cursorShape = (value) => {
            const result = structuredClone(value);
            const { decode } =
              require('../src/server/migrations/prepare-cabinet-records.cjs').codec(
                fs.readFileSync(path.join(directory, 'encryption.key')),
              );
            for (const field of ['history', 'upcoming'])
              if (result[field]?.nextCursor)
                result[field].nextCursor = decode(
                  Buffer.from(result[field].nextCursor, 'base64url'),
                );
            return result;
          };
          assert.deepEqual(
            cursorShape(card),
            cursorShape(JSON.parse(Buffer.from(old.body).toString())),
          );
          const upcoming = await get('/api/cabinet/patient/upcoming?id=patient');
          assert.deepEqual(upcoming.entries, card.upcoming.entries);
          const remaining = await get(
            '/api/cabinet/patient/upcoming?id=patient&cursor=' +
              encodeURIComponent(upcoming.nextCursor),
          );
          assert.equal(remaining.entries.length, 11);
          assert.equal(remaining.nextCursor, null);
          const full = await get('/api/cabinet/patient?id=patient');
          assert.equal(full.patients[0].visits.length, 137);
          assert.equal(full.patients[0].appointments.length, 61);
        },
      );
      await t.test(
        'history cursors stay bounded, revision/session checks and unsupported schema1 marker remain explicit',
        async () => {
          const card = await get('/api/cabinet/patient?id=patient&view=card');
          const page = await get(
            '/api/cabinet/patient/history?id=patient&cursor=' +
              encodeURIComponent(card.history.nextCursor),
          );
          assert.equal(page.entries.length, 50);
          assert.equal(page.total, 137);
          assert.equal(page.entries[0].record.confirmationKey, undefined);
          await get('/api/cabinet/patient/history?id=patient&cursor=forged', 400);
          await get('/api/cabinet/patient/upcoming?id=patient&revision=999', 409);
          const data = metadata('/api/cabinet/patient?id=patient&view=card');
          data.headers['x-cartoteca-organization-id'] = f.organizations[1];
          const foreign = await executor.run({ kind: 'query', metadata: data });
          try {
            assert.equal(foreign.status, 428);
          } finally {
            foreign.release();
          }
          assert.ok(executor.stats().queryDiagnostics);
          assert.equal(work.stats().usedBytes, 0);
          assert.equal(
            work.stats().peakBytes,
            96 * MiB,
            'bounded pages need no heavy clinical materialization',
          );
        },
      );
    } finally {
      await cleanup();
    }
  },
);
