const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { describeSqliteSchema, digest } = require('./catalog-sqlite.cjs');
const {
  canonicalSqliteSchema,
  canonicalCabinetTemplateHashes,
} = require('./catalog-canonical.cjs');
const { preparePostgresSchema, registerCanonicalTemplate } = require('./schema-prepare.cjs');
const { registerAssetProfile } = require('./catalog-postgres.cjs');
const { copyStoreRows } = require('./migration-rows.cjs');
const { prepareLegacyCabinetIndexes } = require('./migration-derived.cjs');
const {
  migrationAssets,
  copyMigrationAssets,
  publishProfile,
  plain,
} = require('./migration-assets.cjs');
const { assertNoOrganizationSwitch } = require('../backup/organization-guard.cjs');
const { captureSourceProof, assertSourceProof } = require('./migration-source-proof.cjs');
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
function readOnly(file) {
  plain(file);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (
      db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').all().length
    )
      throw Error('Source SQLite integrity validation failed.');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
function sourceStores(source) {
  source = fs.realpathSync(source);
  plain(source, true);
  assertNoOrganizationSwitch(source);
  if (fs.existsSync(path.join(source, 'postgresql-runtime.json')))
    throw Error('Source is already a PostgreSQL asset directory.');
  for (const marker of [
    '.restore-in-progress',
    '.organization-restore-in-progress',
    '.cabinet-records-in-progress',
  ])
    if (fs.existsSync(path.join(source, marker)))
      throw Error('Source has an incomplete offline operation.');
  const stores = [],
    platform = readOnly(path.join(source, 'platform', 'platform.sqlite'));
  try {
    const schema = describeSqliteSchema(platform);
    if (![11, 12, 13, 14, 15, 16, 17, 18, 19, 20].includes(schema.version))
      throw Error('Unsupported source platform schema.');
    const key = fs.readFileSync(path.join(source, 'platform', 'platform.key'));
    if (key.length !== 32) throw Error('Source platform key is invalid.');
    const decode = (bytes) => {
      bytes = Buffer.from(bytes);
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'),
      );
    };
    const organizations = new Map(
      platform
        .prepare('SELECT id,value FROM organizations')
        .all()
        .map((row) => [row.id, decode(row.value)]),
    );
    if ([...organizations.keys()].some((id) => !uuid.test(id)))
      throw Error('Unsupported source organization identity.');
    const platformId = crypto.randomUUID(),
      rootId = crypto.randomUUID();
    stores.push({
      kind: 'platform',
      storeId: platformId,
      organizationId: null,
      relativeDirectory: 'platform',
      schemaVersion: schema.version,
      sqlite: platform,
      source: schema,
    });
    const root = path.join(source, 'cabinet.sqlite');
    if (fs.existsSync(root)) {
      const sqlite = readOnly(root),
        catalog = describeSqliteSchema(sqlite);
      const legacy = [...organizations].filter(([, value]) => value.legacyData).map(([id]) => id);
      if (legacy.length > 1) {
        sqlite.close();
        throw Error('Ambiguous legacy cabinet organization.');
      }
      stores.push({
        kind: 'cabinet',
        storeId: rootId,
        organizationId: legacy[0] || null,
        relativeDirectory: '.',
        schemaVersion: catalog.version,
        sqlite,
        source: catalog,
      });
    } else
      stores.push({
        kind: 'cabinet',
        storeId: rootId,
        organizationId: null,
        relativeDirectory: '.',
        schemaVersion: 1,
        emptyOrigin: true,
        source: canonicalSqliteSchema({ kind: 'cabinet', version: 1 }),
      });
    const tenantRoot = path.join(source, 'tenants');
    if (fs.existsSync(tenantRoot)) {
      plain(tenantRoot, true);
      for (const entry of fs
        .readdirSync(tenantRoot, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || !uuid.test(entry.name) || !organizations.has(entry.name))
          throw Error('Unsupported or orphaned tenant directory.');
        plain(path.join(tenantRoot, entry.name), true);
        const filename = path.join(tenantRoot, entry.name, 'cabinet.sqlite');
        if (!fs.existsSync(filename)) throw Error('Tenant directory has no database.');
        const sqlite = readOnly(filename),
          catalog = describeSqliteSchema(sqlite);
        stores.push({
          kind: 'cabinet',
          storeId: entry.name,
          organizationId: entry.name,
          relativeDirectory: 'tenants/' + entry.name,
          schemaVersion: catalog.version,
          sqlite,
          source: catalog,
        });
      }
    }
    for (const store of stores.filter((s) => s.kind === 'cabinet')) {
      if (![0, 1, 2].includes(store.schemaVersion))
        throw Error('Unsupported source cabinet schema.');
      prepareLegacyCabinetIndexes(store, source);
    }
    let budgetId = null;
    const budget = path.join(source, 'platform', 'booking-read-budget.sqlite');
    if (fs.existsSync(budget)) {
      const sqlite = readOnly(budget),
        catalog = describeSqliteSchema(sqlite);
      budgetId = crypto.randomUUID();
      if (catalog.version !== 1) {
        sqlite.close();
        throw Error('Unsupported source read-budget schema.');
      }
      stores.push({
        kind: 'budget',
        storeId: budgetId,
        organizationId: null,
        relativeDirectory: 'platform/booking-read-budget',
        schemaVersion: 1,
        sqlite,
        source: catalog,
      });
    }
    for (const store of stores.filter((row) => row.sqlite))
      for (const table of Object.values((store.originalSource || store.source).tables)) {
        const text = table.columns.filter((column) => column.type.toUpperCase() === 'TEXT');
        if (
          text.length &&
          store.sqlite
            .prepare(
              'SELECT 1 FROM "' +
                table.name +
                '" WHERE ' +
                text.map((column) => 'instr("' + column.name + '",char(0))>0').join(' OR ') +
                ' LIMIT 1',
            )
            .get()
        )
          throw Error('Source contains a plain-text value unsupported by PostgreSQL.');
      }
    return {
      source,
      stores,
      profile: {
        version: 1,
        backend: 'postgres',
        notificationSchema: schema.version,
        platformStoreId: platformId,
        rootCabinetStoreId: rootId,
        budgetStoreId: budgetId,
        cabinetSchema: 0,
        cabinetTemplates: canonicalCabinetTemplateHashes(),
        stores: stores.map(
          ({
            kind,
            storeId,
            organizationId,
            relativeDirectory,
            schemaVersion,
            emptyOrigin,
            sourceSchemaVersion,
            derivedIndexesPrepared,
          }) => ({
            kind,
            storeId,
            organizationId,
            relativeDirectory,
            schemaVersion,
            ...(emptyOrigin ? { emptyOrigin: true } : {}),
            ...(derivedIndexesPrepared
              ? { sourceSchemaVersion, derivedIndexesPrepared: true }
              : {}),
          }),
        ),
        migrationId: crypto.randomUUID(),
      },
    };
  } catch (error) {
    for (const store of stores) {
      store.derivedDatabase?.close();
      store.sqlite?.close();
    }
    if (!stores.length) platform.close();
    throw error;
  }
}
async function migratePostgresData({
  source,
  destination,
  client,
  applicationRole = 'cartoteca_app',
  dryRun = true,
  offline = false,
} = {}) {
  if (!offline) throw Error('Stop every source writer before PostgreSQL migration.');
  if (!client || typeof client.query !== 'function' || typeof dryRun !== 'boolean')
    throw Error('Invalid PostgreSQL migration options.');
  // SQLite opens may maintain SHM/empty WAL. Every durable source byte is
  // pinned before the first open and rechecked with every reader closed.
  const sourceProof = captureSourceProof(source),
    inventory = sourceStores(source);
  let sourcesClosed = false;
  function closeSources() {
    if (sourcesClosed) return;
    sourcesClosed = true;
    let failure;
    for (const store of inventory.stores)
      for (const db of [store.derivedDatabase, store.sqlite]) {
        try {
          db?.close();
        } catch (error) {
          failure ||= error;
        }
      }
    if (failure) throw failure;
  }
  let transaction = false,
    assetsCreated = false,
    commitAttempted = false,
    confirmed = false;
  let files;
  const reports = [];
  try {
    files = migrationAssets(inventory.source, inventory.profile.stores);
    await client.query('BEGIN');
    transaction = true;
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('cartoteca-offline-migration',0))",
    );
    // Install the physical tenant union once, then register exact source metadata
    // for each tenant. A source version is never silently upgraded.
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
    for (const store of inventory.stores) {
      await preparePostgresSchema(client, {
        kind: store.kind,
        storeId: store.storeId,
        source: store.source,
        applicationRole,
      });
      const tables = store.sqlite
        ? await copyStoreRows(client, { ...store, sqlite: store.sqlite, source: store.source })
        : [];
      reports.push({
        kind: store.kind,
        storeId: store.storeId,
        schemaVersion: store.schemaVersion,
        catalogHash: digest(store.source),
        tables,
        ...(store.derivedIndexesPrepared
          ? { sourceSchemaVersion: 0, derivedIndexesPrepared: true }
          : {}),
      });
    }
    await registerAssetProfile(client, inventory.profile);
    closeSources();
    assertSourceProof(inventory.source, sourceProof);
    if (dryRun) {
      await client.query('ROLLBACK');
      transaction = false;
      return {
        dryRun: true,
        rolledBack: true,
        sourceUnchanged: true,
        reports,
        assets: files.length,
      };
    }
    copyMigrationAssets({
      source: inventory.source,
      destination,
      files,
      profile: inventory.profile,
      onCreate: () => {
        assetsCreated = true;
      },
    });
    assertSourceProof(inventory.source, sourceProof);
    commitAttempted = true;
    await client.query('COMMIT');
    transaction = false;
    confirmed = true;
    publishProfile(destination, inventory.profile);
    return {
      dryRun: false,
      sourceUnchanged: true,
      cutover: false,
      migrationId: inventory.profile.migrationId,
      destination: path.resolve(destination),
      reports,
      assets: files.length,
    };
  } catch (error) {
    if (transaction && !commitAttempted) {
      try {
        await client.query('ROLLBACK');
        transaction = false;
      } catch {}
    }
    // A lost COMMIT response is unknown. Keep its asset staging and never publish
    // an activation marker, delete data, or automatically replay the import.
    if (commitAttempted && !confirmed) {
      error.outcomeUnknown = true;
      error.code = 'POSTGRES_MIGRATION_COMMIT_UNKNOWN';
    }
    if (assetsCreated && !commitAttempted) {
      const target = path.resolve(destination);
      if (fs.existsSync(target) && !fs.existsSync(path.join(target, 'postgresql-runtime.json')))
        fs.rmSync(target, { recursive: true, force: true });
    }
    throw error;
  } finally {
    closeSources();
  }
}
module.exports = { migratePostgresData, sourceStores };
