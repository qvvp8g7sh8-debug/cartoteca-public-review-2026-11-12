const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Client } = require('pg');
const { nativeIsolatedFixture } = require('./helpers/native-isolated-fixture.cjs');
const { startPostgresTestRuntime } = require('../scripts/postgres-test-runtime.cjs');
const { migratePostgresData } = require('../src/server/infrastructure/postgres/migration.cjs');
const { initializePostgresOwner } = require('../src/server/infrastructure/postgres/initialize.cjs');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const { createNativeQueryKernel } = require('../src/server/infrastructure/native-query-kernel.cjs');
const { KEYS } = require('../src/server/infrastructure/postgres/lock-intents.cjs');
const appointmentId = 'synthetic-readonly-appointment';
function runtime() {
  const provider = { configured: false, connected: false, botId: '' };
  return {
    telegram: { ...provider, username: '', error: '' },
    providers: { telegram: { ...provider }, max: { ...provider } },
    timestamp: Date.now(),
  };
}
async function read(kernel, actor, url, headers = {}) {
  const result = await kernel.run({
    method: 'GET',
    url,
    localPort: 4174,
    remoteAddress: '127.0.0.1',
    runtime: runtime(),
    headers: {
      host: '127.0.0.1:4174',
      cookie: 'cartoteca_v2_session=' + actor.token,
      'x-cartoteca-account-id': actor.accountId,
      'x-cartoteca-organization-id': actor.organizationId,
      ...headers,
    },
  });
  return { status: result.status, body: JSON.parse(Buffer.from(result.body).toString('utf8')) };
}
test(
  'actual PostgreSQL read-only application ports preserve snapshots and native fresh authority',
  { timeout: 120000 },
  async (t) => {
    const f = await nativeIsolatedFixture(t, { organizations: 2 }),
      [actor, foreign] = f.actors;
    const seed = createStorage(path.join(f.directory, 'tenants', actor.organizationId));
    try {
      const state = seed.read();
      state.patients[0].appointments = [
        {
          id: appointmentId,
          staffId: actor.accountId,
          date: '2035-01-02',
          time: '10:00',
          duration: 30,
          service: 'Synthetic service',
        },
      ];
      seed.write(state);
    } finally {
      seed.close();
    }
    const runtimePG = await startPostgresTestRuntime(),
      admin = new Client(runtimePG.admin);
    let storageOwner, queryOwner, storage, kernel;
    t.after(async () => {
      await kernel?.close();
      storage?.close();
      await storageOwner?.close();
      await queryOwner?.close();
      await admin.end();
      await runtimePG.close();
    });
    await admin.connect();
    const destination = path.join(runtimePG.root, 'assets');
    const imported = await migratePostgresData({
      source: f.directory,
      destination,
      client: admin,
      applicationRole: runtimePG.application.user,
      offline: true,
      dryRun: false,
    });
    assert.equal(imported.sourceUnchanged, true);
    const config = {
      ...f.config,
      dataDir: destination,
      storageBackend: 'postgres',
      postgres: runtimePG.application,
    };
    const storageOptions = await initializePostgresOwner(config);
    storageOwner = storageOptions.databaseOwner;
    storage = createStorage(path.join(destination, 'tenants', actor.organizationId), {
      databaseOwner: storageOwner,
      databaseRoot: destination,
      photoOrganizationId: actor.organizationId,
    });
    const queryOptions = await initializePostgresOwner(config);
    queryOwner = queryOptions.databaseOwner;
    kernel = createNativeQueryKernel(queryOptions);
    const marker = require('../src/server/infrastructure/postgres/runtime.cjs').readRuntime(
      destination,
    );
    await admin.query(
      "SELECT set_config('cartoteca.kind','platform',false),set_config('cartoteca.store_id',$1,false)",
      [marker.platformStoreId],
    );
    const current = {
      accountId: actor.accountId,
      organizationId: actor.organizationId,
      role: 'owner',
    };
    await t.test(
      'all seven storage reads bypass unrelated policy/writer contention and retain exact bodies',
      async () => {
        await admin.query('SELECT pg_advisory_lock($1::bigint),pg_advisory_lock($2::bigint)', [
          KEYS.policy,
          KEYS.writer,
        ]);
        try {
          assert.equal(storage.read().patients[0].id, actor.patientId);
          assert.equal(storage.readSelected([actor.patientId]).patients[0].id, actor.patientId);
          assert.equal(storage.overview(current).directory[0].id, actor.patientId);
          assert.deepEqual(storage.readServices(), []);
          assert.equal(storage.readPatientAppointments(actor.patientId)[0].id, appointmentId);
          assert.equal(storage.readAppointment(actor.patientId, appointmentId).id, appointmentId);
          assert.equal(
            storage.calendarSnapshot('2035-01-01', '2035-01-07', { staffId: '' }).appointments[0]
              .id,
            appointmentId,
          );
          assert.equal(storage.db.isTransaction, false);
        } finally {
          await admin.query(
            'SELECT pg_advisory_unlock($1::bigint),pg_advisory_unlock($2::bigint)',
            [KEYS.policy, KEYS.writer],
          );
        }
      },
    );
    await t.test(
      'the real overview projection cannot smuggle a write through the read-only port',
      () => {
        assert.throws(
          () => storage.overview(current, () => storage.set('synthetic-readonly-denied', true)),
          (error) => error.code === 'POSTGRES_QUERY_ONLY',
        );
        assert.equal(storage.get('synthetic-readonly-denied', false), false);
        assert.equal(storage.db.isTransaction, false);
        assert.equal(
          storage.readSelected([actor.patientId]).patients.length,
          1,
          'failed read-only callback fully rolls back',
        );
      },
    );
    await t.test(
      'nonempty native patient/calendar decoration works while unrelated writers hold policy locks',
      async () => {
        await admin.query('SELECT pg_advisory_lock($1::bigint),pg_advisory_lock($2::bigint)', [
          KEYS.policy,
          KEYS.writer,
        ]);
        try {
          for (const url of [
            '/api/cabinet/bootstrap?paged=1',
            '/api/cabinet/directory',
            '/api/cabinet/patient?id=' + actor.patientId,
            '/api/cabinet/calendar?from=2035-01-01&to=2035-01-07',
          ]) {
            const result = await read(kernel, actor, url);
            assert.equal(result.status, 200, JSON.stringify({ url, body: result.body }));
            if (url.includes('/patient?'))
              assert.equal(result.body.patients[0].appointments[0].id, appointmentId);
            if (url.includes('/calendar?'))
              assert.equal(result.body.appointments[0].id, appointmentId);
          }
        } finally {
          await admin.query(
            'SELECT pg_advisory_unlock($1::bigint),pg_advisory_unlock($2::bigint)',
            [KEYS.policy, KEYS.writer],
          );
        }
      },
    );
    await t.test(
      'native reads reject a different account context and foreign client without cache mixing',
      async () => {
        const mismatch = await read(kernel, actor, '/api/cabinet/patient?id=' + actor.patientId, {
          cookie: 'cartoteca_v2_session=' + foreign.token,
        });
        assert.equal(mismatch.status, 428);
        assert.equal(mismatch.body.code, 'AUTH_CONTEXT_CHANGED');
        assert.equal(
          (await read(kernel, actor, '/api/cabinet/patient?id=' + foreign.patientId)).status,
          404,
        );
        assert.equal(
          (await read(kernel, foreign, '/api/cabinet/patient?id=' + foreign.patientId)).body
            .patients[0].id,
          foreign.patientId,
        );
        assert.equal(
          (await read(kernel, actor, '/api/cabinet/patient?id=' + actor.patientId)).body.patients[0]
            .id,
          actor.patientId,
        );
      },
    );
    await t.test(
      'session repair remains a critical write outside read-only decoration',
      async () => {
        await admin.query(
          'UPDATE cartoteca_platform.platform_sessions SET organization_id=NULL WHERE _store_id=$1 AND account_id=$2',
          [marker.platformStoreId, actor.accountId],
        );
        const result = await read(kernel, actor, '/api/cabinet/patient?id=' + actor.patientId);
        assert.equal(result.status, 200, JSON.stringify(result.body));
        const repaired = (
          await admin.query(
            'SELECT organization_id FROM cartoteca_platform.platform_sessions WHERE _store_id=$1 AND account_id=$2',
            [marker.platformStoreId, actor.accountId],
          )
        ).rows;
        assert.ok(repaired.every((row) => row.organization_id === actor.organizationId));
        assert.equal(
          Number(
            (
              await admin.query(
                "SELECT count(*) n FROM cartoteca_platform.platform_audit WHERE _store_id=$1 AND actor_id=$2 AND event='organization_selected'",
                [marker.platformStoreId, actor.accountId],
              )
            ).rows[0].n,
          ),
          1,
        );
      },
    );
    await t.test(
      'an expired session is removed and cannot reuse a warm native tenant',
      async () => {
        await admin.query(
          'UPDATE cartoteca_platform.platform_sessions SET expires_at=$1 WHERE _store_id=$2 AND account_id=$3',
          [Date.now() - 1, marker.platformStoreId, foreign.accountId],
        );
        assert.equal(
          (await read(kernel, foreign, '/api/cabinet/patient?id=' + foreign.patientId)).status,
          401,
        );
        assert.equal(
          Number(
            (
              await admin.query(
                'SELECT count(*) n FROM cartoteca_platform.platform_sessions WHERE _store_id=$1 AND account_id=$2',
                [marker.platformStoreId, foreign.accountId],
              )
            ).rows[0].n,
          ),
          0,
        );
      },
    );
    await t.test(
      'fresh membership revocation wins over warmed native patient/calendar responses',
      async () => {
        await admin.query(
          "UPDATE cartoteca_platform.memberships SET status='inactive' WHERE _store_id=$1 AND organization_id=$2 AND account_id=$3",
          [marker.platformStoreId, actor.organizationId, actor.accountId],
        );
        try {
          for (const url of [
            '/api/cabinet/patient?id=' + actor.patientId,
            '/api/cabinet/calendar?from=2035-01-01&to=2035-01-07',
          ])
            assert.equal((await read(kernel, actor, url)).status, 401);
        } finally {
          await admin.query(
            "UPDATE cartoteca_platform.memberships SET status='active' WHERE _store_id=$1 AND organization_id=$2 AND account_id=$3",
            [marker.platformStoreId, actor.organizationId, actor.accountId],
          );
        }
        assert.equal(
          (await read(kernel, actor, '/api/cabinet/patient?id=' + actor.patientId)).status,
          200,
        );
      },
    );
  },
);
