const { digest } = require('./catalog-sqlite.cjs');
const { validateRuntimeProfile } = require('./runtime.cjs');
const { verifyReadScopes163 } = require('./read-scope-schema163.cjs');
const { META, TABLE, functionBody169, RETURN_COLUMNS } = require('./hot-metadata-sql169.cjs');
const invalid169 = () =>
  Object.assign(Error('Prepared hot metadata component is invalid.'), {
    status: 503,
    code: 'POSTGRES_HOT_METADATA_COMPONENT_INVALID169',
  });
const uuid169 = (s) =>
  typeof s === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s);
const hash169 = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const tables169 = ['hot_read_bindings169', 'hot_read_component169'];
async function signatureHotMetadata169(client, role) {
  const definitions = (
    await client.query(
      `SELECT c.relname,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,c.relowner,
   pg_has_role($1,c.relowner,'MEMBER') member_owner,
   ARRAY[has_table_privilege($1,c.oid,'SELECT'),has_table_privilege($1,c.oid,'INSERT'),has_table_privilege($1,c.oid,'UPDATE'),
    has_table_privilege($1,c.oid,'DELETE'),has_table_privilege($1,c.oid,'TRUNCATE'),has_table_privilege($1,c.oid,'REFERENCES'),has_table_privilege($1,c.oid,'TRIGGER')] privileges,
   ARRAY[has_any_column_privilege($1,c.oid,'SELECT'),has_any_column_privilege($1,c.oid,'INSERT'),has_any_column_privilege($1,c.oid,'UPDATE'),has_any_column_privilege($1,c.oid,'REFERENCES')] column_privileges,
   EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
     WHERE a.grantee<>c.relowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$1) OR a.is_grantable)) unexpected_acl
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='cartoteca_catalog' AND c.relname=ANY($2::text[]) ORDER BY c.relname`,
      [role, tables169],
    )
  ).rows;
  const columns = (
    await client.query(
      `SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) type,a.attnotnull,a.attidentity,a.attgenerated,
   pg_get_expr(d.adbin,d.adrelid) default_value,coll.collname collation
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
   LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum LEFT JOIN pg_collation coll ON coll.oid=a.attcollation
   WHERE n.nspname='cartoteca_catalog' AND c.relname=ANY($1::text[]) ORDER BY c.relname,a.attnum`,
      [tables169],
    )
  ).rows;
  const constraints = (
    await client.query(
      `SELECT c.relname,p.conname,p.contype,pg_get_constraintdef(p.oid,true) definition
   FROM pg_constraint p JOIN pg_class c ON c.oid=p.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='cartoteca_catalog' AND c.relname=ANY($1::text[]) ORDER BY c.relname,p.conname`,
      [tables169],
    )
  ).rows;
  const policies = (
    await client.query(
      `SELECT tablename,policyname,roles,cmd,qual,with_check FROM pg_policies
   WHERE schemaname='cartoteca_catalog' AND tablename=ANY($1::text[]) ORDER BY tablename,policyname`,
      [tables169],
    )
  ).rows;
  const functions = (
    await client.query(
      `SELECT p.prosrc,p.prosecdef,p.proconfig,p.pronargs,p.proowner,l.lanname,p.prorettype::regtype::text result,
   p.proretset,p.provolatile,p.proparallel,p.proleakproof,p.proisstrict,p.proargnames,p.proargmodes::text[] proargmodes,
   ARRAY(SELECT format_type(t,NULL) FROM unnest(p.proallargtypes) t) all_types,
   pg_has_role($1,p.proowner,'MEMBER') member_owner,r.rolsuper owner_super,r.rolbypassrls owner_bypass,
   has_function_privilege($1,p.oid,'EXECUTE') app_execute,
   EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$1) OR a.is_grantable)) unexpected_acl
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang JOIN pg_roles r ON r.oid=p.proowner
   WHERE n.nspname='cartoteca_catalog' AND p.proname='hot_read_metadata169' ORDER BY p.oid`,
      [role],
    )
  ).rows;
  const appRole = (
    await client.query(
      `SELECT rolsuper,rolbypassrls,has_schema_privilege($1,'cartoteca_catalog','CREATE') schema_create
   FROM pg_roles WHERE rolname=$1`,
      [role],
    )
  ).rows;
  return { definitions, columns, constraints, policies, functions, appRole };
}
function assertSignature169(s) {
  if (
    s.definitions.length !== 2 ||
    s.functions.length !== 1 ||
    s.appRole.length !== 1 ||
    s.appRole[0].rolsuper ||
    s.appRole[0].rolbypassrls ||
    s.appRole[0].schema_create
  )
    throw invalid169();
  const fn = s.functions[0];
  const inputNames = [
    'p_platform',
    'p_migration',
    'p_marker_hash',
    'p_account',
    'p_org',
    'p_token_hash',
    'p_cabinet',
    'p_component_epoch',
    'p_component_digest',
    'p_p_version',
    'p_p_hash',
    'p_c_version',
    'p_c_hash',
    'p_authority_limit',
  ];
  const returns = RETURN_COLUMNS.split(',').map((s) => s.trim().split(/\s+/));
  const types = [
    ...inputNames.map((_, i) => ([9, 11, 13].includes(i) ? 'bigint' : 'text')),
    ...returns.map((r) => r[1]),
  ];
  if (
    fn.prosrc !== functionBody169 ||
    !fn.prosecdef ||
    fn.pronargs !== 14 ||
    fn.lanname !== 'plpgsql' ||
    fn.result !== 'record' ||
    !fn.proretset ||
    fn.provolatile !== 'v' ||
    fn.proparallel !== 'u' ||
    fn.proleakproof ||
    fn.proisstrict ||
    fn.member_owner ||
    !fn.app_execute ||
    fn.unexpected_acl ||
    (!fn.owner_super && !fn.owner_bypass) ||
    JSON.stringify(fn.proconfig) !== '["search_path=pg_catalog, pg_temp"]' ||
    JSON.stringify(fn.proargnames) !==
      JSON.stringify([...inputNames, ...returns.map((r) => r[0])]) ||
    JSON.stringify(fn.proargmodes) !==
      JSON.stringify([...inputNames.map(() => 'i'), ...returns.map(() => 't')]) ||
    JSON.stringify(fn.all_types) !== JSON.stringify(types)
  )
    throw invalid169();
  for (const d of s.definitions) {
    const readable = d.relname === 'hot_read_component169';
    if (
      d.relkind !== 'r' ||
      d.relpersistence !== 'p' ||
      !d.relrowsecurity ||
      !d.relforcerowsecurity ||
      d.member_owner ||
      d.unexpected_acl ||
      d.relowner !== fn.proowner ||
      JSON.stringify(d.privileges) !==
        JSON.stringify([readable, false, false, false, false, false, false]) ||
      JSON.stringify(d.column_privileges) !== JSON.stringify([readable, false, false, false])
    )
      throw invalid169();
  }
  const expected = {
    hot_read_component169: [
      ['version', 'bigint'],
      ['epoch', 'uuid'],
      ['signature', 'jsonb'],
      ['digest', 'text'],
      ['prepared_generations', 'jsonb'],
    ],
    hot_read_bindings169: [
      ['platform_store_id', 'text'],
      ['organization_id', 'text'],
      ['cabinet_store_id', 'text'],
      ['migration_id', 'text'],
      ['marker_hash', 'text'],
      ['binding_epoch', 'uuid'],
      ['platform_version', 'bigint'],
      ['platform_hash', 'text'],
      ['cabinet_version', 'bigint'],
      ['cabinet_hash', 'text'],
      ['binding_proof', 'text'],
    ],
  };
  for (const [table, fields] of Object.entries(expected)) {
    const columns = s.columns.filter((c) => c.relname === table);
    if (
      JSON.stringify(columns.map((c) => [c.attname, c.type])) !== JSON.stringify(fields) ||
      columns.some(
        (c) => !c.attnotnull || c.attidentity || c.attgenerated || c.default_value !== null,
      )
    )
      throw invalid169();
  }
  if (
    s.constraints.some((c) => c.contype === 'f') ||
    s.constraints.filter((c) => c.contype === 'p').length !== 2 ||
    s.constraints.filter((c) => c.contype === 'u').length !== 1 ||
    s.policies.length !== 3
  )
    throw invalid169();
  const names = s.policies.map((p) => p.policyname).sort();
  if (JSON.stringify(names) !== '["owner_binding169","owner_component169","read_component169"]')
    throw invalid169();
}
async function verifyHotMetadata169(client, role, { marker } = {}) {
  const present = (
    await client.query(
      `SELECT to_regclass($1)::text component,to_regclass($2)::text bindings,
   (SELECT count(*)::integer FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='cartoteca_catalog' AND p.proname='hot_read_metadata169') functions`,
      [META, TABLE],
    )
  ).rows[0];
  if (!present.component && !present.bindings && present.functions === 0) return null;
  if (!present.component || !present.bindings || present.functions !== 1) throw invalid169();
  const actual = await signatureHotMetadata169(client, role);
  assertSignature169(actual);
  const rows = (
    await client.query(
      `SELECT version,epoch::text,signature,digest,prepared_generations FROM ${META}`,
    )
  ).rows;
  if (
    rows.length !== 1 ||
    Number(rows[0].version) !== 1 ||
    !uuid169(rows[0].epoch) ||
    !hash169(rows[0].digest) ||
    digest(rows[0].signature) !== rows[0].digest ||
    digest(actual) !== rows[0].digest
  )
    throw invalid169();
  const generations = rows[0].prepared_generations;
  if (
    !generations ||
    typeof generations !== 'object' ||
    Array.isArray(generations) ||
    Object.keys(generations).length > 100000 ||
    Object.entries(generations).some(
      ([p, g]) =>
        !uuid169(p) ||
        !g ||
        typeof g !== 'object' ||
        Array.isArray(g) ||
        JSON.stringify(Object.keys(g).sort()) !== '["markerHash","migrationId"]' ||
        !uuid169(g.migrationId) ||
        !hash169(g.markerHash),
    )
  )
    throw invalid169();
  const readScopes = await verifyReadScopes163(client, role);
  if (!readScopes) throw invalid169();
  let eligibleMarker = null;
  if (marker) {
    validateRuntimeProfile(marker);
    const generation = generations[marker.platformStoreId];
    eligibleMarker =
      !!generation &&
      generation.migrationId === marker.migrationId &&
      generation.markerHash === digest(marker);
  }
  return {
    version: 1,
    epoch: rows[0].epoch,
    digest: rows[0].digest,
    readScopes: { epoch: readScopes.epoch, digest: readScopes.digest },
    eligibleMarker,
  };
}
module.exports = {
  signatureHotMetadata169,
  verifyHotMetadata169,
  assertSignature169,
  invalid169,
  uuid169,
  hash169,
};
