'use strict';
const { TABLE, tableSQL, functionSQL } = require('./revision-sql132.cjs');
const { readRevisionProfile } = require('./revision-profile132.cjs');
const { digest } = require('./catalog-sqlite.cjs');
const { KEYS, advisoryKey } = require('./lock-intents.cjs');
async function kinds(client) {
  const result = (
    await client.query('SELECT kind FROM cartoteca_catalog.native_manifests ORDER BY kind')
  ).rows.map((r) => r.kind);
  if (
    !result.length ||
    result.some((v) => !['platform', 'cabinet', 'budget'].includes(v)) ||
    new Set(result).size !== result.length
  )
    throw Error('Prepared native profiles are required.');
  return result;
}
function businessSignature(signature) {
  return {
    ...signature,
    helpers: signature.helpers.filter((r) => r.proname !== 'bump_store_revision'),
    triggers: signature.triggers.map((r) =>
      /EXECUTE FUNCTION cartoteca_catalog\.bump_store_revision\(/.test(r.definition)
        ? { ...r, function: null }
        : r,
    ),
  };
}
async function inventory(client, list, { validate = true, role } = {}) {
  const { validatePostgresSchema, nativeSignature } = require('./catalog-postgres.cjs');
  const schemas = {};
  for (const kind of list) {
    if (validate) await validatePostgresSchema(client, { kind, applicationRole: role });
    schemas[kind] = digest(businessSignature(await nativeSignature(client, kind)));
  }
  const catalogs = {};
  for (const table of [
    'stores',
    'asset_profiles',
    'objects',
    'columns',
    'indexes',
    'index_columns',
    'templates',
    'native_objects',
  ]) {
    const source = table === 'stores' ? "to_jsonb(t)-'revision'" : 'to_jsonb(t)';
    const row = (
      await client.query(
        `SELECT count(*)::text AS rows,md5(coalesce(string_agg(fingerprint,'' ORDER BY fingerprint),'')) AS digest FROM (SELECT md5((${source})::text) AS fingerprint FROM cartoteca_catalog.${table} t) s`,
      )
    ).rows[0];
    if (!row || !/^[0-9]+$/.test(row.rows) || !/^[a-f0-9]{32}$/.test(row.digest))
      throw Error('Revision upgrade catalog proof unavailable.');
    catalogs[table] = row;
  }
  return digest({ schemas, catalogs });
}
async function refreshManifests(client, list) {
  const { nativeSignature, validatePostgresSchema } = require('./catalog-postgres.cjs');
  for (const kind of list) {
    const signature = await nativeSignature(client, kind);
    await client.query(
      'UPDATE cartoteca_catalog.native_manifests SET signature=$2,digest=$3 WHERE kind=$1',
      [kind, signature, digest(signature)],
    );
    await validatePostgresSchema(client, { kind });
  }
}
async function foldRevisionState(client) {
  const scopes = (
    await client.query(
      `SELECT kind,store_id,SUM(revision)::bigint AS total FROM ${TABLE} GROUP BY kind,store_id ORDER BY kind,store_id`,
    )
  ).rows;
  const original = (
    await client.query(
      "SELECT current_setting('cartoteca.kind',true) AS kind,current_setting('cartoteca.store_id',true) AS store_id",
    )
  ).rows[0];
  for (const scope of scopes) {
    await client.query(
      "SELECT set_config('cartoteca.kind',$1,true),set_config('cartoteca.store_id',$2,true)",
      [scope.kind, scope.store_id],
    );
    const before = (
      await client.query(
        `SELECT s.revision::text AS base,COALESCE(SUM(r.revision),0)::text AS total
      FROM cartoteca_catalog.stores s LEFT JOIN ${TABLE} r ON r.kind=s.kind AND r.store_id=s.store_id
      WHERE s.kind=$1 AND s.store_id=$2 GROUP BY s.revision`,
        [scope.kind, scope.store_id],
      )
    ).rows;
    if (before.length !== 1 || BigInt(before[0].total) !== BigInt(scope.total))
      throw Error('Revision inverse source proof changed.');
    const expected = BigInt(before[0].base) + BigInt(before[0].total);
    const folded = (
      await client.query(
        'UPDATE cartoteca_catalog.stores SET revision=revision+$3::bigint WHERE kind=$1 AND store_id=$2 AND revision=$4::bigint RETURNING revision::text AS revision',
        [scope.kind, scope.store_id, before[0].total, before[0].base],
      )
    ).rows;
    if (folded.length !== 1 || BigInt(folded[0].revision) !== expected)
      throw Error('Revision inverse store fold was not confirmed.');
    const after = (
      await client.query(
        `SELECT COALESCE(SUM(revision),0)::text AS total FROM ${TABLE} WHERE kind=$1 AND store_id=$2`,
        [scope.kind, scope.store_id],
      )
    ).rows;
    if (after.length !== 1 || BigInt(after[0].total) !== BigInt(scope.total))
      throw Error('Revision inverse counter changed before completion.');
  }
  // Do not discard any domain row until every scoped base update is confirmed.
  await client.query(
    "SELECT set_config('cartoteca.kind',$1,true),set_config('cartoteca.store_id',$2,true)",
    [original.kind || '', original.store_id || ''],
  );
}
// The caller owns an offline outer transaction and the exclusive maintenance fence.
// Fresh disaster restore uses this after importing typed rows, never archived SQL.
async function applyRevisionProfile(client, role, { target = 2 } = {}) {
  if (![1, 2].includes(target)) throw Error('Unsupported revision profile target.');
  const previous = await readRevisionProfile(client, role);
  if (previous === target) return { previous, target, changed: false };
  if (previous === 3)
    throw Error('Use the compound profile inverse before legacy revision preparation.');
  const list = await kinds(client);
  const before = await inventory(client, list, { role });
  if (target === 2) {
    await client.query(tableSQL(role));
    await client.query(functionSQL(2));
  } else {
    // Every committed domain increment is folded into the compatibility base.
    // No xid from this cluster is retained in the downgraded profile.
    await foldRevisionState(client);
    await client.query(functionSQL(1));
    await client.query('DROP TABLE ' + TABLE);
  }
  await refreshManifests(client, list);
  if ((await readRevisionProfile(client, role)) !== target)
    throw Error('Revision upgrade profile verification failed.');
  const after = await inventory(client, list, { role });
  if (before !== after)
    throw Error('Revision upgrade changed business or canonical catalog definitions.');
  return { previous, target, changed: true };
}
async function prepareRevisionProfile(client, role, { target = 2 } = {}) {
  if (![1, 2].includes(target)) throw Error('Unsupported revision profile target.');
  // SAVEPOINT outside an explicit physical transaction fails before any DDL.
  // A failed preparation never leaves half-applied DDL for a caller to commit.
  const savepoint = 'ct_revision_prepare132';
  await client.query('SAVEPOINT ' + savepoint);
  try {
    const result = await applyRevisionProfile(client, role, { target });
    await client.query('RELEASE SAVEPOINT ' + savepoint);
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK TO SAVEPOINT ' + savepoint);
      await client.query('RELEASE SAVEPOINT ' + savepoint);
    } catch {
      error.channelPoisoned = true;
      error.outcomeUnknown = true;
    }
    throw error;
  }
}
function revisionOptions(args) {
  if (
    args.length !== 2 ||
    args.filter((v) => v === '--offline').length !== 1 ||
    args.filter((v) => v === '--apply' || v === '--dry-run').length !== 1
  )
    throw Error('Revision preparation requires exactly --offline and --apply or --dry-run.');
  return { dryRun: args.includes('--dry-run') };
}
async function operateRevisionProfile(args, environment, dependencies = {}, target = 2) {
  const { dryRun } = revisionOptions(args);
  const { withOwner, verifyApplicationRole } = require('../../../../scripts/postgres-ops.cjs');
  return withOwner(
    environment,
    async (client, connection) => {
      const role = await verifyApplicationRole(client, connection, environment, dependencies);
      // The operator must see the complete guardian/store registry. An RLS-
      // filtered owner could otherwise mistake an active runtime for an empty DB.
      // Runtime/trigger owners remain supported without either privilege.
      const authority = (
        await client.query(
          'SELECT rolsuper,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=current_user',
        )
      ).rows;
      if (
        authority.length !== 1 ||
        !(authority[0].rolsuper === true || authority[0].rolbypassrls === true)
      )
        throw Object.assign(Error('Catalog-wide PostgreSQL operator authority is required.'), {
          code: 'POSTGRES_REVISION_OPERATOR_AUTHORITY_REQUIRED',
          status: 503,
        });
      // Read-only preflight. A malformed/mixed profile is refused before BEGIN/DDL.
      const read = dependencies.readRevisionProfile || readRevisionProfile;
      const initial = await read(client, role);
      const list = await kinds(client);
      await inventory(client, list, { role });
      let settled = false,
        commitAttempted = false;
      await client.query('BEGIN');
      try {
        await client.query(
          "SET LOCAL statement_timeout='10000ms'; SET LOCAL lock_timeout='5000ms'; SET LOCAL log_statement='none'; SET LOCAL log_min_error_statement='panic'",
        );
        const platforms = (
          await client.query(
            "SELECT store_id FROM cartoteca_catalog.stores WHERE kind='platform' ORDER BY store_id",
          )
        ).rows;
        for (const row of platforms) {
          const key = advisoryKey('cartoteca:postgres-server:v1:' + row.store_id);
          const held = (
            await client.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS held', [key])
          ).rows;
          if (held.length !== 1 || held[0].held !== true)
            throw Object.assign(
              Error('Stop the active PostgreSQL runtime before revision preparation.'),
              { code: 'POSTGRES_REVISION_RUNTIME_ACTIVE', status: 503 },
            );
        }
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [KEYS.maintenance]);
        const currentPlatforms = (
          await client.query(
            "SELECT store_id FROM cartoteca_catalog.stores WHERE kind='platform' ORDER BY store_id",
          )
        ).rows;
        if (digest(currentPlatforms) !== digest(platforms))
          throw Error('PostgreSQL platform registry changed during offline admission.');
        if ((await read(client, role)) !== initial)
          throw Error('Revision profile changed after offline preflight.');
        const change = await (dependencies.prepareRevisionProfile || prepareRevisionProfile)(
          client,
          role,
          { target },
        );
        if (
          change.target !== target ||
          ![1, 2, 3].includes(change.previous) ||
          typeof change.changed !== 'boolean'
        )
          throw Error('Revision preparation proof unavailable.');
        commitAttempted = !dryRun;
        await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
        settled = true;
        return {
          prepared: !dryRun,
          dryRun,
          rolledBack: dryRun,
          previous: change.previous,
          revisionProfile: target,
          changed: !dryRun && change.changed,
          wouldChange: change.changed,
          verified: true,
          businessSchemaUnchanged: true,
          catalogWideAuthority: true,
          rolesChanged: false,
          cutover: false,
        };
      } catch (error) {
        if (commitAttempted) {
          error.outcomeUnknown = true;
          error.code = 'POSTGRES_REVISION_COMMIT_UNKNOWN';
        }
        throw error;
      } finally {
        if (!settled && !commitAttempted) await client.query('ROLLBACK').catch(() => {});
      }
    },
    dependencies,
  );
}
module.exports = {
  prepareRevisionProfile,
  operateRevisionProfile,
  revisionOptions,
  businessSignature,
  kinds,
  inventory,
  refreshManifests,
};
