const { digest } = require('./catalog-sqlite.cjs');
const {
  META,
  HEAD,
  CHANGES,
  recordBody196,
  triggerBody196,
  MAX_CHANGES,
  SEQ_WINDOW,
} = require('./directory-state-sql196.cjs');
const {
  functionBody196,
  ARG_TYPES196,
  RETURN_COLUMNS196,
} = require('./directory-state-hot-sql196.cjs');
const tables = [META, HEAD, CHANGES].map((name) => name.split('.')[1]).sort();
const functions = [
  'record_directory_state196',
  'change_directory_state196',
  'hot_directory_metadata196',
];
const invalid196 = () =>
  Object.assign(Error('Prepared directory state is invalid.'), {
    status: 503,
    code: 'POSTGRES_DIRECTORY_STATE_INVALID',
  });
async function directoryStateSignature196(client, role) {
  const definitions = (
    await client.query(
      `SELECT c.relname,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) relowner,
 pg_has_role($1,c.relowner,'MEMBER') member_owner,
 ARRAY[has_table_privilege($1,c.oid,'SELECT'),has_table_privilege($1,c.oid,'INSERT'),has_table_privilege($1,c.oid,'UPDATE'),
 has_table_privilege($1,c.oid,'DELETE'),has_table_privilege($1,c.oid,'TRUNCATE'),has_table_privilege($1,c.oid,'REFERENCES'),has_table_privilege($1,c.oid,'TRIGGER')] privileges,
 ARRAY[has_any_column_privilege($1,c.oid,'SELECT'),has_any_column_privilege($1,c.oid,'INSERT'),has_any_column_privilege($1,c.oid,'UPDATE'),has_any_column_privilege($1,c.oid,'REFERENCES')] column_privileges,
 EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner
 AND(a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$1) OR a.is_grantable)) unexpected_acl
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='cartoteca_catalog'
 AND c.relname=ANY($2::text[]) ORDER BY c.relname`,
      [role, tables],
    )
  ).rows;
  const columns = (
    await client.query(
      `SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) type,
 a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid) default_value,coll.collname collation
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
 LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum LEFT JOIN pg_collation coll ON coll.oid=a.attcollation
 WHERE n.nspname='cartoteca_catalog' AND c.relname=ANY($1::text[]) ORDER BY c.relname,a.attnum`,
      [tables],
    )
  ).rows;
  const constraints = (
    await client.query(
      `SELECT c.relname,p.conname,p.contype,pg_get_constraintdef(p.oid,true) definition
 FROM pg_constraint p JOIN pg_class c ON c.oid=p.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='cartoteca_catalog' AND c.relname=ANY($1::text[]) ORDER BY c.relname,p.conname`,
      [tables],
    )
  ).rows;
  const policies = (
    await client.query(
      `SELECT tablename,policyname,roles,cmd,qual,with_check FROM pg_policies
 WHERE schemaname='cartoteca_catalog' AND tablename=ANY($1::text[]) ORDER BY tablename,policyname`,
      [tables],
    )
  ).rows;
  const fns = (
    await client.query(
      `SELECT p.proname,p.prosrc,p.prosecdef,p.proconfig,p.pronargs,pg_get_userbyid(p.proowner) proowner,l.lanname,
 p.prorettype::regtype::text result,p.proretset,p.provolatile,p.proparallel,p.proleakproof,p.proisstrict,
 p.proargnames,p.proargmodes::text[] proargmodes,oidvectortypes(p.proargtypes) input_types,
 ARRAY(SELECT format_type(t,NULL) FROM unnest(p.proallargtypes) t) all_types,
 pg_has_role($1,p.proowner,'MEMBER') member_owner,r.rolsuper owner_super,r.rolbypassrls owner_bypass,
 has_function_privilege($1,p.oid,'EXECUTE') app_execute,
 EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
 AND(a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$1) OR a.is_grantable)) unexpected_acl
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang JOIN pg_roles r ON r.oid=p.proowner
 WHERE n.nspname='cartoteca_catalog' AND p.proname=ANY($2::text[]) ORDER BY p.proname,p.oid`,
      [role, functions],
    )
  ).rows;
  const triggers = (
    await client.query(`SELECT n.nspname,c.relname,t.tgname,t.tgenabled,t.tgtype,encode(t.tgargs,'hex') args,p.proname
 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
 WHERE NOT t.tgisinternal AND(t.tgname IN('ct_directory_state196','ct_directory_state_truncate196') OR p.proname='change_directory_state196')
 ORDER BY n.nspname,c.relname,t.tgname`)
  ).rows;
  const appRole = (
    await client.query(
      `SELECT rolsuper,rolbypassrls,
 has_schema_privilege($1,'cartoteca_catalog','CREATE') schema_create FROM pg_roles WHERE rolname=$1`,
      [role],
    )
  ).rows;
  return { definitions, columns, constraints, policies, functions: fns, triggers, appRole };
}
function assertDirectoryStateSignature196(s) {
  if (
    s.definitions.length !== 3 ||
    s.functions.length !== 3 ||
    s.triggers.length !== 4 ||
    s.appRole.length !== 1 ||
    s.appRole[0].rolsuper ||
    s.appRole[0].rolbypassrls ||
    s.appRole[0].schema_create
  )
    throw invalid196();
  const expectedFunctions = {
    record_directory_state196: [
      recordBody196,
      'void',
      'text,text,text,text,boolean,boolean,boolean',
      false,
    ],
    change_directory_state196: [triggerBody196, 'trigger', '', false],
    hot_directory_metadata196: [functionBody196, 'record', ARG_TYPES196, true],
  };
  let owner;
  for (const fn of s.functions) {
    const expected = expectedFunctions[fn.proname];
    if (
      !expected ||
      fn.prosrc !== expected[0] ||
      fn.result !== expected[1] ||
      fn.input_types.replaceAll(', ', ',') !== expected[2] ||
      fn.app_execute !== expected[3] ||
      !fn.prosecdef ||
      fn.lanname !== 'plpgsql' ||
      fn.provolatile !== 'v' ||
      fn.proparallel !== 'u' ||
      fn.proretset !== expected[3] ||
      fn.member_owner ||
      fn.unexpected_acl ||
      (!fn.owner_super && !fn.owner_bypass) ||
      fn.proleakproof ||
      fn.proisstrict ||
      JSON.stringify(fn.proconfig) !==
        JSON.stringify([
          expected[3] ? 'search_path=pg_catalog, pg_temp' : 'search_path=pg_catalog',
        ]) ||
      (owner !== undefined && owner !== fn.proowner)
    )
      throw invalid196();
    owner = fn.proowner;
    if (expected[3]) {
      const inputs = [
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
        'p_state_epoch',
        'p_state_digest',
        'p_selected',
        'p_audience',
      ];
      const returns = RETURN_COLUMNS196.split(',').map((v) => v.trim().split(/\s+/));
      if (
        fn.pronargs !== 18 ||
        !fn.proretset ||
        fn.provolatile !== 'v' ||
        fn.proparallel !== 'u' ||
        JSON.stringify(fn.proargnames) !==
          JSON.stringify([...inputs, ...returns.map((r) => r[0])]) ||
        JSON.stringify(fn.proargmodes) !==
          JSON.stringify([...inputs.map(() => 'i'), ...returns.map(() => 't')]) ||
        JSON.stringify(fn.all_types) !==
          JSON.stringify([...ARG_TYPES196.split(','), ...returns.map((r) => r[1])])
      )
        throw invalid196();
    }
  }
  for (const table of s.definitions)
    if (
      table.relkind !== 'r' ||
      table.relpersistence !== 'p' ||
      !table.relrowsecurity ||
      !table.relforcerowsecurity ||
      table.member_owner ||
      table.unexpected_acl ||
      table.relowner !== owner ||
      JSON.stringify(table.privileges) !== '[true,false,false,false,false,false,false]' ||
      JSON.stringify(table.column_privileges) !== '[true,false,false,false]'
    )
      throw invalid196();
  const expectedColumns = {
    directory_state_component196: [
      ['version', 'bigint'],
      ['epoch', 'uuid'],
      ['signature', 'jsonb'],
      ['digest', 'text'],
    ],
    directory_state_heads196: [
      ['store_id', 'text'],
      ['kind', 'text'],
      ['epoch', 'uuid'],
      ['seq', 'bigint'],
      ['floor_seq', 'bigint'],
      ['reset_seq', 'bigint'],
      ['last_xid', 'xid8'],
      ['change_count', 'bigint'],
    ],
    directory_state_changes196: [
      ['store_id', 'text'],
      ['seq', 'bigint'],
      ['identity_digest', 'text'],
      ['audience', 'text'],
      ['patient_id', 'text'],
      ['summary_changed', 'boolean'],
      ['projection_changed', 'boolean'],
    ],
  };
  for (const [table, expected] of Object.entries(expectedColumns)) {
    const columns = s.columns.filter((c) => c.relname === table);
    if (
      JSON.stringify(columns.map((c) => [c.attname, c.type])) !== JSON.stringify(expected) ||
      columns.some(
        (c) =>
          c.attidentity ||
          c.attgenerated ||
          c.attnotnull !== (c.attname !== 'patient_id') ||
          (c.type === 'text' && c.collation !== 'C' && table !== 'directory_state_component196'),
      )
    )
      throw invalid196();
  }
  if (
    s.constraints.filter((c) => c.contype === 'p').length !== 3 ||
    s.constraints.filter((c) => c.contype === 'f').length !== 2 ||
    s.policies.length !== 6 ||
    JSON.stringify(s.policies.map((p) => p.policyname).sort()) !==
      '["owner_changes196","owner_component196","owner_head196","read_changes196","read_component196","read_head196"]'
  )
    throw invalid196();
  for (const table of ['cabinet_summaries', 'meta'])
    for (const [name, type] of [
      ['ct_directory_state196', 29],
      ['ct_directory_state_truncate196', 32],
    ]) {
      const t = s.triggers.find((v) => v.relname === table && v.tgname === name);
      if (
        !t ||
        t.nspname !== 'cartoteca_cabinet' ||
        t.tgtype !== type ||
        t.tgenabled !== 'O' ||
        t.args !== '' ||
        t.proname !== 'change_directory_state196'
      )
        throw invalid196();
    }
}
async function verifyDirectoryState196(client, role) {
  const present = (
    await client.query(
      `SELECT to_regclass($1)::text component,to_regclass($2)::text heads,to_regclass($3)::text changes,
 (SELECT count(*)::integer FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='cartoteca_catalog' AND p.proname=ANY($4::text[])) functions,
 (SELECT count(*)::integer FROM pg_trigger t WHERE NOT t.tgisinternal
 AND t.tgname IN('ct_directory_state196','ct_directory_state_truncate196')) triggers`,
      [META, HEAD, CHANGES, functions],
    )
  ).rows[0];
  if (
    !present.component &&
    !present.heads &&
    !present.changes &&
    present.functions === 0 &&
    present.triggers === 0
  )
    return null;
  if (
    !present.component ||
    !present.heads ||
    !present.changes ||
    present.functions !== 3 ||
    present.triggers !== 4
  )
    throw invalid196();
  const actual = await directoryStateSignature196(client, role);
  assertDirectoryStateSignature196(actual);
  const rows = (await client.query(`SELECT version,epoch::text,signature,digest FROM ${META}`))
    .rows;
  if (
    rows.length !== 1 ||
    Number(rows[0].version) !== 1 ||
    !/^[a-f0-9-]{36}$/.test(rows[0].epoch) ||
    digest(rows[0].signature) !== rows[0].digest ||
    digest(actual) !== rows[0].digest
  )
    throw invalid196();
  return Object.freeze({
    version: 1,
    epoch: rows[0].epoch,
    digest: rows[0].digest,
    maxChanges: MAX_CHANGES,
    seqWindow: SEQ_WINDOW,
  });
}
module.exports = {
  directoryStateSignature196,
  assertDirectoryStateSignature196,
  verifyDirectoryState196,
  invalid196,
};
