const { digest } = require('./catalog-sqlite.cjs');
const { KEYS } = require('./lock-intents.cjs');
const { validatePostgresSchema } = require('./catalog-postgres.cjs');
const { readRevisionProfile } = require('./revision-profile132.cjs');
const { refreshManifests } = require('./revision-operator132.cjs');
const {
  READY_KEY,
  projectionKey,
  encodeProjection,
} = require('../cabinet-directory-projection164.cjs');
const FUNCTION = 'cartoteca_catalog.invalidate_directory164';
const TARGET = 'cartoteca_cabinet.cabinet_summaries';
const MAX_ROW_BYTES = 16 * 1024 * 1024;
const body = `
BEGIN
 IF TG_OP='TRUNCATE' THEN
  DELETE FROM cartoteca_cabinet.meta WHERE key LIKE 'directory164:%';
  RETURN NULL;
 END IF;
 IF TG_OP<>'INSERT' THEN
  DELETE FROM cartoteca_cabinet.meta WHERE _store_id=OLD._store_id AND
   key='directory164:'||encode(sha256(convert_to(OLD.patient_id,'UTF8')),'hex')||':'||OLD.audience;
 END IF;
 IF TG_OP<>'DELETE' THEN
  DELETE FROM cartoteca_cabinet.meta WHERE _store_id=NEW._store_id AND
   key='directory164:'||encode(sha256(convert_to(NEW.patient_id,'UTF8')),'hex')||':'||NEW.audience;
 END IF;
 RETURN NULL;
END `;
const invalid = () =>
  Object.assign(Error('Prepared directory component is invalid.'), {
    status: 503,
    code: 'POSTGRES_DIRECTORY_COMPONENT_INVALID',
  });
async function verifyDirectory164(client, applicationRole) {
  const functions = (
    await client.query(
      `SELECT p.oid::text oid,p.prosrc,p.prosecdef,p.proconfig,p.pronargs,p.prorettype::regtype::text result,
    p.proowner,pg_has_role($1,p.proowner,'MEMBER') member_owner,
    has_function_privilege($1,p.oid,'EXECUTE') app_execute,
    EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner) extra_acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='cartoteca_catalog' AND p.proname='invalidate_directory164'`,
      [applicationRole],
    )
  ).rows;
  const triggers = (
    await client.query(`SELECT n.nspname,c.relname,t.tgname,t.tgenabled,t.tgtype,encode(t.tgargs,'hex') args,t.tgfoid::text function_oid
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE NOT t.tgisinternal AND (t.tgname IN('ct_directory164','ct_directory_truncate164') OR p.proname='invalidate_directory164')
    ORDER BY n.nspname,c.relname,t.tgname`)
  ).rows;
  if (!functions.length && !triggers.length) return null;
  if (functions.length !== 1 || triggers.length !== 2) throw invalid();
  const fn = functions[0];
  if (
    fn.prosrc !== body ||
    !fn.prosecdef ||
    JSON.stringify(fn.proconfig) !== '["search_path=pg_catalog"]' ||
    fn.pronargs !== 0 ||
    fn.result !== 'trigger' ||
    fn.member_owner ||
    fn.app_execute ||
    fn.extra_acl
  )
    throw invalid();
  for (const [name, type] of [
    ['ct_directory164', 29],
    ['ct_directory_truncate164', 32],
  ]) {
    const found = triggers.find((row) => row.tgname === name);
    if (
      !found ||
      found.nspname !== 'cartoteca_cabinet' ||
      found.relname !== 'cabinet_summaries' ||
      found.tgenabled !== 'O' ||
      found.tgtype !== type ||
      found.args !== '' ||
      found.function_oid !== fn.oid
    )
      throw invalid();
  }
  return { version: 1, digest: digest({ functions, triggers }) };
}
async function backfill(client, { storeId, ciphers }) {
  if (
    typeof storeId !== 'string' ||
    !storeId ||
    !ciphers ||
    !['encode', 'decode', 'hash'].every((name) => typeof ciphers[name] === 'function')
  )
    throw Error('Directory preparation requires store ciphers.');
  const registered = (
    await client.query(
      "SELECT version FROM cartoteca_catalog.stores WHERE kind='cabinet' AND store_id=$1 FOR UPDATE",
      [storeId],
    )
  ).rows;
  if (registered.length !== 1 || ![1, 2].includes(Number(registered[0].version)))
    throw Error('Directory preparation store is not registered.');
  await client.query(
    "SELECT set_config('cartoteca.kind','cabinet',true),set_config('cartoteca.store_id',$1,true)",
    [storeId],
  );
  await client.query(
    "DELETE FROM cartoteca_cabinet.meta WHERE _store_id=$1 AND (key LIKE 'directory164:%' OR key=$2)",
    [storeId, READY_KEY],
  );
  let cursor = null,
    audience = null,
    count = 0;
  for (;;) {
    const metadata = (
      await client.query(
        `SELECT patient_id,audience,octet_length(value)::text bytes FROM ${TARGET}
      WHERE _store_id=$1 AND ($2::text IS NULL OR (patient_id COLLATE "C",audience COLLATE "C") > ($2::text COLLATE "C",$3::text COLLATE "C"))
      ORDER BY patient_id COLLATE "C",audience COLLATE "C" LIMIT 64 FOR UPDATE`,
        [storeId, cursor, audience],
      )
    ).rows;
    if (!metadata.length) break;
    for (const row of metadata) {
      if (!/^[0-9]+$/.test(row.bytes) || Number(row.bytes) > MAX_ROW_BYTES)
        throw Error('Directory source exceeds the preparation row bound.');
      const source = (
        await client.query(
          `SELECT value FROM ${TARGET} WHERE _store_id=$1 AND patient_id=$2 AND audience=$3`,
          [storeId, row.patient_id, row.audience],
        )
      ).rows;
      if (source.length !== 1 || source[0].value.length !== Number(row.bytes))
        throw Error('Directory preparation source changed.');
      const summary = ciphers.decode(source[0].value);
      if (summary?.id !== row.patient_id || !Array.isArray(summary.appointments))
        throw Error('Directory source summary identity mismatch.');
      const encoded = encodeProjection(summary, row.audience, source[0].value, ciphers);
      await client.query(
        'INSERT INTO cartoteca_cabinet.meta(_store_id,key,value) VALUES($1,$2,$3) ON CONFLICT(_store_id,key) DO UPDATE SET value=excluded.value',
        [storeId, projectionKey(row.patient_id, row.audience), encoded],
      );
      count++;
    }
    const last = metadata.at(-1);
    cursor = last.patient_id;
    audience = last.audience;
  }
  await client.query(
    'INSERT INTO cartoteca_cabinet.meta(_store_id,key,value) VALUES($1,$2,$3) ON CONFLICT(_store_id,key) DO UPDATE SET value=excluded.value',
    [storeId, READY_KEY, ciphers.encode({ version: 1 })],
  );
  return count;
}
// Explicit SQL-only offline preparation. The caller owns BEGIN/COMMIT and assets.
async function prepareDirectory164(
  client,
  applicationRole,
  { stores = [], rollback = false } = {},
) {
  const authority = (
    await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
  ).rows[0];
  if (!authority || (!authority.rolsuper && !authority.rolbypassrls))
    throw Error('Directory preparation requires offline catalog authority.');
  const held = (
    await client.query('SELECT pg_try_advisory_xact_lock($1::bigint) locked', [KEYS.maintenance])
  ).rows[0];
  if (!held?.locked) throw Error('Directory preparation is blocked by active application work.');
  if (
    (
      await client.query(
        'SELECT 1 FROM cartoteca_catalog.process_role_leases WHERE expires_at>clock_timestamp() LIMIT 1',
      )
    ).rows.length
  )
    throw Error('Directory preparation requires stopped process owners.');
  if (
    !Array.isArray(stores) ||
    stores.length > 100000 ||
    new Set(stores.map((store) => store.storeId)).size !== stores.length
  )
    throw Error('Invalid directory preparation stores.');
  await client.query('SAVEPOINT ct_directory_prepare164');
  try {
    if ((await readRevisionProfile(client, applicationRole)) !== 3)
      throw Error('Directory component requires revision profile3.');
    for (const kind of ['platform', 'cabinet'])
      await validatePostgresSchema(client, { kind, applicationRole });
    const existing = await verifyDirectory164(client, applicationRole);
    let rows = 0;
    if (rollback) {
      await client.query(
        "DELETE FROM cartoteca_cabinet.meta WHERE key LIKE 'directory164:%' OR key=$1",
        [READY_KEY],
      );
      if (existing)
        await client.query(
          `DROP TRIGGER ct_directory164 ON ${TARGET}; DROP TRIGGER ct_directory_truncate164 ON ${TARGET}; DROP FUNCTION ${FUNCTION}();`,
        );
    } else {
      if (!existing)
        await client.query(`CREATE FUNCTION ${FUNCTION}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$${body}$body$;
        REVOKE ALL ON FUNCTION ${FUNCTION}() FROM PUBLIC;
        CREATE TRIGGER ct_directory164 AFTER INSERT OR UPDATE OR DELETE ON ${TARGET} FOR EACH ROW EXECUTE FUNCTION ${FUNCTION}();
        CREATE TRIGGER ct_directory_truncate164 AFTER TRUNCATE ON ${TARGET} FOR EACH STATEMENT EXECUTE FUNCTION ${FUNCTION}();`);
      for (const store of [...stores].sort((a, b) => a.storeId.localeCompare(b.storeId)))
        rows += await backfill(client, store);
    }
    await refreshManifests(client, ['cabinet']);
    const after = await verifyDirectory164(client, applicationRole);
    if (rollback ? after !== null : !after)
      throw Error('Directory transition verification failed.');
    await client.query('RELEASE SAVEPOINT ct_directory_prepare164');
    return {
      changed: rollback ? !!existing : !existing || stores.length > 0,
      prepared: !rollback,
      stores: rollback ? 0 : stores.length,
      summaries: rows,
      clinicalRowsChanged: 0,
      dataCopiesCreated: 0,
      ...after,
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK TO SAVEPOINT ct_directory_prepare164');
      await client.query('RELEASE SAVEPOINT ct_directory_prepare164');
    } catch {
      error.outcomeUnknown = true;
    }
    throw error;
  }
}
module.exports = { verifyDirectory164, prepareDirectory164 };
