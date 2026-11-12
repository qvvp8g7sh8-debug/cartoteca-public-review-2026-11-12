const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Client } = require('pg');
const { nativeIsolatedFixture } = require('./helpers/native-isolated-fixture.cjs');
const { startPostgresTestRuntime } = require('../scripts/postgres-test-runtime.cjs');
const { migratePostgresData } = require('../src/server/infrastructure/postgres/migration.cjs');
const { nativeSignature } = require('../src/server/infrastructure/postgres/catalog-postgres.cjs');
const {
  validateRoleLeaseSchema,
} = require('../src/server/infrastructure/postgres/process-role-schema.cjs');
const { identifier: quote } = require('../src/server/infrastructure/postgres/catalog-sqlite.cjs');
const { prepareRoleLeases } = require('../scripts/postgres-ops.cjs');
const TABLE = 'cartoteca_catalog.process_role_leases';
const SCHEMAS = ['cartoteca_platform', 'cartoteca_cabinet', 'cartoteca_budget'];
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Independent actual-PG snapshots stay private in memory. Only counts/digests
// leave SQL, never encrypted rows, identity metadata, credentials or source keys.
async function unchangedState(client, applicationRole) {
  const relations = (
    await client.query(
      `SELECT n.nspname,c.relname FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=ANY($1::text[]) AND c.relkind='r'
     ORDER BY n.nspname,c.relname`,
      [SCHEMAS],
    )
  ).rows;
  const business = [];
  for (const row of relations) {
    const value = (
      await client.query(
        `SELECT count(*)::text AS rows,
       md5(coalesce(string_agg(fingerprint,'' ORDER BY fingerprint),'')) AS digest
       FROM (SELECT md5(row_to_json(t)::text) AS fingerprint
       FROM ${quote(row.nspname)}.${quote(row.relname)} t) s`,
      )
    ).rows[0];
    business.push({ schema: row.nspname, table: row.relname, ...value });
  }
  const registry = [];
  for (const name of [
    'stores',
    'asset_profiles',
    'objects',
    'columns',
    'indexes',
    'index_columns',
    'templates',
    'native_objects',
    'native_manifests',
  ]) {
    const value = (
      await client.query(
        `SELECT count(*)::text AS rows,
       md5(coalesce(string_agg(fingerprint,'' ORDER BY fingerprint),'')) AS digest
       FROM (SELECT md5(row_to_json(t)::text) AS fingerprint
       FROM cartoteca_catalog.${quote(name)} t) s`,
      )
    ).rows[0];
    registry.push({ table: name, ...value });
  }
  const signatures = {};
  for (const kind of ['platform', 'cabinet', 'budget'])
    signatures[kind] = hash(await nativeSignature(client, kind));
  const permissions = (
    await client.query(
      `SELECT n.nspname,c.relname,c.relowner::text,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity
     FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','S')
       AND NOT(n.nspname='cartoteca_catalog' AND c.relname='process_role_leases')
     ORDER BY n.nspname,c.relname`,
      [['cartoteca_catalog', ...SCHEMAS]],
    )
  ).rows;
  const policies = (
    await client.query(
      `SELECT schemaname,tablename,policyname,permissive,roles::text,cmd,qual,with_check
     FROM pg_catalog.pg_policies WHERE schemaname=ANY($1::text[])
       AND NOT(schemaname='cartoteca_catalog' AND tablename='process_role_leases')
     ORDER BY schemaname,tablename,policyname`,
      [['cartoteca_catalog', ...SCHEMAS]],
    )
  ).rows;
  const role = (
    await client.query(
      'SELECT rolname,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication FROM pg_catalog.pg_roles WHERE rolname=$1',
      [applicationRole],
    )
  ).rows;
  const memberships = (
    await client.query(
      `SELECT roleid::text,member::text,admin_option FROM pg_catalog.pg_auth_members
     WHERE member=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$1) ORDER BY roleid,member`,
      [applicationRole],
    )
  ).rows;
  return {
    business: hash(business),
    registry: hash(registry),
    signatures: hash(signatures),
    acl: hash({ permissions, policies, role, memberships }),
  };
}
async function exists(client) {
  return (await client.query('SELECT to_regclass($1) IS NOT NULL AS present', [TABLE])).rows[0]
    .present;
}
function verified(result) {
  assert.equal(result.verified, true);
  assert.equal(result.nativeStoreRowsUnchanged, true);
  assert.equal(result.businessSchemaUnchanged, true);
  assert.equal(result.rolesChanged, false);
  assert.equal(result.cutover, false);
}

test(
  'actual offline role preparation rolls back dry-run, preserves stores and ACL, and rejects malformed existing schema',
  { timeout: 120000 },
  async (t) => {
    const fixture = await nativeIsolatedFixture(t, { organizations: 1 });
    const originalClose = fixture.platform.close;
    let sourceClosed = false;
    fixture.platform.close = () => {
      if (!sourceClosed) {
        sourceClosed = true;
        originalClose();
      }
    };
    fixture.platform.close();
    const runtime = await startPostgresTestRuntime();
    const admin = new Client({ ...runtime.admin, query_timeout: 15000, statement_timeout: 12000 });
    let connected = false;
    try {
      await admin.connect();
      connected = true;
      const destination = path.join(runtime.root, 'assets');
      const migration = await migratePostgresData({
        source: fixture.directory,
        destination,
        client: admin,
        applicationRole: runtime.application.user,
        offline: true,
        dryRun: false,
      });
      assert.ok(migration.sourceUnchanged && migration.cutover === false);
      assert.equal(
        await exists(admin),
        true,
        'fresh native migration provisions the technical table',
      );
      await validateRoleLeaseSchema(admin, runtime.application.user);
      assert.equal(
        (await admin.query(`SELECT count(*)::int AS n FROM ${TABLE}`)).rows[0].n,
        0,
        'no application owner or live technical lease is present in this owned fixture',
      );
      const beforeDrop = await unchangedState(admin, runtime.application.user);
      await admin.query(`DROP TABLE ${TABLE}`);
      assert.equal(await exists(admin), false);
      const baseline = await unchangedState(admin, runtime.application.user);
      assert.deepEqual(baseline, beforeDrop);
      const ownerSecret = path.join(runtime.root, 'operator-owner-password');
      const appSecret = path.join(runtime.root, 'operator-app-password');
      fs.writeFileSync(ownerSecret, runtime.admin.password + '\n', { flag: 'wx', mode: 0o600 });
      fs.writeFileSync(appSecret, runtime.application.password + '\n', { flag: 'wx', mode: 0o600 });
      const environment = {
        NODE_ENV: 'production',
        CARTOTECA_STORAGE_BACKEND: 'postgres',
        CARTOTECA_POSTGRES_PROFILE: 'production-v1',
        CARTOTECA_PG_HOST: '127.0.0.1',
        CARTOTECA_PG_ALLOWED_HOSTS: '127.0.0.1',
        CARTOTECA_PG_PORT: String(runtime.admin.port),
        CARTOTECA_PG_DATABASE: runtime.admin.database,
        CARTOTECA_PG_USER: runtime.admin.user,
        CARTOTECA_PG_PASSWORD_FILE: ownerSecret,
        CARTOTECA_PG_APPLICATION_PASSWORD_FILE: appSecret,
        BACKUP_POSTGRES_APPLICATION_ROLE: runtime.application.user,
        CARTOTECA_DATA_DIR: destination,
      };
      // Only private connection discovery is injected. Client construction, login,
      // role verification, native DDL/validation, locks and COMMIT/ROLLBACK are real.
      const dependencies = { connect: async () => ({ ...runtime.admin }) };
      await t.test(
        'dry-run creates and validates within the transaction, then actually rolls DDL back',
        async () => {
          const result = await prepareRoleLeases(
            ['--offline', '--dry-run'],
            environment,
            dependencies,
          );
          verified(result);
          assert.equal(result.dryRun, true);
          assert.equal(result.rolledBack, true);
          assert.equal(result.prepared, false);
          assert.equal(result.created, false);
          assert.equal(result.wouldCreate, true);
          assert.equal(
            await exists(admin),
            false,
            'rolled-back relation must be absent in an independent connection',
          );
          assert.deepEqual(await unchangedState(admin, runtime.application.user), baseline);
        },
      );
      await t.test(
        'apply creates valid native technical schema with every store, row and ACL unchanged',
        async () => {
          const result = await prepareRoleLeases(
            ['--offline', '--apply'],
            environment,
            dependencies,
          );
          verified(result);
          assert.equal(result.dryRun, false);
          assert.equal(result.rolledBack, false);
          assert.equal(result.prepared, true);
          assert.equal(result.created, true);
          assert.equal(result.wouldCreate, true);
          assert.equal(await exists(admin), true);
          await validateRoleLeaseSchema(admin, runtime.application.user);
          assert.deepEqual(await unchangedState(admin, runtime.application.user), baseline);
        },
      );
      await t.test(
        'reapply validates the existing exact schema without recreating it',
        async () => {
          const oid = (await admin.query('SELECT to_regclass($1)::oid AS oid', [TABLE])).rows[0]
            .oid;
          const result = await prepareRoleLeases(
            ['--offline', '--apply'],
            environment,
            dependencies,
          );
          verified(result);
          assert.equal(result.prepared, true);
          assert.equal(result.created, false);
          assert.equal(result.wouldCreate, false);
          assert.equal(
            (await admin.query('SELECT to_regclass($1)::oid AS oid', [TABLE])).rows[0].oid,
            oid,
          );
          assert.deepEqual(await unchangedState(admin, runtime.application.user), baseline);
        },
      );
      await t.test(
        'a malformed existing table is rejected and left intact rather than silently repaired',
        async () => {
          await admin.query(`ALTER TABLE ${TABLE} ADD COLUMN unexpected_fixture_column TEXT`);
          await assert.rejects(
            prepareRoleLeases(['--offline', '--apply'], environment, dependencies),
            (error) => error?.code === 'POSTGRES_ROLE_SCHEMA_INVALID',
          );
          assert.equal(
            (
              await admin.query(
                "SELECT count(*)::int AS n FROM pg_catalog.pg_attribute WHERE attrelid=to_regclass($1) AND attname='unexpected_fixture_column' AND NOT attisdropped",
                [TABLE],
              )
            ).rows[0].n,
            1,
          );
          await assert.rejects(
            validateRoleLeaseSchema(admin, runtime.application.user),
            (error) => error?.code === 'POSTGRES_ROLE_SCHEMA_INVALID',
          );
          assert.deepEqual(await unchangedState(admin, runtime.application.user), baseline);
        },
      );
    } finally {
      const closed = await Promise.allSettled(connected ? [admin.end()] : []);
      await runtime.close();
      assert.ok(
        closed.every((result) => result.status === 'fulfilled'),
        'all owned operator resources close',
      );
    }
  },
);
