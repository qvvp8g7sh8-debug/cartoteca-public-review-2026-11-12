const { digest } = require('./catalog-sqlite.cjs');
const { TABLE, META, body, trackedTables } = require('./read-scope-sql163.cjs');
const invalid = () =>
  Object.assign(Error('Prepared read scope component is invalid.'), {
    status: 503,
    code: 'POSTGRES_READ_SCOPE_COMPONENT_INVALID',
  });
async function signature(client, role) {
  const tables = ['read_scope_versions163', 'read_scope_component163'];
  const definitions = (
    await client.query(
      `SELECT c.relname,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,c.relowner,
    pg_has_role($1,c.relowner,'MEMBER') member_owner,
    ARRAY[has_table_privilege($1,c.oid,'SELECT'),has_table_privilege($1,c.oid,'INSERT'),has_table_privilege($1,c.oid,'UPDATE'),has_table_privilege($1,c.oid,'DELETE'),has_table_privilege($1,c.oid,'TRUNCATE'),has_table_privilege($1,c.oid,'TRIGGER')] privileges
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='cartoteca_catalog' AND c.relname=ANY($2::text[]) ORDER BY c.relname`,
      [role, tables],
    )
  ).rows;
  if (
    definitions.length !== 2 ||
    definitions.some(
      (t) =>
        t.relkind !== 'r' ||
        t.relpersistence !== 'p' ||
        !t.relrowsecurity ||
        !t.relforcerowsecurity ||
        t.member_owner ||
        JSON.stringify(t.privileges) !== '[true,false,false,false,false,false]',
    )
  )
    throw invalid();
  const columns = (
    await client.query(
      `SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) type,a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid) default_value
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='cartoteca_catalog' AND c.relname=ANY($1::text[]) ORDER BY c.relname,a.attnum`,
      [tables],
    )
  ).rows;
  const constraints = (
    await client.query(
      `SELECT c.relname,p.conname,p.contype,pg_get_constraintdef(p.oid,true) definition FROM pg_constraint p JOIN pg_class c ON c.oid=p.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='cartoteca_catalog' AND c.relname=ANY($1::text[]) ORDER BY c.relname,p.conname`,
      [tables],
    )
  ).rows;
  const policies = (
    await client.query(
      `SELECT tablename,policyname,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='cartoteca_catalog' AND tablename=ANY($1::text[]) ORDER BY tablename,policyname`,
      [tables],
    )
  ).rows;
  const functions = (
    await client.query(
      `SELECT p.prosrc,p.prosecdef,p.proconfig,p.pronargs,p.prorettype::regtype::text result,p.proowner,
    has_function_privilege($1,p.oid,'EXECUTE') app_execute,
    EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner) extra_acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='cartoteca_catalog' AND p.proname='bump_read_scope163'`,
      [role],
    )
  ).rows;
  if (functions.length !== 1) throw invalid();
  const fn = functions[0];
  if (
    fn.prosrc !== body ||
    !fn.prosecdef ||
    JSON.stringify(fn.proconfig) !== '["search_path=pg_catalog"]' ||
    fn.pronargs !== 0 ||
    fn.result !== 'trigger' ||
    fn.app_execute ||
    fn.extra_acl ||
    definitions.some((t) => t.relowner !== fn.proowner)
  )
    throw invalid();
  const triggers = (
    await client.query(`SELECT n.nspname,c.relname,t.tgname,t.tgenabled,t.tgtype,encode(t.tgargs,'hex') args,p.proname
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE NOT t.tgisinternal AND (t.tgname IN('ct_read_scope163','ct_read_truncate163') OR p.proname='bump_read_scope163') ORDER BY n.nspname,c.relname,t.tgname`)
  ).rows;
  return { definitions, columns, constraints, policies, functions, triggers };
}
async function expectedTables(client) {
  const rows = (
    await client.query(
      "SELECT kind,metadata FROM cartoteca_catalog.templates WHERE kind IN('platform','cabinet') ORDER BY kind,version",
    )
  ).rows;
  const catalogs = {};
  for (const row of rows) {
    catalogs[row.kind] ||= { tables: {} };
    Object.assign(catalogs[row.kind].tables, row.metadata.tables);
  }
  return trackedTables(catalogs);
}
async function verifyReadScopes163(client, role) {
  const exists = (
    await client.query(
      'SELECT to_regclass($1)::text AS versions,to_regclass($2)::text AS component',
      [TABLE, META],
    )
  ).rows[0];
  if (!exists.versions && !exists.component) return null;
  if (!exists.versions || !exists.component) throw invalid();
  const actual = await signature(client, role);
  const row = (await client.query(`SELECT version,epoch::text,signature,digest FROM ${META}`)).rows;
  if (
    row.length !== 1 ||
    Number(row[0].version) !== 1 ||
    digest(row[0].signature) !== row[0].digest ||
    digest(actual) !== row[0].digest
  )
    throw invalid();
  const expected = await expectedTables(client);
  if (actual.triggers.length !== expected.length * 2) throw invalid();
  for (const item of expected)
    for (const [name, type] of [
      ['ct_read_scope163', 29],
      ['ct_read_truncate163', 32],
    ]) {
      const found = actual.triggers.find(
        (t) =>
          t.nspname === 'cartoteca_' + item.kind && t.relname === item.table && t.tgname === name,
      );
      const args = Buffer.from(item.kind + '\0' + item.scope + '\0').toString('hex');
      if (
        !found ||
        found.tgenabled !== 'O' ||
        found.tgtype !== type ||
        found.args !== args ||
        found.proname !== 'bump_read_scope163'
      )
        throw invalid();
    }
  return { version: 1, epoch: row[0].epoch, digest: row[0].digest };
}
module.exports = { signature, expectedTables, verifyReadScopes163 };
