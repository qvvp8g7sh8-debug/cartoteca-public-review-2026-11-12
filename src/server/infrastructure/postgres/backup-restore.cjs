const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { canonicalSqliteSchema } = require('./catalog-canonical.cjs');
const { preparePostgresSchema, registerCanonicalTemplate } = require('./schema-prepare.cjs');
const { importTypedStore } = require('./backup-rows.cjs');
const { copyMigrationAssets, publishProfile } = require('./migration-assets.cjs');
const { revokePostgresCredentials } = require('./backup-credentials.cjs');
const { registerAssetProfile } = require('./catalog-postgres.cjs');
async function restoreVerifiedPostgres(
  client,
  {
    recovered,
    manifest,
    destination,
    applicationRole = 'cartoteca_app',
    upgradeCopy = false,
    offline = false,
  },
) {
  if (!offline) throw Error('PostgreSQL restore requires an explicitly offline fresh target.');
  const revisionProfile = require('./revision-profile132.cjs').archiveRevisionProfile(
    manifest.revisionProfile,
  );
  if (typeof upgradeCopy !== 'boolean') throw Error('Invalid PostgreSQL restore mode.');
  const target = path.resolve(destination);
  if (fs.existsSync(target)) throw Error('Restore asset destination must be new.');
  const profile = {
    ...manifest.profile,
    // Authenticated archive metadata may include an explicitly prepared schema2
    // component. Keep that creation lineage as well as its restored store rows.
    cabinetTemplates: { ...manifest.profile.cabinetTemplates },
    migrationId: randomUUID(),
    stores: manifest.profile.stores.map((store) => ({ ...store, emptyOrigin: false })),
  };
  let transaction = false,
    assets = false,
    commitAttempted = false,
    confirmed = false;
  try {
    await client.query('BEGIN');
    transaction = true;
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('cartoteca-offline-migration',0))",
    );
    const registered = (
      await client.query("SELECT to_regclass('cartoteca_catalog.stores') AS relation")
    ).rows[0].relation;
    if (
      registered &&
      (await client.query('SELECT 1 FROM cartoteca_catalog.stores LIMIT 1')).rows.length
    )
      throw Error('Disaster restore requires an empty PostgreSQL database.');
    await preparePostgresSchema(client, {
      kind: 'cabinet',
      source: canonicalSqliteSchema({ kind: 'cabinet', version: 2 }),
      applicationRole,
      register: false,
    });
    for (const version of [0, 1, 2])
      await registerCanonicalTemplate(client, {
        kind: 'cabinet',
        source: canonicalSqliteSchema({ kind: 'cabinet', version }),
      });
    const reports = [];
    for (const store of manifest.stores) {
      await preparePostgresSchema(client, {
        kind: store.kind,
        storeId: store.storeId,
        source: store.metadata,
        applicationRole,
      });
      reports.push({
        kind: store.kind,
        storeId: store.storeId,
        tables: await importTypedStore(client, { directory: recovered, store }),
      });
    }
    const files = manifest.files
      .filter(
        (file) => !file.name.startsWith('postgres/') && file.name !== 'postgresql-runtime.json',
      )
      .map((file) => ({ relative: file.name, sha256: file.sha256, bytes: file.size }));
    copyMigrationAssets({
      source: recovered,
      destination: target,
      files,
      profile,
      onCreate: () => {
        assets = true;
      },
    });
    if (!upgradeCopy) await revokePostgresCredentials(client, { directory: target, manifest });
    if (revisionProfile === 2)
      await require('./revision-operator132.cjs').prepareRevisionProfile(client, applicationRole);
    if (revisionProfile === 3)
      await require('./revision-operator133.cjs').prepareCompoundProfile(client, applicationRole);
    await registerAssetProfile(client, profile);
    commitAttempted = true;
    await client.query('COMMIT');
    transaction = false;
    confirmed = true;
    publishProfile(target, profile);
    return {
      backend: 'postgres',
      stores: reports.length,
      reports,
      sessionsRevoked: !upgradeCopy,
      notificationsPaused: !upgradeCopy,
      upgradeCopy,
      cutover: false,
      destination: target,
    };
  } catch (error) {
    if (transaction && !commitAttempted)
      try {
        await client.query('ROLLBACK');
        transaction = false;
      } catch {}
    if (commitAttempted && !confirmed) {
      error.outcomeUnknown = true;
      error.code = 'POSTGRES_RESTORE_COMMIT_UNKNOWN';
    }
    if (
      assets &&
      !commitAttempted &&
      fs.existsSync(target) &&
      !fs.existsSync(path.join(target, 'postgresql-runtime.json'))
    )
      fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}
module.exports = { restoreVerifiedPostgres };
