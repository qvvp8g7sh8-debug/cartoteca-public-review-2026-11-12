const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { startPostgresTestRuntime } = require('../scripts/postgres-test-runtime.cjs');
const {
  canonicalSqliteSchema,
} = require('../src/server/infrastructure/postgres/catalog-canonical.cjs');
const {
  preparePostgresSchema,
} = require('../src/server/infrastructure/postgres/schema-prepare.cjs');
const {
  prepareCompoundProfile,
} = require('../src/server/infrastructure/postgres/revision-operator133.cjs');
const {
  createPostgresCoordinator,
} = require('../src/server/infrastructure/postgres/coordinator.cjs');
const { createTransport } = require('../src/server/infrastructure/postgres/transport.cjs');
const { compile } = require('../src/server/infrastructure/postgres/dialect.cjs');
const { digest } = require('../src/server/infrastructure/postgres/catalog-sqlite.cjs');
const { KEYS } = require('../src/server/infrastructure/postgres/lock-intents.cjs');
const writes = require('../src/server/infrastructure/postgres/compound-sql133.cjs');
const dirty =
  "INSERT INTO notification_schedule_dirty(kind,organization_id,subject) VALUES(?,?,?) ON CONFLICT(kind,organization_id,subject) DO UPDATE SET version=version+1,cursor=''";
const push = writes.find((entry) => entry.sql.startsWith('INSERT INTO staff_push_jobs')).sql;
const busyBefore = (error) =>
  error.code === 'ERR_SQLITE_ERROR' &&
  error.postgresCode === 'POSTGRES_BUSY' &&
  error.retryableBeforeBegin === true &&
  error.transactionOpen === false &&
  !error.outcomeUnknown &&
  !error.channelPoisoned;

test(
  'native compound transactions preserve atomic effects and permit different organizations to commit concurrently',
  { timeout: 120000 },
  async (t) => {
    const runtime = await startPostgresTestRuntime(),
      admin = new Client(runtime.admin),
      owners = [],
      transports = [];
    const platform = { kind: 'platform', storeId: randomUUID() };
    const organizations = [randomUUID(), randomUUID()],
      accounts = [randomUUID(), randomUUID()];
    const cabinets = organizations.map((organizationId) => ({
      kind: 'cabinet',
      storeId: randomUUID(),
      organizationId,
    }));
    const platformCatalog = canonicalSqliteSchema({ kind: 'platform', version: 19 }),
      cabinetCatalog = canonicalSqliteSchema({ kind: 'cabinet', version: 2 });
    const lineage = {
      version: 1,
      backend: 'postgres',
      migrationId: randomUUID(),
      platformStoreId: platform.storeId,
      rootCabinetStoreId: cabinets[0].storeId,
      budgetStoreId: null,
      notificationSchema: 19,
      cabinetSchema: 2,
      cabinetTemplates: {
        1: digest(canonicalSqliteSchema({ kind: 'cabinet', version: 1 })),
        2: digest(cabinetCatalog),
      },
      stores: [
        { ...platform, organizationId: null, relativeDirectory: 'platform', schemaVersion: 19 },
        ...cabinets.map((scope, i) => ({
          ...scope,
          relativeDirectory: i ? 'tenants/' + scope.organizationId : '.',
          schemaVersion: 2,
        })),
      ],
    };
    const identity = {
      platformStoreId: platform.storeId,
      migrationId: lineage.migrationId,
      markerHash: digest(lineage),
      lineage,
    };
    t.after(async () => {
      try {
        for (const owner of owners) {
          try {
            owner.closeSync();
          } catch {}
          await owner.close();
        }
        for (const raw of transports) await raw.close();
      } finally {
        try {
          await admin.end();
        } finally {
          await runtime.close();
        }
      }
    });
    await admin.connect();
    await admin.query('BEGIN');
    try {
      await preparePostgresSchema(admin, {
        ...platform,
        source: platformCatalog,
        applicationRole: runtime.application.user,
      });
      for (const cabinet of cabinets)
        await preparePostgresSchema(admin, {
          ...cabinet,
          source: cabinetCatalog,
          applicationRole: runtime.application.user,
        });
      await admin.query('SELECT pg_advisory_xact_lock($1::bigint)', [KEYS.maintenance]);
      await prepareCompoundProfile(admin, runtime.application.user);
      await admin.query(
        "INSERT INTO cartoteca_catalog.asset_profiles(kind,store_id,migration_id,marker_hash) VALUES('platform',$1,$2,$3)",
        [platform.storeId, lineage.migrationId, identity.markerHash],
      );
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
    async function open() {
      const owner = createPostgresCoordinator({
        connection: runtime.application,
        allowBlocking: true,
        revisionProfile: 3,
      });
      owners.push(owner);
      await owner.ready();
      owner.verifyProfile(identity);
      return { owner, p: owner.open(platform), c: cabinets.map((scope) => owner.open(scope)) };
    }
    const a = await open(),
      b = await open();
    for (let i = 0; i < 2; i++) {
      a.p
        .prepare('INSERT INTO organizations(id,value,slug,created_at) VALUES(?,?,?,?)')
        .run(organizations[i], Buffer.from('synthetic'), 'synthetic-' + i, 1);
      a.p
        .prepare('INSERT INTO accounts(id,email_hash,value,created_at) VALUES(?,?,?,?)')
        .run(accounts[i], 'synthetic-' + i, Buffer.from('synthetic'), 1);
    }
    const capability = (i, operation = 'cabinet') => ({
      operation,
      organizationId: organizations[i],
      cabinetStoreId: cabinets[i].storeId,
    });
    function put(owner, i, key) {
      owner.p.prepare(dirty).run('client', organizations[i], key);
      owner.p
        .prepare(push)
        .run(
          randomUUID(),
          organizations[i],
          accounts[i],
          'device-' + i,
          key,
          Buffer.from('synthetic'),
          1,
          100000,
          0,
        );
      owner.c[i].exec('BEGIN IMMEDIATE');
      owner.c[i]
        .prepare('INSERT INTO meta(key,value) VALUES(?,?)')
        .run(key, Buffer.from('synthetic'));
      owner.c[i].exec('COMMIT');
    }
    await t.test(
      'second organization commits platform business, push and cabinet while first transaction remains open',
      () => {
        a.p.beginCompound(capability(0));
        put(a, 0, 'parallel-first');
        b.p.beginCompound(capability(1));
        put(b, 1, 'parallel-second');
        b.p.exec('COMMIT');
        assert.equal(a.p.isTransaction, true);
        assert.ok(b.c[1].prepare('SELECT value FROM meta WHERE key=?').get('parallel-second'));
        a.p.exec('COMMIT');
        assert.equal(b.p.prepare('SELECT COUNT(*) count FROM staff_push_jobs').get().count, 2);
      },
    );
    await t.test(
      'outer rollback removes cabinet savepoint, dirty projection and queue effects together',
      () => {
        a.p.beginCompound(capability(0));
        put(a, 0, 'atomic-rollback');
        a.p.exec('ROLLBACK');
        assert.equal(
          b.c[0].prepare('SELECT value FROM meta WHERE key=?').get('atomic-rollback'),
          undefined,
        );
        assert.equal(
          b.p
            .prepare(
              'SELECT 1 FROM notification_schedule_dirty WHERE organization_id=? AND subject=?',
            )
            .get(organizations[0], 'atomic-rollback'),
          undefined,
        );
        assert.equal(
          b.p.prepare('SELECT 1 FROM staff_push_jobs WHERE event_key=?').get('atomic-rollback'),
          undefined,
        );
      },
    );
    await t.test(
      'same organization, legacy critical writer and related queue are refused before BEGIN',
      () => {
        a.p.beginCompound(capability(0));
        assert.throws(() => b.p.beginCompound(capability(0)), busyBefore);
        assert.throws(() => b.p.exec('BEGIN IMMEDIATE'), busyBefore);
        assert.throws(() => b.p.exec('BEGIN QUEUE'), busyBefore);
        assert.throws(() => b.p.beginQueue('push'), busyBefore);
        b.p.beginQueue('max-inbox');
        b.p.exec('ROLLBACK');
        a.p.exec('ROLLBACK');
        b.p.beginCompound(capability(0));
        b.p.exec('ROLLBACK');
      },
    );
    await t.test(
      'cabinet identity, foreign organization writes, functions and upgrades fail closed',
      () => {
        assert.throws(
          () => a.p.beginCompound({ ...capability(0), cabinetStoreId: cabinets[1].storeId }),
          { code: 'POSTGRES_ASSET_LINEAGE_MISMATCH' },
        );
        a.p.beginCompound(capability(0));
        assert.throws(() => a.p.prepare(dirty).run('client', organizations[1], 'foreign'));
        assert.throws(() => a.c[1].prepare('SELECT value FROM meta').all(), {
          code: 'POSTGRES_COMPOUND_SCOPE_INVALID',
        });
        assert.throws(() => a.p.beginQueue('push'));
        assert.throws(() =>
          a.p
            .prepare('UPDATE accounts SET value=? WHERE id=?')
            .run(Buffer.from('synthetic'), accounts[0]),
        );
        a.p.exec('ROLLBACK');
      },
    );
    await t.test(
      'marker-backed legacy root and new organization provisioning retain their correct identity',
      () => {
        const organizationId = randomUUID();
        a.p
          .prepare('INSERT INTO organizations(id,value,slug,created_at) VALUES(?,?,?,?)')
          .run(organizationId, Buffer.from('synthetic'), 'new-synthetic', 1);
        const c = a.owner.open({
          kind: 'cabinet',
          storeId: organizationId,
          organizationId,
          schemaVersion: 2,
          allowCreate: true,
          catalogHash: digest(cabinetCatalog),
          platformStoreId: platform.storeId,
        });
        a.p.beginCompound({ operation: 'cabinet', organizationId, cabinetStoreId: organizationId });
        c.exec('BEGIN IMMEDIATE');
        c.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(
          'new-tenant',
          Buffer.from('synthetic'),
        );
        c.exec('COMMIT');
        a.p.exec('COMMIT');
        assert.ok(c.prepare('SELECT value FROM meta WHERE key=?').get('new-tenant'));
        const missing = randomUUID();
        assert.throws(
          () =>
            a.owner.open({
              kind: 'cabinet',
              storeId: missing,
              organizationId: missing,
              schemaVersion: 2,
              allowCreate: true,
              catalogHash: digest(cabinetCatalog),
              platformStoreId: platform.storeId,
            }),
          { code: 'POSTGRES_ASSET_LINEAGE_MISMATCH' },
        );
      },
    );
    await t.test(
      'full 16MiB startup marker fits the existing transport limit without changing request budgets',
      async () => {
        const marker = {
          ...lineage,
          stores: lineage.stores.map((row) =>
            row.storeId === cabinets[0].storeId ? { ...row, organizationId: null } : row,
          ),
          padding: '',
        };
        marker.padding = 'x'.repeat(16 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(marker)));
        assert.equal(Buffer.byteLength(JSON.stringify(marker)), 16 * 1024 * 1024);
        const markerHash = digest(marker);
        const raw = createTransport({ connection: runtime.application });
        transports.push(raw);
        await raw.ready();
        await admin.query(
          "UPDATE cartoteca_catalog.asset_profiles SET marker_hash=$1 WHERE kind='platform' AND store_id=$2",
          [markerHash, platform.storeId],
        );
        try {
          assert.equal(
            raw.request({
              op: 'verifyProfile',
              scope: platform,
              migrationId: identity.migrationId,
              markerHash,
              lineage: marker,
            }),
            true,
          );
          raw.request({ op: 'inspect', scope: platform, revisionProfile: 3 });
          raw.request({
            op: 'inspect',
            scope: { kind: 'cabinet', storeId: cabinets[0].storeId },
            revisionProfile: 3,
          });
          assert.throws(
            () =>
              raw.request({
                op: 'begin',
                scope: platform,
                mode: 'COMPOUND',
                compound: capability(0),
              }),
            { code: 'POSTGRES_ASSET_LINEAGE_MISMATCH' },
          );
        } finally {
          await admin.query(
            "UPDATE cartoteca_catalog.asset_profiles SET marker_hash=$1 WHERE kind='platform' AND store_id=$2",
            [identity.markerHash, platform.storeId],
          );
        }
      },
    );
    await t.test(
      'policy revocation and offline maintenance fences still exclude compound admission',
      async () => {
        for (const key of [KEYS.policy, KEYS.maintenance]) {
          await admin.query('SELECT pg_advisory_lock($1::bigint)', [key]);
          try {
            assert.throws(() => a.p.beginCompound(capability(0)), busyBefore);
          } finally {
            await admin.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
          }
        }
      },
    );
    await t.test(
      'native worker independently rejects forged scopes and SQL without trusting coordinator',
      async () => {
        const raw = createTransport({ connection: runtime.application });
        transports.push(raw);
        await raw.ready();
        raw.request({
          op: 'verifyProfile',
          scope: platform,
          migrationId: identity.migrationId,
          markerHash: identity.markerHash,
          lineage,
        });
        raw.request({ op: 'inspect', scope: platform, revisionProfile: 3 });
        assert.throws(
          () =>
            raw.request({
              op: 'inspect',
              scope: { ...cabinets[1], organizationId: organizations[0] },
              revisionProfile: 3,
            }),
          { code: 'POSTGRES_ASSET_LINEAGE_MISMATCH' },
        );
        for (const scope of cabinets) raw.request({ op: 'inspect', scope, revisionProfile: 3 });
        assert.throws(
          () =>
            raw.request({
              op: 'begin',
              scope: platform,
              mode: 'COMPOUND',
              compound: { ...capability(0), cabinetStoreId: cabinets[1].storeId },
            }),
          { code: 'POSTGRES_ASSET_LINEAGE_MISMATCH' },
        );
        raw.request({ op: 'begin', scope: platform, mode: 'COMPOUND', compound: capability(0) });
        const foreign = compile(
          dirty,
          platform,
          ['client', organizations[1], 'raw-foreign'],
          'run',
          platformCatalog,
        );
        assert.throws(() =>
          raw.request({
            op: 'execute',
            scope: platform,
            plan: foreign,
            method: 'run',
            mutating: true,
          }),
        );
        assert.throws(
          () =>
            raw.request({
              op: 'execute',
              scope: cabinets[1],
              plan: { text: 'SELECT 1', values: [], effect: 'read' },
              method: 'all',
            }),
          { code: 'POSTGRES_COMPOUND_SCOPE_INVALID' },
        );
        assert.throws(() =>
          raw.request({
            op: 'execute',
            scope: platform,
            plan: { text: 'SELECT pg_catalog.pg_sleep(1)', values: [], effect: 'read' },
            method: 'all',
          }),
        );
        const allowed = compile(
          dirty,
          platform,
          ['client', organizations[0], 'raw-safe'],
          'run',
          platformCatalog,
        );
        raw.request({
          op: 'execute',
          scope: platform,
          plan: allowed,
          method: 'run',
          mutating: true,
        });
        raw.request({ op: 'rollback', scope: platform });
        assert.equal(raw.stats().poisoned, false);
      },
    );
  },
);
