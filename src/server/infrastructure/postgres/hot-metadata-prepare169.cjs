const { randomUUID } = require('node:crypto');
const { digest } = require('./catalog-sqlite.cjs');
const { validateRuntimeProfile } = require('./runtime.cjs');
const { KEYS } = require('./lock-intents.cjs');
const { validatePostgresSchema } = require('./catalog-postgres.cjs');
const { readRevisionProfile } = require('./revision-profile132.cjs');
const { verifyReadScopes163 } = require('./read-scope-schema163.cjs');
const {
  META,
  TABLE,
  FUNCTION,
  ARG_TYPES,
  createHotMetadataSQL169,
  bindingProof169,
} = require('./hot-metadata-sql169.cjs');
const {
  verifyHotMetadata169,
  signatureHotMetadata169,
  invalid169,
  uuid169,
  hash169,
} = require('./hot-metadata-component169.cjs');
const MAX_BINDINGS169 = 100000;
function validBinding169(row, epoch) {
  return (
    ['platform_store_id', 'organization_id', 'cabinet_store_id', 'migration_id'].every((k) =>
      uuid169(row[k]),
    ) &&
    row.binding_epoch === epoch &&
    [19, 20].includes(Number(row.platform_version)) &&
    [1, 2].includes(Number(row.cabinet_version)) &&
    ['marker_hash', 'platform_hash', 'cabinet_hash', 'binding_proof'].every((k) =>
      hash169(row[k]),
    ) &&
    row.binding_proof === bindingProof169(row)
  );
}
// Explicit metadata-only transition. Caller owns BEGIN/COMMIT and the existing
// maintenance protocol. No existing business/catalog/asset row is modified.
async function prepareHotMetadata169(client, role, { marker, rollback = false } = {}) {
  if (typeof rollback !== 'boolean') throw invalid169();
  if (!rollback) validateRuntimeProfile(marker);
  const authority = (
    await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
  ).rows[0];
  if (!authority || (!authority.rolsuper && !authority.rolbypassrls)) throw invalid169();
  const lock = (
    await client.query('SELECT pg_try_advisory_xact_lock($1::bigint) held', [KEYS.maintenance])
  ).rows[0];
  if (!lock?.held)
    throw Object.assign(invalid169(), { code: 'POSTGRES_HOT_METADATA_PREPARE_BUSY169' });
  await client.query('SAVEPOINT ct_hot_metadata169');
  try {
    await validatePostgresSchema(client, { kind: 'platform', applicationRole: role });
    await validatePostgresSchema(client, { kind: 'cabinet', applicationRole: role });
    if ((await readRevisionProfile(client, role)) !== 3) throw invalid169();
    const before = await verifyHotMetadata169(client, role, { marker });
    if (rollback) {
      if (before) {
        await client.query(
          `DROP FUNCTION ${FUNCTION}(${ARG_TYPES}); DROP TABLE ${TABLE}; DROP TABLE ${META}`,
        );
        if ((await verifyHotMetadata169(client, role)) !== null) throw invalid169();
      }
      await client.query('RELEASE SAVEPOINT ct_hot_metadata169');
      return {
        changed: !!before,
        prepared: false,
        clinicalRowsChanged: 0,
        keyFilesChanged: 0,
        dataCopiesCreated: 0,
      };
    }
    if (!(await verifyReadScopes163(client, role))) throw invalid169();
    const markerHash = digest(marker),
      p = marker.platformStoreId;
    const lineage = (
      await client.query(
        `SELECT migration_id,marker_hash FROM cartoteca_catalog.asset_profiles
      WHERE kind='platform' AND store_id=$1`,
        [p],
      )
    ).rows;
    if (
      lineage.length !== 1 ||
      !uuid169(lineage[0].migration_id) ||
      !hash169(lineage[0].marker_hash)
    )
      throw invalid169();
    const decline = async (reason) => {
      await client.query('RELEASE SAVEPOINT ct_hot_metadata169');
      return {
        changed: false,
        prepared: !!before,
        eligible: false,
        unsupported: reason,
        clinicalRowsChanged: 0,
        keyFilesChanged: 0,
        dataCopiesCreated: 0,
      };
    };
    if (lineage[0].migration_id !== marker.migrationId || lineage[0].marker_hash !== markerHash)
      return await decline('marker-generation');
    const entries = marker.stores.filter((s) => s.kind === 'cabinet' && s.organizationId);
    const duplicate = new Set();
    for (const entry of entries) {
      if (duplicate.has(entry.organizationId)) throw invalid169();
      duplicate.add(entry.organizationId);
    }
    const wanted = [p, ...entries.map((s) => s.storeId)];
    const catalogs = (
      await client.query(
        `SELECT s.kind,s.store_id,s.version,s.catalog_hash,s.metadata=t.metadata matches
      FROM cartoteca_catalog.stores s JOIN cartoteca_catalog.templates t ON t.kind=s.kind AND t.version=s.version AND t.catalog_hash=s.catalog_hash
      WHERE s.kind IN('platform','cabinet') AND s.store_id=ANY($1::text[])`,
        [wanted],
      )
    ).rows;
    const platform = catalogs.find((s) => s.kind === 'platform' && s.store_id === p);
    if (!platform || platform.matches !== true || !hash169(platform.catalog_hash))
      throw invalid169();
    if (
      Number(platform.version) !== marker.notificationSchema ||
      ![19, 20].includes(Number(platform.version))
    )
      return await decline('catalog-generation');
    const liveOrgs = new Set(
      (
        await client.query(
          `SELECT id FROM cartoteca_platform.organizations
      WHERE _store_id=$1 AND id=ANY($2::text[])`,
          [p, entries.map((s) => s.organizationId)],
        )
      ).rows.map((s) => s.id),
    );
    let previous = [],
      generations = {};
    if (before) {
      const count = Number((await client.query(`SELECT count(*)::text n FROM ${TABLE}`)).rows[0].n);
      if (!Number.isSafeInteger(count) || count < 0 || count > MAX_BINDINGS169) throw invalid169();
      previous = (
        await client.query(`SELECT platform_store_id,organization_id,cabinet_store_id,migration_id,marker_hash,
        binding_epoch::text,platform_version,platform_hash,cabinet_version,cabinet_hash,binding_proof FROM ${TABLE}
        ORDER BY platform_store_id COLLATE "C",organization_id COLLATE "C"`)
      ).rows;
      if (previous.length !== count || previous.some((r) => !validBinding169(r, before.epoch)))
        throw invalid169();
      generations = (await client.query(`SELECT prepared_generations FROM ${META} WHERE version=1`))
        .rows[0].prepared_generations;
    }
    const epoch = randomUUID(),
      bindings = previous
        .filter((r) => r.platform_store_id !== p)
        .map((r) => ({ ...r, binding_epoch: epoch }));
    for (const entry of entries) {
      if (!liveOrgs.has(entry.organizationId)) continue;
      const cabinet = catalogs.find((s) => s.kind === 'cabinet' && s.store_id === entry.storeId);
      if (!cabinet) continue;
      if (cabinet.matches !== true || !hash169(cabinet.catalog_hash)) throw invalid169();
      // A valid different catalog generation is explicitly left on the cold path.
      if (
        Number(cabinet.version) !== entry.schemaVersion ||
        cabinet.catalog_hash !== marker.cabinetTemplates[String(entry.schemaVersion)]
      )
        continue;
      bindings.push({
        platform_store_id: p,
        organization_id: entry.organizationId,
        cabinet_store_id: entry.storeId,
        migration_id: marker.migrationId,
        marker_hash: markerHash,
        binding_epoch: epoch,
        platform_version: Number(platform.version),
        platform_hash: platform.catalog_hash,
        cabinet_version: Number(cabinet.version),
        cabinet_hash: cabinet.catalog_hash,
      });
    }
    if (bindings.length > MAX_BINDINGS169) throw invalid169();
    if (!before) await client.query(createHotMetadataSQL169(role));
    else await client.query(`DELETE FROM ${TABLE}`);
    const columns = [
      'platform_store_id',
      'organization_id',
      'cabinet_store_id',
      'migration_id',
      'marker_hash',
      'binding_epoch',
      'platform_version',
      'platform_hash',
      'cabinet_version',
      'cabinet_hash',
      'binding_proof',
    ];
    for (let at = 0; at < bindings.length; at += 200) {
      const batch = bindings.slice(at, at + 200),
        values = [];
      const tuples = batch.map((b) => {
        b.binding_proof = bindingProof169(b);
        return (
          '(' +
          columns
            .map((k) => {
              values.push(b[k]);
              return '$' + values.length;
            })
            .join(',') +
          ')'
        );
      });
      await client.query(
        `INSERT INTO ${TABLE}(${columns.join(',')}) VALUES ${tuples.join(',')}`,
        values,
      );
    }
    generations = { ...generations, [p]: { migrationId: marker.migrationId, markerHash } };
    const observed = await signatureHotMetadata169(client, role),
      signature = digest(observed);
    await client.query(
      `INSERT INTO ${META}(version,epoch,signature,digest,prepared_generations) VALUES(1,$1,$2,$3,$4)
      ON CONFLICT(version) DO UPDATE SET epoch=excluded.epoch,signature=excluded.signature,digest=excluded.digest,prepared_generations=excluded.prepared_generations`,
      [epoch, observed, signature, generations],
    );
    const after = await verifyHotMetadata169(client, role, { marker });
    if (!after?.eligibleMarker) throw invalid169();
    await client.query('RELEASE SAVEPOINT ct_hot_metadata169');
    return {
      changed: true,
      prepared: true,
      clinicalRowsChanged: 0,
      keyFilesChanged: 0,
      dataCopiesCreated: 0,
      bindingCount: bindings.length,
      ownBindingCount: bindings.filter((b) => b.platform_store_id === p).length,
      capability: after,
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK TO SAVEPOINT ct_hot_metadata169');
      await client.query('RELEASE SAVEPOINT ct_hot_metadata169');
    } catch {
      error.outcomeUnknown = true;
    }
    throw error;
  }
}
module.exports = { prepareHotMetadata169 };
