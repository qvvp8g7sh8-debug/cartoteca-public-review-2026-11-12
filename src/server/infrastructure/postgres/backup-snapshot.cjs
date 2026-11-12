const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readRuntime } = require('./runtime.cjs');
const { identifier: q, digest } = require('./catalog-sqlite.cjs');
const { qualify } = require('./schema-plan.cjs');
const { validatePostgresSchema, verifyAssetProfile } = require('./catalog-postgres.cjs');
const { plain } = require('./migration-assets.cjs');
const { safeTree } = require('../backup/snapshot.cjs');
const { assertNoOrganizationSwitch } = require('../backup/organization-guard.cjs');
function sourceReady(source) {
  safeTree(source);
  assertNoOrganizationSwitch(source);
  if (fs.existsSync(path.join(source, '.restore-in-progress')))
    throw Error('PostgreSQL asset restore is incomplete.');
}
const { writeTypedRows, nativeRows } = require('./backup-rows.cjs');
function advisory(value) {
  return createHash('sha256').update(value).digest().readBigInt64BE().toString();
}
async function scope(client, kind, storeId) {
  await client.query(
    "SELECT set_config('cartoteca.kind',$1,true),set_config('cartoteca.store_id',$2,true)",
    [kind, storeId],
  );
}
async function storesForSnapshot(client, source, profile) {
  const rows = new Map(
    profile.stores.map((row) => [row.kind + ':' + row.storeId, { ...row, emptyOrigin: false }]),
  );
  const knownOrganizations = new Set(
    profile.stores.filter((row) => row.kind === 'cabinet').map((row) => row.organizationId),
  );
  await scope(client, 'platform', profile.platformStoreId);
  const orgs = (
    await client.query('SELECT id FROM cartoteca_platform.organizations WHERE _store_id=$1', [
      profile.platformStoreId,
    ])
  ).rows;
  for (const { id } of orgs) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw Error('Unsupported snapshot organization.');
    if (knownOrganizations.has(id)) continue;
    await scope(client, 'cabinet', id);
    const existing = (
      await client.query(
        "SELECT version FROM cartoteca_catalog.stores WHERE kind='cabinet' AND store_id=$1",
        [id],
      )
    ).rows[0];
    if (existing)
      rows.set('cabinet:' + id, {
        kind: 'cabinet',
        storeId: id,
        organizationId: id,
        relativeDirectory: 'tenants/' + id,
        schemaVersion: Number(existing.version),
      });
  }
  const stores = [];
  for (const row of rows.values()) {
    await scope(client, row.kind, row.storeId);
    const registered = (
      await client.query(
        'SELECT metadata,catalog_hash,revision FROM cartoteca_catalog.stores WHERE kind=$1 AND store_id=$2',
        [row.kind, row.storeId],
      )
    ).rows[0];
    if (!registered || digest(registered.metadata) !== registered.catalog_hash)
      throw Error('Snapshot store catalog is missing or changed.');
    stores.push({ ...row, metadata: registered.metadata, catalogHash: registered.catalog_hash });
  }
  return stores;
}
async function pinAssets(source, stage, stores) {
  const names = [];
  async function pin(name, key = false) {
    const original = path.join(source, name),
      target = path.join(stage, name);
    safeTree(path.dirname(original));
    plain(original);
    if (key && fs.statSync(original).size !== 32) throw Error('Snapshot key asset is invalid.');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (/\/photos\//.test('/' + name)) {
      try {
        await fs.promises.link(original, target);
      } catch (error) {
        if (!['EXDEV', 'EPERM', 'ENOSYS', 'ENOTSUP'].includes(error.code)) throw error;
        await fs.promises.copyFile(original, target, fs.constants.COPYFILE_EXCL);
      }
    } else await fs.promises.copyFile(original, target, fs.constants.COPYFILE_EXCL);
    names.push(name);
  }
  await pin('platform/platform.key', true);
  if (fs.existsSync(path.join(source, 'platform', 'assistant-state.enc')))
    await pin('platform/assistant-state.enc');
  for (const store of stores.filter((row) => row.kind === 'cabinet')) {
    const prefix = store.relativeDirectory === '.' ? '' : store.relativeDirectory + '/';
    await pin(prefix + 'encryption.key', true);
    const photos = path.join(source, prefix, 'photos');
    if (fs.existsSync(photos)) {
      plain(photos, true);
      for (const name of fs.readdirSync(photos).sort()) {
        if (!/^[a-f0-9]{32}\.enc$/.test(name)) throw Error('Unsupported snapshot photo object.');
        await pin(prefix + 'photos/' + name);
      }
    }
  }
  return names;
}
async function snapshotPostgres(client, { source, stage, applicationRole = 'cartoteca_app' }) {
  sourceReady(source);
  const profile = readRuntime(source),
    locks = [],
    native = [];
  let transaction = false;
  const acquire = async (key) => {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [key]);
    locks.push(key);
  };
  const unlock = async () => {
    for (const key of locks.splice(0).reverse())
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
  };
  await client.query("SET lock_timeout='5000ms'");
  try {
    // Session locks precede the MVCC snapshot. Pin immutable photo bytes while
    // writers/GC are excluded, then release writers during the long SQL stream.
    await acquire(advisory('cartoteca:platform-write-fence:v1'));
    sourceReady(source);
    if (profile.budgetStoreId)
      await acquire(advisory('cartoteca:store:budget:' + profile.budgetStoreId));
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transaction = true;
    await verifyAssetProfile(client, profile);
    const stores = await storesForSnapshot(client, source, profile);
    for (const kind of [...new Set(stores.map((row) => row.kind))]) {
      await validatePostgresSchema(client, { kind, applicationRole });
      native.push(
        ...(
          await client.query(
            'SELECT kind,signature,digest FROM cartoteca_catalog.native_manifests WHERE kind=$1',
            [kind],
          )
        ).rows,
      );
    }
    const revisionProfile = await require('./revision-profile132.cjs').readRevisionProfile(
      client,
      applicationRole,
    );
    const names = await pinAssets(source, stage, stores);
    const snapshotProfile = {
      ...profile,
      stores: stores.map(({ metadata, catalogHash, ...row }) => row),
    };
    fs.writeFileSync(path.join(stage, 'postgresql-runtime.json'), JSON.stringify(snapshotProfile), {
      flag: 'wx',
      mode: 0o600,
    });
    names.push('postgresql-runtime.json');
    fs.mkdirSync(path.join(stage, 'postgres', 'catalog'), { recursive: true, mode: 0o700 });
    const templates = (
      await client.query(
        'SELECT kind,version,catalog_hash,metadata FROM cartoteca_catalog.templates ORDER BY kind,version,catalog_hash',
      )
    ).rows;
    fs.writeFileSync(path.join(stage, 'postgres', 'templates.json'), JSON.stringify(templates), {
      flag: 'wx',
      mode: 0o600,
    });
    names.push('postgres/templates.json');
    fs.writeFileSync(
      path.join(stage, 'postgres', 'native-manifests.json'),
      JSON.stringify(native),
      { flag: 'wx', mode: 0o600 },
    );
    names.push('postgres/native-manifests.json');
    await unlock();
    const reports = [];
    let rowBytes = 0;
    for (const store of stores) {
      await scope(client, store.kind, store.storeId);
      const file = 'postgres/catalog/' + store.storeId + '.json';
      fs.writeFileSync(path.join(stage, file), JSON.stringify(store.metadata), {
        flag: 'wx',
        mode: 0o600,
      });
      names.push(file);
      const tables = [];
      for (const table of Object.values(store.metadata.tables)) {
        const name = 'postgres/' + store.kind + '/' + store.storeId + '/' + table.name + '.jsonl';
        const result = await writeTypedRows(
          path.join(stage, name),
          table,
          nativeRows(client, store, table),
        );
        rowBytes += fs.statSync(path.join(stage, name)).size;
        tables.push({ name: table.name, file: name, ...result });
        names.push(name);
      }
      reports.push({
        kind: store.kind,
        storeId: store.storeId,
        catalog: file,
        catalogHash: store.catalogHash,
        tables,
      });
    }
    await client.query('ROLLBACK');
    transaction = false;
    return {
      profile: snapshotProfile,
      stores: reports,
      names,
      rowBytes,
      ...([2, 3].includes(revisionProfile)
        ? { revisionProfile: { version: revisionProfile } }
        : {}),
    };
  } finally {
    if (transaction)
      try {
        await client.query('ROLLBACK');
      } catch {}
    try {
      await unlock();
    } catch {}
  }
}
async function estimatePostgresBytes({ source, client }) {
  sourceReady(source);
  const profile = readRuntime(source);
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await verifyAssetProfile(client, profile);
    const stores = await storesForSnapshot(client, source, profile);
    let sqlBytes = 0;
    for (const store of stores) {
      await scope(client, store.kind, store.storeId);
      for (const table of Object.values(store.metadata.tables)) {
        const row = (
          await client.query(
            'SELECT COALESCE(SUM(pg_column_size(t)),0) AS bytes FROM ' +
              qualify(store.kind, table.name) +
              ' t WHERE _store_id=$1',
            [store.storeId],
          )
        ).rows[0];
        const bytes = Number(row.bytes);
        if (!Number.isSafeInteger(bytes) || bytes < 0)
          throw Error('PostgreSQL backup estimate exceeds its bound.');
        sqlBytes += bytes;
      }
    }
    let assetBytes = 0;
    const add = (file) => {
      plain(file);
      assetBytes += fs.statSync(file).size;
    };
    add(path.join(source, 'platform', 'platform.key'));
    for (const store of stores.filter((row) => row.kind === 'cabinet')) {
      const directory = path.join(source, store.relativeDirectory);
      add(path.join(directory, 'encryption.key'));
      const photos = path.join(directory, 'photos');
      if (fs.existsSync(photos)) {
        plain(photos, true);
        for (const name of fs.readdirSync(photos))
          if (/^[a-f0-9]{32}\.enc$/.test(name)) add(path.join(photos, name));
      }
    }
    if (fs.existsSync(path.join(source, 'platform', 'assistant-state.enc')))
      add(path.join(source, 'platform', 'assistant-state.enc'));
    if (!Number.isSafeInteger(sqlBytes + assetBytes))
      throw Error('PostgreSQL backup estimate exceeds its bound.');
    return {
      sqlBytes,
      assetBytes,
      sourceBytes: assetBytes + Math.ceil(sqlBytes * 2),
      conservativeEncodingFactor: 2,
    };
  } finally {
    await client.query('ROLLBACK');
  }
}
module.exports = { snapshotPostgres, estimatePostgresBytes, storesForSnapshot, scope, advisory };
