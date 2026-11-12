const { randomUUID } = require('node:crypto');
const { digest } = require('./catalog-sqlite.cjs');
const { KEYS } = require('./lock-intents.cjs');
const { validatePostgresSchema } = require('./catalog-postgres.cjs');
const { refreshManifests } = require('./revision-operator132.cjs');
const {
  META,
  HEAD,
  CHANGES,
  RECORD,
  TRIGGER,
  RECORD_ARGS,
  triggerSQL196,
  createDirectoryStateSQL196,
} = require('./directory-state-sql196.cjs');
const {
  FUNCTION196,
  ARG_TYPES196,
  createDirectoryHotSQL196,
} = require('./directory-state-hot-sql196.cjs');
const {
  directoryStateSignature196,
  verifyDirectoryState196,
} = require('./directory-state-schema196.cjs');
// Explicit offline adjunct transition. Caller owns BEGIN/COMMIT and unknown-ACK
// reconciliation. No clinical row, ciphertext, key, lineage or base schema edit.
async function prepareDirectoryState196(
  client,
  role,
  { stores = null, rollback = false, reset = false } = {},
) {
  if (typeof rollback !== 'boolean' || typeof reset !== 'boolean' || (rollback && reset))
    throw Error('Invalid directory state transition.');
  if (stores !== null && !Array.isArray(stores)) throw Error('Invalid directory state stores.');
  const selected =
    stores === null
      ? null
      : stores.map((store) => (typeof store === 'string' ? store : store?.storeId));
  if (
    selected !== null &&
    (selected.length > 100000 ||
      new Set(selected).size !== selected.length ||
      selected.some(
        (id) =>
          typeof id !== 'string' ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id),
      ))
  )
    throw Error('Invalid directory state stores.');
  const authority = (
    await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
  ).rows[0];
  if (!authority || (!authority.rolsuper && !authority.rolbypassrls))
    throw Error('Directory state preparation requires offline authority.');
  const lock = (
    await client.query('SELECT pg_try_advisory_xact_lock($1::bigint) locked', [KEYS.maintenance])
  ).rows[0];
  if (!lock?.locked) throw Error('Directory state preparation is blocked by active work.');
  if (
    (
      await client.query(
        'SELECT 1 FROM cartoteca_catalog.process_role_leases WHERE expires_at>clock_timestamp() LIMIT 1',
      )
    ).rows.length
  )
    throw Error('Directory state preparation requires stopped owners.');
  await client.query('SAVEPOINT ct_directory_state196');
  try {
    if ((await require('./revision-profile132.cjs').readRevisionProfile(client, role)) !== 3)
      throw Error('Directory state requires revision profile3.');
    for (const kind of ['platform', 'cabinet'])
      await validatePostgresSchema(client, { kind, applicationRole: role });
    const existing = await verifyDirectoryState196(client, role);
    let created = false,
      inserted = 0,
      resetHeads = 0;
    if (rollback) {
      if (existing) {
        await client.query(triggerSQL196(true));
        await client.query(`DROP FUNCTION ${FUNCTION196}(${ARG_TYPES196});
 DROP FUNCTION ${TRIGGER}(); DROP FUNCTION ${RECORD}(${RECORD_ARGS});
 DROP TABLE ${CHANGES}; DROP TABLE ${HEAD}; DROP TABLE ${META};`);
      }
    } else {
      if (
        !(await require('./read-scope-schema163.cjs').verifyReadScopes163(client, role)) ||
        !(await require('./directory-component164.cjs').verifyDirectory164(client, role)) ||
        !(await require('./hot-metadata-component169.cjs').verifyHotMetadata169(client, role))
      )
        throw Error('Directory state requires prepared163/164/169 components.');
      const registered = Number(
        (
          await client.query(
            `SELECT count(*)::text n FROM cartoteca_catalog.stores
 WHERE kind='cabinet' AND version=2 AND ($1::text[] IS NULL OR store_id=ANY($1))`,
            [selected],
          )
        ).rows[0].n,
      );
      if (
        !Number.isSafeInteger(registered) ||
        (selected !== null && registered !== selected.length)
      )
        throw Error('Directory state store coverage is invalid.');
      if (!existing) {
        await client.query(createDirectoryStateSQL196(role));
        await client.query(createDirectoryHotSQL196(role));
        const observed = await directoryStateSignature196(client, role);
        require('./directory-state-schema196.cjs').assertDirectoryStateSignature196(observed);
        await client.query(
          `INSERT INTO ${META}(version,epoch,signature,digest) VALUES(1,$1,$2,$3)`,
          [randomUUID(), observed, digest(observed)],
        );
        created = true;
      }
      const seeded = await client.query(
        `INSERT INTO ${HEAD}(store_id,last_xid)
 SELECT store_id,'0'::xid8 FROM cartoteca_catalog.stores WHERE kind='cabinet' AND version=2
 AND ($1::text[] IS NULL OR store_id=ANY($1)) ON CONFLICT DO NOTHING`,
        [selected],
      );
      inserted = seeded.rowCount;
      if (reset) {
        await client.query(`DELETE FROM ${CHANGES} WHERE $1::text[] IS NULL OR store_id=ANY($1)`, [
          selected,
        ]);
        const result = await client.query(
          `UPDATE ${HEAD} SET epoch=gen_random_uuid(),seq=1,floor_seq=1,
 reset_seq=1,last_xid='0'::xid8,change_count=0 WHERE $1::text[] IS NULL OR store_id=ANY($1)`,
          [selected],
        );
        resetHeads = result.rowCount;
      }
    }
    if (created || (rollback && existing)) await refreshManifests(client, ['cabinet']);
    const after = await verifyDirectoryState196(client, role);
    if (rollback ? after !== null : !after)
      throw Error('Directory state transition verification failed.');
    const heads = after
      ? Number((await client.query(`SELECT count(*)::text n FROM ${HEAD}`)).rows[0].n)
      : 0;
    await client.query('RELEASE SAVEPOINT ct_directory_state196');
    return {
      changed: rollback ? !!existing : created || inserted > 0 || resetHeads > 0,
      prepared: !rollback,
      preparedHeads: heads,
      headsInserted: inserted,
      headsReset: resetHeads,
      clinicalRowsChanged: 0,
      dataCopiesCreated: 0,
      ...(after || {}),
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK TO SAVEPOINT ct_directory_state196');
      await client.query('RELEASE SAVEPOINT ct_directory_state196');
    } catch {
      error.outcomeUnknown = true;
    }
    throw error;
  }
}
module.exports = { prepareDirectoryState196 };
