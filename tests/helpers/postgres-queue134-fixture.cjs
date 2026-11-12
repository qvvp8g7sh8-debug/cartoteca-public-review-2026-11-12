const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { startPostgresTestRuntime } = require('../../scripts/postgres-test-runtime.cjs');
const {
  canonicalSqliteSchema,
} = require('../../src/server/infrastructure/postgres/catalog-canonical.cjs');
const {
  preparePostgresSchema,
} = require('../../src/server/infrastructure/postgres/schema-prepare.cjs');
const {
  prepareCompoundProfile,
} = require('../../src/server/infrastructure/postgres/revision-operator133.cjs');
const {
  createPostgresCoordinator,
} = require('../../src/server/infrastructure/postgres/coordinator.cjs');
const { createTransport } = require('../../src/server/infrastructure/postgres/transport.cjs');
const { digest } = require('../../src/server/infrastructure/postgres/catalog-sqlite.cjs');
const { KEYS } = require('../../src/server/infrastructure/postgres/lock-intents.cjs');
async function queueFixture(
  t,
  { cabinetVersion = 2, components = {}, cabinetComponents = {} } = {},
) {
  if (![1, 2].includes(cabinetVersion)) throw Error('Unsupported synthetic cabinet version.');
  const runtime = await startPostgresTestRuntime(),
    admin = new Client(runtime.admin),
    owners = [],
    raws = [];
  const platform = { kind: 'platform', storeId: randomUUID() },
    organizations = [randomUUID(), randomUUID()];
  const cabinets = organizations.map((organizationId) => ({
    kind: 'cabinet',
    storeId: randomUUID(),
    organizationId,
  }));
  const catalog = canonicalSqliteSchema({ kind: 'platform', version: 19, components }),
    cabinetCatalog = canonicalSqliteSchema({
      kind: 'cabinet',
      version: cabinetVersion,
      components: cabinetComponents,
    });
  const lineage = {
    version: 1,
    backend: 'postgres',
    migrationId: randomUUID(),
    platformStoreId: platform.storeId,
    rootCabinetStoreId: cabinets[0].storeId,
    budgetStoreId: null,
    notificationSchema: 19,
    cabinetSchema: cabinetVersion,
    cabinetTemplates: {
      1: digest(
        canonicalSqliteSchema({
          kind: 'cabinet',
          version: 1,
          components: cabinetVersion === 1 ? cabinetComponents : {},
        }),
      ),
      2: digest(
        canonicalSqliteSchema({
          kind: 'cabinet',
          version: 2,
          components: cabinetVersion === 2 ? cabinetComponents : {},
        }),
      ),
    },
    stores: [
      { ...platform, organizationId: null, relativeDirectory: 'platform', schemaVersion: 19 },
      ...cabinets.map((s, i) => ({
        ...s,
        relativeDirectory: i ? 'tenants/' + s.organizationId : '.',
        schemaVersion: cabinetVersion,
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
        owner.closeSync();
        await owner.close();
      }
      for (const raw of raws) await raw.close();
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
      source: catalog,
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
      "INSERT INTO cartoteca_catalog.asset_profiles(kind,store_id,migration_id,marker_hash)VALUES('platform',$1,$2,$3)",
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
    return { owner, p: owner.open(platform), c: cabinets.map((s) => owner.open(s)) };
  }
  async function raw() {
    const transport = createTransport({ connection: runtime.application });
    raws.push(transport);
    await transport.ready();
    transport.request({
      op: 'verifyProfile',
      scope: platform,
      migrationId: identity.migrationId,
      markerHash: identity.markerHash,
      lineage,
    });
    transport.request({ op: 'inspect', scope: platform, revisionProfile: 3 });
    for (const scope of cabinets) transport.request({ op: 'inspect', scope, revisionProfile: 3 });
    return transport;
  }
  const a = await open();
  for (let i = 0; i < 2; i++)
    a.p
      .prepare('INSERT INTO organizations(id,value,slug,created_at) VALUES(?,?,?,?)')
      .run(organizations[i], Buffer.from('synthetic'), 'queue-org-' + i, 1);
  return {
    runtime,
    admin,
    platform,
    organizations,
    cabinets,
    catalog,
    cabinetCatalog,
    identity,
    open,
    raw,
    a,
  };
}
module.exports = { queueFixture };
