const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { Client } = require('pg');
const { startPostgresTestRuntime } = require('../scripts/postgres-test-runtime.cjs');
const {
  canonicalSqliteSchema,
  canonicalCabinetTemplateHashes,
} = require('../src/server/infrastructure/postgres/catalog-canonical.cjs');
const {
  preparePostgresSchema,
} = require('../src/server/infrastructure/postgres/schema-prepare.cjs');
const {
  registerAssetProfile,
} = require('../src/server/infrastructure/postgres/catalog-postgres.cjs');
const {
  prepareCompoundProfile,
} = require('../src/server/infrastructure/postgres/revision-operator133.cjs');
const { digest } = require('../src/server/infrastructure/postgres/catalog-sqlite.cjs');
const { initializePostgresOwner } = require('../src/server/infrastructure/postgres/initialize.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { createPlatformStore } = require('../src/server/application/platform.cjs');
const { validate } = require('../src/server/infrastructure/notification-maintenance-schema.cjs');
const {
  prepareNotificationMaintenance,
} = require('../work/scaling-20261024-136/notification-maintenance136.cjs');
const registration = 'notification_queue_maintenance_schema';
async function fixture(t) {
  const runtime = await startPostgresTestRuntime(),
    admin = new Client(runtime.admin);
  let owner, db, platform;
  t.after(async () => {
    platform?.close();
    db?.db.close();
    await owner?.close();
    await admin.end();
    await runtime.close();
  });
  await admin.connect();
  const directory = path.join(runtime.root, 'assets'),
    platformStoreId = randomUUID(),
    rootId = randomUUID(),
    org = randomUUID();
  fs.mkdirSync(path.join(directory, 'platform'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'platform/platform.key'), randomBytes(32));
  const source = canonicalSqliteSchema({ kind: 'platform', version: 19 });
  const profile = {
    version: 1,
    backend: 'postgres',
    migrationId: randomUUID(),
    platformStoreId,
    rootCabinetStoreId: rootId,
    budgetStoreId: null,
    cabinetTemplates: canonicalCabinetTemplateHashes(),
    notificationSchema: 19,
    cabinetSchema: 2,
    stores: [
      {
        kind: 'platform',
        storeId: platformStoreId,
        organizationId: null,
        relativeDirectory: 'platform',
        schemaVersion: 19,
      },
      {
        kind: 'cabinet',
        storeId: rootId,
        organizationId: null,
        relativeDirectory: '.',
        schemaVersion: 2,
      },
      {
        kind: 'cabinet',
        storeId: org,
        organizationId: org,
        relativeDirectory: 'tenants/' + org,
        schemaVersion: 2,
      },
    ],
  };
  await admin.query('BEGIN');
  try {
    await preparePostgresSchema(admin, {
      kind: 'platform',
      storeId: platformStoreId,
      source,
      applicationRole: runtime.application.user,
    });
    for (const id of [rootId, org])
      await preparePostgresSchema(admin, {
        kind: 'cabinet',
        storeId: id,
        source: canonicalSqliteSchema({ kind: 'cabinet', version: 2 }),
        applicationRole: runtime.application.user,
      });
    await registerAssetProfile(admin, profile);
    await prepareCompoundProfile(admin, runtime.application.user);
    await admin.query(
      "INSERT INTO cartoteca_platform.platform_audit(_store_id,time,event,detail) VALUES($1,1,'synthetic-maintenance136','{}')",
      [platformStoreId],
    );
    await admin.query(
      "INSERT INTO cartoteca_platform.telegram_runtime(_store_id,key,value) VALUES($1,'synthetic-maintenance136',$2)",
      [platformStoreId, Buffer.from('unchanged-synthetic-state')],
    );
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
  const marker = Buffer.from(JSON.stringify(profile));
  fs.writeFileSync(path.join(directory, 'postgresql-runtime.json'), marker);
  const markerHash = createHash('sha256').update(marker).digest('hex');
  const options = {
    applicationRole: runtime.application.user,
    profile,
    expectedStoreCount: 3,
    expectedCatalogHash: digest(source),
  };
  async function snapshot() {
    const result = {};
    for (const table of [
      'stores',
      'objects',
      'columns',
      'indexes',
      'index_columns',
      'templates',
      'native_objects',
      'native_manifests',
      'asset_profiles',
      'revision_state',
    ])
      result[table] = (
        await admin.query(
          `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) value FROM cartoteca_catalog.${table} t`,
        )
      ).rows[0].value;
    result.audit = (
      await admin.query('SELECT * FROM cartoteca_platform.platform_audit ORDER BY id')
    ).rows;
    result.runtime = (
      await admin.query('SELECT * FROM cartoteca_platform.telegram_runtime ORDER BY key')
    ).rows;
    return digest(result);
  }
  async function open() {
    const initialized = await initializePostgresOwner({
      dataDir: directory,
      storageBackend: 'postgres',
      postgres: runtime.application,
      notificationSchema: 19,
      processRole: 'command',
    });
    owner = initialized.databaseOwner;
    db = createPlatformDatabase(path.join(directory, 'platform'), {
      notificationSchema: 19,
      databaseOwner: owner,
      sharedCabinetWrites: true,
    });
    return initialized;
  }
  async function close() {
    db?.db.close();
    db = null;
    await owner?.close();
    owner = null;
  }
  return {
    runtime,
    admin,
    profile,
    directory,
    source,
    options,
    snapshot,
    open,
    close,
    setPlatform(value) {
      platform = value;
    },
    get db() {
      return db;
    },
    markerHash,
  };
}
test(
  'offline optional maintenance is add-only and atomic on the same PostgreSQL profile3',
  { timeout: 180000 },
  async (t) => {
    const f = await fixture(t),
      before = await f.snapshot();
    await f.open();
    assert.throws(() => validate(f.db.db, { required: true }), /component schema mismatch/);
    await f.close();
    const dry = await prepareNotificationMaintenance(f.admin, { ...f.options, dryRun: true });
    assert.equal(dry.rolledBack, true);
    assert.equal(dry.prepared, false);
    assert.equal(dry.indexesAdded, 14);
    assert.equal(
      await f.snapshot(),
      before,
      'dry run rolls back physical objects, templates and metadata',
    );
    assert.equal(
      (
        await f.admin.query(
          "SELECT to_regclass('cartoteca_platform.notification_queue_maintenance_schema') value",
        )
      ).rows[0].value,
      null,
    );
    let injected = 0;
    const failing = {
      query(sql, values) {
        if (sql.startsWith('INSERT INTO cartoteca_catalog."columns"')) {
          injected++;
          throw Object.assign(Error('Synthetic late preparation failure'), {
            code: 'SYNTHETIC_LATE_FAILURE',
          });
        }
        return f.admin.query(sql, values);
      },
    };
    await assert.rejects(prepareNotificationMaintenance(failing, { ...f.options, dryRun: false }), {
      code: 'SYNTHETIC_LATE_FAILURE',
    });
    assert.equal(injected, 1);
    assert.equal(
      await f.snapshot(),
      before,
      'SQL failure after native DDL and compatibility effects rolls back everything',
    );
    const guardian = new Client(f.runtime.admin);
    await guardian.connect();
    const { advisoryKey } = require('../src/server/infrastructure/postgres/lock-intents.cjs');
    const lock = advisoryKey('cartoteca:postgres-server:v1:' + f.profile.platformStoreId);
    await guardian.query('SELECT pg_advisory_lock($1::bigint)', [lock]);
    try {
      await assert.rejects(
        prepareNotificationMaintenance(f.admin, { ...f.options, dryRun: false }),
        { reason: 'runtime-active' },
      );
    } finally {
      await guardian.query('SELECT pg_advisory_unlock($1::bigint)', [lock]);
      await guardian.end();
    }
    assert.equal(await f.snapshot(), before);
    const applied = await prepareNotificationMaintenance(f.admin, { ...f.options, dryRun: false });
    assert.equal(applied.prepared, true);
    assert.equal(applied.revisionProfile, 3);
    for (const field of [
      'otherStoresUnchanged',
      'businessRowsUnchanged',
      'existingNativeDefinitionsUnchanged',
      'rolesAndExistingRightsUnchanged',
      'assetLineageUnchanged',
      'catalogRevisionUnchanged',
    ])
      assert.equal(applied[field], true, field);
    assert.equal(
      createHash('sha256')
        .update(fs.readFileSync(path.join(f.directory, 'postgresql-runtime.json')))
        .digest('hex'),
      f.markerHash,
    );
    const initialized = await f.open();
    assert.deepEqual(validate(f.db.db, { required: true }), { version: 1 });
    assert.equal(f.db.db.revisionProfile, 3);
    const platform = createPlatformStore(path.join(f.directory, 'platform'), {
      ...initialized,
      notificationSchema: 19,
      sharedCabinetWrites: true,
      notificationMaintenanceEnabled: true,
      scheduledNotifications: true,
      scheduleStartupReconcile: false,
      assistantComposition: false,
      administrationComposition: false,
    });
    f.setPlatform(platform);
    assert.equal(
      platform.notificationMaintenance.enabled,
      true,
      'the actual configured maintenance constructor now starts',
    );
    assert.equal(f.db.db.prepare('SELECT count(*) n FROM platform_audit').get().n, 1);
    assert.equal(
      f.db.db
        .prepare('SELECT value FROM telegram_runtime WHERE key=?')
        .get('synthetic-maintenance136')
        .value.toString(),
      'unchanged-synthetic-state',
    );
    await assert.rejects(
      prepareNotificationMaintenance(f.admin, {
        ...f.options,
        expectedCatalogHash: applied.catalogHash,
        dryRun: false,
      }),
      { reason: 'component-already-present' },
    );
  },
);
test(
  'lost optional-component COMMIT acknowledgement never rolls back or replays a committed preparation',
  { timeout: 180000 },
  async (t) => {
    const f = await fixture(t),
      calls = [];
    const uncertain = {
      async query(sql, values) {
        calls.push(sql);
        const result = await f.admin.query(sql, values);
        if (sql === 'COMMIT')
          throw Object.assign(Error('Synthetic lost acknowledgement'), { code: 'ECONNRESET' });
        return result;
      },
    };
    await assert.rejects(
      prepareNotificationMaintenance(uncertain, { ...f.options, dryRun: false }),
      { code: 'POSTGRES_NOTIFICATION_MAINTENANCE_COMMIT_UNKNOWN', outcomeUnknown: true },
    );
    assert.equal(calls.filter((sql) => sql === 'COMMIT').length, 1);
    assert.equal(calls.filter((sql) => sql === 'ROLLBACK').length, 0);
    const rows = (
      await f.admin.query(
        `SELECT id::integer,version::integer FROM cartoteca_platform.${registration} WHERE _store_id=$1`,
        [f.profile.platformStoreId],
      )
    ).rows;
    assert.deepEqual(
      rows,
      [{ id: 1, version: 1 }],
      'actual committed effects remain for explicit reconciliation',
    );
    await f.open();
    assert.deepEqual(validate(f.db.db, { required: true }), { version: 1 });
  },
);
