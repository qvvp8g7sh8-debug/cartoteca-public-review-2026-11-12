const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { nativeIsolatedFixture } = require('./native-isolated-fixture.cjs');
const { startPostgresTestRuntime } = require('../../scripts/postgres-test-runtime.cjs');
const { migratePostgresData } = require('../../src/server/infrastructure/postgres/migration.cjs');
const {
  prepareCompoundProfile,
} = require('../../src/server/infrastructure/postgres/revision-operator133.cjs');
const {
  createPostgresCoordinator,
} = require('../../src/server/infrastructure/postgres/coordinator.cjs');
const { KEYS } = require('../../src/server/infrastructure/postgres/lock-intents.cjs');
const {
  identifier: q,
  digest,
} = require('../../src/server/infrastructure/postgres/catalog-sqlite.cjs');
async function postgresRevisionFixture(t, { prepareSource } = {}) {
  const fixture = await nativeIsolatedFixture(t, { organizations: 2 });
  if (prepareSource) await prepareSource(fixture);
  const original = fixture.platform.close;
  let closed = false;
  fixture.platform.close = () => {
    if (!closed) {
      closed = true;
      original();
    }
  };
  fixture.platform.close();
  const runtime = await startPostgresTestRuntime();
  const admin = new Client(runtime.admin),
    app = new Client(runtime.application);
  await admin.connect();
  await app.connect();
  const owners = new Set();
  t.after(async () => {
    for (const owner of owners) await owner.close();
    await app.end();
    await admin.end();
    await runtime.close();
  });
  const assets = path.join(runtime.root, 'assets');
  await migratePostgresData({
    source: fixture.directory,
    destination: assets,
    client: admin,
    applicationRole: runtime.application.user,
    offline: true,
    dryRun: false,
  });
  const profile = JSON.parse(fs.readFileSync(path.join(assets, 'postgresql-runtime.json'), 'utf8'));
  const scope = { kind: 'platform', storeId: profile.platformStoreId };
  async function setScope(client, input = scope) {
    await client.query(
      "SELECT set_config('cartoteca.kind',$1,false),set_config('cartoteca.store_id',$2,false)",
      [input.kind, input.storeId],
    );
  }
  await setScope(app);
  async function change(target = 3, dry = false) {
    await admin.query('BEGIN');
    try {
      await admin.query('SELECT pg_advisory_xact_lock($1::bigint)', [KEYS.maintenance]);
      const result = await prepareCompoundProfile(admin, runtime.application.user, { target });
      await admin.query(dry ? 'ROLLBACK' : 'COMMIT');
      return result;
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
  }
  async function owner(version = 3) {
    const instance = createPostgresCoordinator({
      connection: runtime.application,
      allowBlocking: true,
      revisionProfile: version,
    });
    owners.add(instance);
    await instance.ready();
    instance.verifyProfile({
      platformStoreId: profile.platformStoreId,
      migrationId: profile.migrationId,
      markerHash: digest(profile),
      lineage: profile,
    });
    return {
      owner: instance,
      db: instance.open(scope),
      close: async () => {
        await instance.close();
        owners.delete(instance);
      },
    };
  }
  return { fixture, runtime, admin, app, assets, profile, scope, setScope, change, owner };
}
async function immutableRows(client) {
  const names = (
    await client.query(
      "SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('cartoteca_platform','cartoteca_cabinet','cartoteca_budget') AND c.relkind='r' ORDER BY 1,2",
    )
  ).rows;
  const result = [];
  for (const row of names)
    result.push(
      (
        await client.query(
          `SELECT count(*)::text AS n,md5(coalesce(string_agg(h,'' ORDER BY h),'')) AS digest FROM(SELECT md5(row_to_json(t)::text) AS h FROM ${q(row.nspname)}.${q(row.relname)} t)s`,
        )
      ).rows[0],
    );
  return result;
}
module.exports = { postgresRevisionFixture, immutableRows };
