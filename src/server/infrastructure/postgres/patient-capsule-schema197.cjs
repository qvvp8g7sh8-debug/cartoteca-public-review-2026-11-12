const { digest } = require('./catalog-sqlite.cjs');
const { verifyHotMetadata169 } = require('./hot-metadata-component169.cjs');
const {
  META,
  FUNCTION,
  ARG_TYPES,
  RETURN_COLUMNS,
  functionBody197,
} = require('./patient-capsule-sql197.cjs');
const table = META.split('.')[1],
  functionName = FUNCTION.split('.')[1];
const invalid197 = () =>
  Object.assign(Error('Prepared patient capsule is invalid.'), {
    status: 503,
    code: 'POSTGRES_PATIENT_CAPSULE_COMPONENT_INVALID197',
  });
async function signaturePatientCapsule197(client, role) {
  const definitions = (
    await client.query(
      `SELECT c.relname,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,
 pg_get_userbyid(c.relowner) owner,pg_has_role($1,c.relowner,'MEMBER') member_owner,
 ARRAY[has_table_privilege($1,c.oid,'SELECT'),has_table_privilege($1,c.oid,'INSERT'),has_table_privilege($1,c.oid,'UPDATE'),
 has_table_privilege($1,c.oid,'DELETE'),has_table_privilege($1,c.oid,'TRUNCATE'),has_table_privilege($1,c.oid,'REFERENCES'),has_table_privilege($1,c.oid,'TRIGGER')] privileges,
 ARRAY[has_any_column_privilege($1,c.oid,'SELECT'),has_any_column_privilege($1,c.oid,'INSERT'),has_any_column_privilege($1,c.oid,'UPDATE'),has_any_column_privilege($1,c.oid,'REFERENCES')] column_privileges,
 EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner
 AND(a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$1) OR a.is_grantable)) unexpected_acl
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='cartoteca_catalog' AND c.relname=$2`,
      [role, table],
    )
  ).rows;
  const columns = (
    await client.query(
      `SELECT a.attname,format_type(a.atttypid,a.atttypmod) type,a.attnotnull,a.attidentity,a.attgenerated,
 pg_get_expr(d.adbin,d.adrelid) default_value,coll.collname collation
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
 LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
 LEFT JOIN pg_collation coll ON coll.oid=a.attcollation
 WHERE n.nspname='cartoteca_catalog' AND c.relname=$1 ORDER BY a.attnum`,
      [table],
    )
  ).rows;
  const constraints = (
    await client.query(
      `SELECT p.conname,p.contype,pg_get_constraintdef(p.oid,true) definition
 FROM pg_constraint p JOIN pg_class c ON c.oid=p.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='cartoteca_catalog' AND c.relname=$1 ORDER BY p.conname`,
      [table],
    )
  ).rows;
  const policies = (
    await client.query(
      `SELECT policyname,roles::text[] AS roles,cmd,qual,with_check FROM pg_policies
 WHERE schemaname='cartoteca_catalog' AND tablename=$1 ORDER BY policyname`,
      [table],
    )
  ).rows;
  const functions = (
    await client.query(
      `SELECT p.proname,p.prosrc,p.prosecdef,p.proconfig,p.pronargs,pg_get_userbyid(p.proowner) owner,l.lanname,
 p.prorettype::regtype::text result,p.proretset,p.provolatile,p.proparallel,p.proleakproof,p.proisstrict,
 p.proargnames,p.proargmodes::text[] proargmodes,oidvectortypes(p.proargtypes) input_types,
 ARRAY(SELECT format_type(t,NULL) FROM unnest(p.proallargtypes) t) all_types,
 pg_has_role($1,p.proowner,'MEMBER') member_owner,r.rolsuper owner_super,r.rolbypassrls owner_bypass,
 has_function_privilege($1,p.oid,'EXECUTE') app_execute,
 EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
 AND(a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$1) OR a.is_grantable)) unexpected_acl
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 JOIN pg_language l ON l.oid=p.prolang JOIN pg_roles r ON r.oid=p.proowner
 WHERE n.nspname='cartoteca_catalog' AND p.proname=$2 ORDER BY p.oid`,
      [role, functionName],
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
function assertPatientCapsuleSignature197(s, role) {
  if (
    s.definitions.length !== 1 ||
    s.functions.length !== 1 ||
    s.appRole.length !== 1 ||
    s.appRole[0].rolsuper ||
    s.appRole[0].rolbypassrls ||
    s.appRole[0].schema_create
  )
    throw invalid197();
  const fn = s.functions[0],
    definition = s.definitions[0],
    inputs = [
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
      'p_session',
      'p_role',
      'p_kind',
      'p_patient',
      'p_appointment',
      'p_audience',
      'p_cursors',
      'p_capsule_epoch',
      'p_capsule_digest',
    ],
    returns = RETURN_COLUMNS.split(',').map((v) => v.trim().split(/\s+/));
  if (
    fn.proname !== functionName ||
    fn.prosrc !== functionBody197 ||
    fn.pronargs !== 23 ||
    !fn.prosecdef ||
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
    fn.input_types.replaceAll(', ', ',') !== ARG_TYPES ||
    JSON.stringify(fn.proargnames) !== JSON.stringify([...inputs, ...returns.map((r) => r[0])]) ||
    JSON.stringify(fn.proargmodes) !==
      JSON.stringify([...inputs.map(() => 'i'), ...returns.map(() => 't')]) ||
    JSON.stringify(fn.all_types) !==
      JSON.stringify([...ARG_TYPES.split(','), ...returns.map((r) => r[1])])
  )
    throw invalid197();
  if (
    definition.relname !== table ||
    definition.relkind !== 'r' ||
    definition.relpersistence !== 'p' ||
    !definition.relrowsecurity ||
    !definition.relforcerowsecurity ||
    definition.owner !== fn.owner ||
    definition.member_owner ||
    definition.unexpected_acl ||
    JSON.stringify(definition.privileges) !== '[true,false,false,false,false,false,false]' ||
    JSON.stringify(definition.column_privileges) !== '[true,false,false,false]'
  )
    throw invalid197();
  // PostgreSQL18 also catalogs NOT NULL constraints. The column check below
  // remains exact; the component owns one primary key and two CHECKs.
  const structural = s.constraints.filter((c) => c.contype !== 'n');
  if (
    JSON.stringify(s.columns.map((c) => [c.attname, c.type])) !==
      '[["version","bigint"],["epoch","uuid"],["signature","jsonb"],["digest","text"]]' ||
    s.columns.some(
      (c) => !c.attnotnull || c.attidentity || c.attgenerated || c.default_value !== null,
    ) ||
    s.constraints.some((c) => !['p', 'c', 'n'].includes(c.contype)) ||
    structural.length !== 3 ||
    structural.filter((c) => c.contype === 'p').length !== 1 ||
    structural.filter((c) => c.contype === 'c').length !== 2 ||
    s.policies.length !== 2
  )
    throw invalid197();
  const reader = s.policies.find((p) => p.policyname === 'read_patient_component197'),
    owner = s.policies.find((p) => p.policyname === 'owner_patient_component197');
  if (
    !reader ||
    !owner ||
    JSON.stringify(reader.roles) !== JSON.stringify([role]) ||
    reader.cmd !== 'SELECT' ||
    reader.qual !== 'true' ||
    reader.with_check !== null ||
    JSON.stringify(owner.roles) !== JSON.stringify([fn.owner]) ||
    owner.cmd !== 'ALL' ||
    owner.qual !== 'true' ||
    owner.with_check !== 'true'
  )
    throw invalid197();
}
async function verifyPatientCapsule197(client, role) {
  const present = (
    await client.query(
      `SELECT to_regclass($1)::text component,
 (SELECT count(*)::integer FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='cartoteca_catalog' AND p.proname=$2) functions`,
      [META, functionName],
    )
  ).rows[0];
  if (!present.component && present.functions === 0) return null;
  if (!present.component || present.functions !== 1) throw invalid197();
  const actual = await signaturePatientCapsule197(client, role);
  assertPatientCapsuleSignature197(actual, role);
  const rows = (await client.query(`SELECT version,epoch::text,signature,digest FROM ${META}`))
    .rows;
  if (
    rows.length !== 1 ||
    Number(rows[0].version) !== 1 ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(rows[0].epoch || '') ||
    !/^[a-f0-9]{64}$/.test(rows[0].digest || '') ||
    digest(rows[0].signature) !== rows[0].digest ||
    digest(actual) !== rows[0].digest
  )
    throw invalid197();
  const hotMetadata169 = await verifyHotMetadata169(client, role);
  if (!hotMetadata169) throw invalid197();
  return Object.freeze({
    version: 1,
    epoch: rows[0].epoch,
    digest: rows[0].digest,
    hotMetadata169,
  });
}
module.exports = {
  invalid197,
  signaturePatientCapsule197,
  assertPatientCapsuleSignature197,
  verifyPatientCapsule197,
};
