const { META, variants199 } = require('./catalog-image-sql199.cjs');
const table = META.split('.')[1];
const functionNames = Object.values(variants199).map((v) => v.functionName.split('.')[1]);
async function readCatalogImageSignature199(client, role) {
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
 WHERE n.nspname='cartoteca_catalog' AND p.proname=ANY($2::text[]) ORDER BY p.proname,p.oid`,
      [role, functionNames],
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
module.exports = { readCatalogImageSignature199 };
