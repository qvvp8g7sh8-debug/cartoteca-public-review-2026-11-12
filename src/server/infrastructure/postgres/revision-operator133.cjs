'use strict';
const legacy = require('./revision-operator132.cjs');
const { readRevisionProfile } = require('./revision-profile132.cjs');
const snapshotSQL = require('./revision-sql133.cjs').functionSQL;
const domainSQL = require('./revision-sql132.cjs').functionSQL;
// Offline inverse changes the compatibility base once per scope. Native MVCC
// tokens are never persisted/replayed; a restarted owner supplies a fresh epoch.
async function invalidateLegacyCounters(client) {
  const scopes = (
    await client.query('SELECT kind,store_id FROM cartoteca_catalog.stores ORDER BY kind,store_id')
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
    const changed = await client.query(
      'UPDATE cartoteca_catalog.stores SET revision=revision+1 WHERE kind=$1 AND store_id=$2 RETURNING revision',
      [scope.kind, scope.store_id],
    );
    if (changed.rows.length !== 1) throw Error('Compound inverse invalidation was not confirmed.');
  }
  await client.query(
    "SELECT set_config('cartoteca.kind',$1,true),set_config('cartoteca.store_id',$2,true)",
    [original.kind || '', original.store_id || ''],
  );
}
async function applyCompoundProfile(client, role, { target = 3 } = {}) {
  if (![1, 2, 3].includes(target)) throw Error('Unsupported compound profile target.');
  const previous = await readRevisionProfile(client, role);
  if (previous === target) return { previous, target, changed: false };
  if (previous === 3) {
    const authority = (
      await client.query(
        'SELECT rolsuper,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=current_user',
      )
    ).rows;
    if (
      authority.length !== 1 ||
      !(authority[0].rolsuper === true || authority[0].rolbypassrls === true)
    )
      throw Object.assign(Error('Catalog-wide PostgreSQL inverse authority is required.'), {
        code: 'POSTGRES_REVISION_OPERATOR_AUTHORITY_REQUIRED',
        status: 503,
      });
  }
  const list = await legacy.kinds(client);
  const before = await legacy.inventory(client, list, { role });
  let current = previous;
  if (current === 3) {
    await invalidateLegacyCounters(client);
    await client.query(domainSQL(2));
    await legacy.refreshManifests(client, list);
    current = 2;
  }
  if (target === 3) {
    if (current === 1) await legacy.prepareRevisionProfile(client, role, { target: 2 });
    await client.query(snapshotSQL());
    await legacy.refreshManifests(client, list);
  } else if (current !== target) {
    await legacy.prepareRevisionProfile(client, role, { target });
  }
  if ((await readRevisionProfile(client, role)) !== target)
    throw Error('Compound revision profile verification failed.');
  if (before !== (await legacy.inventory(client, list, { role })))
    throw Error('Compound preparation changed business or canonical definitions.');
  return { previous, target, changed: true };
}
async function prepareCompoundProfile(client, role, options = {}) {
  const savepoint = 'ct_compound_prepare133';
  await client.query('SAVEPOINT ' + savepoint);
  try {
    const result = await applyCompoundProfile(client, role, options);
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
async function operateCompoundProfile(args, environment, dependencies = {}, target = 3) {
  if (![1, 2, 3].includes(target)) throw Error('Unsupported compound profile target.');
  return legacy.operateRevisionProfile(
    args,
    environment,
    {
      ...dependencies,
      prepareRevisionProfile: dependencies.prepareRevisionProfile || prepareCompoundProfile,
    },
    target,
  );
}
module.exports = { prepareCompoundProfile, operateCompoundProfile };
