const { randomUUID } = require('node:crypto');
const { digest } = require('./catalog-sqlite.cjs');
const { KEYS } = require('./lock-intents.cjs');
const { validatePostgresSchema } = require('./catalog-postgres.cjs');
const { refreshManifests } = require('./revision-operator132.cjs');
const { signature, expectedTables, verifyReadScopes163 } = require('./read-scope-schema163.cjs');
const { TABLE, META, createSQL, triggerSQL } = require('./read-scope-sql163.cjs');
// Explicit SQL-only offline component transition. The caller owns BEGIN/COMMIT.
// Maintenance excludes active native readers and all existing mutation owners.
// Clinical data, runtime lineage, keys, IDs and base revision profile stay intact.
async function prepareReadScopes163(client, applicationRole, { rollback = false } = {}) {
  const authority = (
    await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
  ).rows[0];
  if (!authority || (!authority.rolsuper && !authority.rolbypassrls))
    throw Error('Read scope preparation requires offline catalog authority.');
  const lock = (
    await client.query('SELECT pg_try_advisory_xact_lock($1::bigint) locked', [KEYS.maintenance])
  ).rows[0];
  if (!lock?.locked) throw Error('Read scope preparation is blocked by active application work.');
  await client.query('SAVEPOINT ct_read_scope_prepare163');
  try {
    if (
      (await require('./revision-profile132.cjs').readRevisionProfile(client, applicationRole)) !==
      3
    )
      throw Error('Read scope component requires revision profile3.');
    for (const kind of ['platform', 'cabinet'])
      await validatePostgresSchema(client, { kind, applicationRole });
    const existing = await verifyReadScopes163(client, applicationRole);
    if ((existing && !rollback) || (!existing && rollback)) {
      await client.query('RELEASE SAVEPOINT ct_read_scope_prepare163');
      return { changed: false, prepared: !!existing, ...existing };
    }
    const tables = await expectedTables(client);
    if (rollback) {
      for (const table of tables) await client.query(triggerSQL(table, true));
      await client.query(
        `DROP FUNCTION cartoteca_catalog.bump_read_scope163(); DROP TABLE ${TABLE}; DROP TABLE ${META};`,
      );
    } else {
      await client.query(createSQL(applicationRole));
      for (const table of tables) await client.query(triggerSQL(table));
      await client.query(`INSERT INTO ${TABLE}(kind,store_id,scope_id,revision,last_xid)
        SELECT kind,store_id,'*',1,'0'::xid8 FROM cartoteca_catalog.stores WHERE kind IN('platform','cabinet');
        INSERT INTO ${TABLE}(kind,store_id,scope_id,revision,last_xid)
        SELECT 'platform',_store_id,id,1,'0'::xid8 FROM cartoteca_platform.organizations;`);
      const observed = await signature(client, applicationRole);
      await client.query(`INSERT INTO ${META}(version,epoch,signature,digest) VALUES(1,$1,$2,$3)`, [
        randomUUID(),
        observed,
        digest(observed),
      ]);
    }
    await refreshManifests(client, ['platform', 'cabinet']);
    const after = await verifyReadScopes163(client, applicationRole);
    if (rollback ? after !== null : !after)
      throw Error('Read scope transition verification failed.');
    await client.query('RELEASE SAVEPOINT ct_read_scope_prepare163');
    return {
      changed: true,
      prepared: !rollback,
      clinicalRowsChanged: 0,
      dataCopiesCreated: 0,
      ...after,
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK TO SAVEPOINT ct_read_scope_prepare163');
      await client.query('RELEASE SAVEPOINT ct_read_scope_prepare163');
    } catch {
      error.outcomeUnknown = true;
    }
    throw error;
  }
}
module.exports = { prepareReadScopes163 };
