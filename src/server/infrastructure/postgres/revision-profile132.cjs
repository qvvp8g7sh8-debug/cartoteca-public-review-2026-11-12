'use strict';
const {
  TABLE,
  domains,
  filter,
  legacyBody,
  revisionBody,
  functionSQL,
} = require('./revision-sql132.cjs');
const { revisionBody: snapshotBody } = require('./revision-sql133.cjs');
const failure = (reason) =>
  Object.assign(Error('PostgreSQL revision profile is invalid.'), {
    code: 'POSTGRES_REVISION_PROFILE_INVALID',
    status: 503,
    reason,
  });
function need(value, reason) {
  if (!value) throw failure(reason);
}
function expression(value) {
  if (typeof value !== 'string') return null;
  return [
    ...value.matchAll(
      /'(?:[^']|'')*'|"(?:[^"]|"")*"|::[a-z_][a-z0-9_]*|[a-z_][a-z0-9_]*|\d+|\s+|./gi,
    ),
  ]
    .map((m) => m[0])
    .filter(
      (t) => !(/^\s+$/.test(t) || ['(', ')'].includes(t) || /^::(?:text|bigint|integer)$/i.test(t)),
    )
    .map((t) => (t.startsWith("'") ? t : t.toLowerCase()))
    .join('');
}
async function functionProfile(client, role) {
  need(typeof role === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(role), 'role-name');
  const roles = (
    await client.query(
      'SELECT oid,rolsuper,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=$1',
      [role],
    )
  ).rows;
  need(roles.length === 1 && !roles[0].rolsuper && !roles[0].rolbypassrls, 'role-authority');
  const app = roles[0].oid;
  const rows = (
    await client.query(
      `SELECT p.oid,p.proowner,p.prosrc,p.prosecdef,p.proconfig,p.provolatile,p.proparallel,
    p.pronargs,p.prorettype::regtype::text AS result,l.lanname,
    pg_has_role($1::oid,p.proowner,'MEMBER') AS member_owner,
    has_function_privilege($1::oid,p.oid,'EXECUTE') AS app_execute,
    EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner) AS extra_acl
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    WHERE n.nspname='cartoteca_catalog' AND p.proname='bump_store_revision'`,
      [app],
    )
  ).rows;
  need(rows.length === 1, 'helper-count');
  const fn = rows[0];
  need(
    fn.proowner !== app &&
      fn.member_owner === false &&
      fn.app_execute === false &&
      fn.extra_acl === false &&
      fn.prosecdef === true &&
      JSON.stringify(fn.proconfig) === '["search_path=pg_catalog"]' &&
      fn.provolatile === 'v' &&
      fn.proparallel === 'u' &&
      fn.pronargs === 0 &&
      fn.result === 'trigger' &&
      fn.lanname === 'plpgsql',
    'helper-authority',
  );
  const version =
    fn.prosrc === legacyBody
      ? 1
      : fn.prosrc === revisionBody
        ? 2
        : fn.prosrc === snapshotBody
          ? 3
          : 0;
  need(version !== 0, 'helper-definition');
  return { version, app, owner: fn.proowner };
}
async function validateState(client, role, authority) {
  const rows = (
    await client.query(
      `SELECT c.oid,c.relowner,c.relkind,c.relpersistence,c.relispartition,c.relrowsecurity,c.relforcerowsecurity,c.reloptions,n.nspowner,
    pg_has_role($1::oid,c.relowner,'MEMBER') AS member_owner,pg_has_role($1::oid,n.nspowner,'MEMBER') AS member_schema_owner,
    has_schema_privilege($1::oid,n.oid,'USAGE') AS schema_usage,has_schema_privilege($1::oid,n.oid,'CREATE') AS schema_create,
    ARRAY[has_table_privilege($1::oid,c.oid,'SELECT'),has_table_privilege($1::oid,c.oid,'INSERT'),has_table_privilege($1::oid,c.oid,'UPDATE'),has_table_privilege($1::oid,c.oid,'DELETE'),has_table_privilege($1::oid,c.oid,'TRUNCATE'),has_table_privilege($1::oid,c.oid,'REFERENCES'),has_table_privilege($1::oid,c.oid,'TRIGGER'),has_table_privilege($1::oid,c.oid,'MAINTAIN')] AS privileges
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='cartoteca_catalog' AND c.relname='revision_state'`,
      [authority.app],
    )
  ).rows;
  need(rows.length === 1, 'state-missing');
  const t = rows[0];
  need(
    t.relowner === authority.owner &&
      t.relkind === 'r' &&
      t.relpersistence === 'p' &&
      t.relispartition === false &&
      t.relrowsecurity === true &&
      t.relforcerowsecurity === true &&
      t.reloptions === null &&
      t.member_owner === false &&
      t.nspowner !== authority.app &&
      t.member_schema_owner === false &&
      t.schema_usage === true &&
      t.schema_create === false &&
      JSON.stringify(t.privileges) === '[true,false,false,false,false,false,false,false]',
    'state-authority',
  );
  const columns = (
    await client.query(
      `SELECT a.attname,a.attnum,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attisdropped,a.attacl,
    ty.typname,ns.nspname AS type_schema,co.collname,cn.nspname AS collation_schema,pg_get_expr(d.adbin,d.adrelid) AS default_value
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type ty ON ty.oid=a.atttypid JOIN pg_catalog.pg_namespace ns ON ns.oid=ty.typnamespace
    LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=$1::oid AND a.attnum>0 ORDER BY a.attnum`,
      [t.oid],
    )
  ).rows;
  const expected = [
    ['kind', 'text'],
    ['store_id', 'text'],
    ['domain', 'text'],
    ['revision', 'int8'],
    ['last_xid', 'xid8'],
  ];
  need(columns.length === expected.length, 'state-columns');
  for (let i = 0; i < expected.length; i++) {
    const c = columns[i],
      [name, type] = expected[i];
    need(
      c.attname === name &&
        c.typname === type &&
        c.type_schema === 'pg_catalog' &&
        c.attnum === i + 1 &&
        c.atttypmod === -1 &&
        c.attnotnull === true &&
        c.attidentity === '' &&
        c.attgenerated === '' &&
        c.attisdropped === false &&
        c.attacl === null &&
        c.default_value === null &&
        (type === 'text'
          ? c.collname === 'C' && c.collation_schema === 'pg_catalog'
          : c.collname === null),
      'state-column-definition',
    );
  }
  const constraints = (
    await client.query(
      `SELECT conname,contype,conkey,confkey,confrelid::regclass::text AS target,confupdtype,confdeltype,confmatchtype,
    convalidated,condeferrable,condeferred,conislocal,coninhcount,COALESCE((to_jsonb(pg_constraint)->>'conenforced')::boolean,true) AS enforced,
    pg_get_expr(conbin,conrelid) AS expression FROM pg_catalog.pg_constraint WHERE conrelid=$1::oid ORDER BY conname`,
      [t.oid],
    )
  ).rows;
  const substantive = constraints.filter((c) => c.contype !== 'n');
  need(substantive.length === 5, 'state-constraints');
  const checks = {
    revision_state_kind: "kind='platform' OR kind='cabinet' OR kind='budget'",
    revision_state_domain: domains.map((d) => "domain='" + d + "'").join(' OR '),
    revision_state_nonnegative: 'revision>=0',
  };
  for (const c of constraints) {
    need(
      c.convalidated === true &&
        c.enforced === true &&
        !c.condeferrable &&
        !c.condeferred &&
        c.conislocal === true &&
        c.coninhcount === 0,
      'constraint-flags',
    );
    if (c.contype === 'n') continue;
    if (c.contype === 'p')
      need(
        c.conname === 'revision_state_pkey' && JSON.stringify(c.conkey) === '[1,2,3]',
        'state-pkey',
      );
    else if (c.contype === 'f')
      need(
        c.conname === 'revision_state_store_fkey' &&
          JSON.stringify(c.conkey) === '[1,2]' &&
          JSON.stringify(c.confkey) === '[1,2]' &&
          c.target === 'cartoteca_catalog.stores' &&
          c.confupdtype === 'r' &&
          c.confdeltype === 'c' &&
          c.confmatchtype === 's',
        'state-fkey',
      );
    else
      need(
        c.contype === 'c' &&
          Object.hasOwn(checks, c.conname) &&
          expression(c.expression) === expression(checks[c.conname]),
        'state-check',
      );
  }
  // A valid catalog FK can still have its enforcement triggers disabled by an
  // owner. Attest both check triggers and the parent cascade/restrict triggers.
  const enforcement = (
    await client.query(
      `SELECT t.tgisinternal,t.tgenabled,t.tgdeferrable,t.tginitdeferred,
    t.tgrelid::regclass::text AS relation,p.proname,n.nspname
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE t.tgconstraint=(SELECT oid FROM pg_catalog.pg_constraint WHERE conrelid=$1::oid AND conname='revision_state_store_fkey')
    ORDER BY p.proname`,
      [t.oid],
    )
  ).rows;
  const expectedEnforcement = {
    RI_FKey_cascade_del: 'cartoteca_catalog.stores',
    RI_FKey_check_ins: TABLE,
    RI_FKey_check_upd: TABLE,
    RI_FKey_restrict_upd: 'cartoteca_catalog.stores',
  };
  need(
    enforcement.length === 4 &&
      new Set(enforcement.map((r) => r.proname)).size === 4 &&
      enforcement.every(
        (r) =>
          r.tgisinternal === true &&
          r.tgenabled === 'O' &&
          r.tgdeferrable === false &&
          r.tginitdeferred === false &&
          r.nspname === 'pg_catalog' &&
          Object.hasOwn(expectedEnforcement, r.proname) &&
          r.relation === expectedEnforcement[r.proname],
      ),
    'state-fkey-enforcement',
  );
  const indexes = (
    await client.query(
      `SELECT c.relname,i.indisprimary,i.indisunique,i.indisvalid,i.indisready,i.indnkeyatts,i.indnatts,i.indkey::text,i.indoption::text,am.amname,
    pg_get_expr(i.indexprs,i.indrelid) AS expressions,pg_get_expr(i.indpred,i.indrelid) AS predicate,
    ARRAY(SELECT co.collname::text FROM unnest(i.indcollation::oid[]) WITH ORDINALITY x(id,ord) JOIN pg_catalog.pg_collation co ON co.oid=x.id ORDER BY x.ord) AS collations,
    ARRAY(SELECT op.opcname::text FROM unnest(i.indclass::oid[]) WITH ORDINALITY x(id,ord) JOIN pg_catalog.pg_opclass op ON op.oid=x.id ORDER BY x.ord) AS classes,
    ARRAY(SELECT n.nspname::text FROM unnest(i.indclass::oid[]) WITH ORDINALITY x(id,ord) JOIN pg_catalog.pg_opclass op ON op.oid=x.id JOIN pg_catalog.pg_namespace n ON n.oid=op.opcnamespace ORDER BY x.ord) AS class_schemas
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid JOIN pg_catalog.pg_am am ON am.oid=c.relam WHERE i.indrelid=$1::oid`,
      [t.oid],
    )
  ).rows;
  need(indexes.length === 1, 'state-indexes');
  const ix = indexes[0];
  need(
    ix.relname === 'revision_state_pkey' &&
      ix.indisprimary === true &&
      ix.indisunique === true &&
      ix.indisvalid === true &&
      ix.indisready === true &&
      ix.indnkeyatts === 3 &&
      ix.indnatts === 3 &&
      ix.indkey === '1 2 3' &&
      ix.indoption === '0 0 0' &&
      ix.amname === 'btree' &&
      ix.expressions === null &&
      ix.predicate === null &&
      JSON.stringify(ix.collations) === '["C","C","C"]' &&
      JSON.stringify(ix.classes) === '["text_ops","text_ops","text_ops"]' &&
      JSON.stringify(ix.class_schemas) === '["pg_catalog","pg_catalog","pg_catalog"]',
    'state-index-definition',
  );
  const policies = (
    await client.query(
      `SELECT polname,polcmd,polpermissive,polroles,pg_get_expr(polqual,polrelid) AS using_expression,pg_get_expr(polwithcheck,polrelid) AS check_expression FROM pg_catalog.pg_policy WHERE polrelid=$1::oid`,
      [t.oid],
    )
  ).rows;
  need(policies.length === 2, 'state-policy-count');
  const reader = policies.find((p) => p.polname === 'revision_scope');
  const owner = policies.find((p) => p.polname === 'revision_owner');
  need(
    reader &&
      reader.polcmd === 'r' &&
      reader.polpermissive === true &&
      JSON.stringify(reader.polroles) === JSON.stringify([authority.app]) &&
      expression(reader.using_expression) === expression(filter) &&
      reader.check_expression === null,
    'state-reader-policy',
  );
  need(
    owner &&
      owner.polcmd === '*' &&
      owner.polpermissive === true &&
      JSON.stringify(owner.polroles) === JSON.stringify([authority.owner]) &&
      expression(owner.using_expression) === 'true' &&
      expression(owner.check_expression) === 'true',
    'state-owner-policy',
  );
  const unsafe = (
    await client.query(
      `SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=$1::oid AND NOT tgisinternal) AS triggers,
    EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=$1::oid OR inhparent=$1::oid) AS inheritance,
    EXISTS(SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=$1::oid AND (a.grantee NOT IN(c.relowner,$2::oid) OR (a.grantee=$2::oid AND (a.privilege_type<>'SELECT' OR a.is_grantable OR a.grantor<>c.relowner)))) AS acl`,
      [t.oid, authority.app],
    )
  ).rows;
  need(
    unsafe.length === 1 && Object.values(unsafe[0]).every((v) => v === false),
    'state-unexpected-authority',
  );
}
async function readRevisionProfile(client, role = client.user) {
  try {
    const authority = await functionProfile(client, role);
    const found = (await client.query('SELECT to_regclass($1) AS relation', [TABLE])).rows[0]
      ?.relation;
    if (authority.version === 1) {
      need(!found, 'partial-legacy-profile');
      return 1;
    }
    need(!!found, 'partial-native-profile');
    await validateState(client, role, authority);
    return authority.version;
  } catch (error) {
    if (error?.code === 'POSTGRES_REVISION_PROFILE_INVALID') throw error;
    throw failure('catalog-query');
  }
}
async function ensureRevisionFunction(client, role) {
  const rows = (
    await client.query(
      "SELECT to_regprocedure('cartoteca_catalog.bump_store_revision()') AS helper",
    )
  ).rows;
  if (!rows[0]?.helper) {
    await client.query(functionSQL(1, false));
    return 1;
  }
  return readRevisionProfile(client, role);
}
function archiveRevisionProfile(value) {
  if (value === undefined) return 1;
  need(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      [2, 3].includes(value.version),
    'archive-profile',
  );
  return value.version;
}
function validateArchivedRevisionProfile(native, marker) {
  const version = archiveRevisionProfile(marker);
  need(Array.isArray(native), 'archive-native-profile');
  const bodies = { 2: revisionBody, 3: snapshotBody };
  let matches = 0;
  for (const row of native) {
    const helpers = row?.signature?.helpers;
    if (!Array.isArray(helpers)) {
      need(version === 1, 'archive-native-helper');
      continue;
    }
    const helper = helpers.filter((h) => h.proname === 'bump_store_revision');
    if (version !== 1)
      need(
        helper.length === 1 &&
          typeof helper[0].definition === 'string' &&
          helper[0].definition.includes(bodies[version]),
        'archive-native-helper',
      );
    if (
      helper.some(
        (h) =>
          typeof h.definition === 'string' &&
          Object.values(bodies).some((body) => h.definition.includes(body)),
      )
    )
      matches++;
  }
  need(
    version !== 1 ? native.length > 0 && matches === native.length : matches === 0,
    'archive-profile-binding',
  );
  return version;
}

module.exports = {
  readRevisionProfile,
  ensureRevisionFunction,
  archiveRevisionProfile,
  validateArchivedRevisionProfile,
  failure,
};
