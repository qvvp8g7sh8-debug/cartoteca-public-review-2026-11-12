'use strict';
const TABLE = 'cartoteca_catalog.process_role_leases';
const UUID = '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$';
const FILTER =
  "platform_store_id=current_setting('cartoteca.store_id',true) AND current_setting('cartoteca.kind',true)='platform'";
const CHECKS = {
  process_role_leases_platform_uuid: [1, "platform_store_id ~ '" + UUID + "'"],
  process_role_leases_owner_uuid: [2, "owner ~ '" + UUID + "'"],
  process_role_leases_role: [3, "role='combined' OR role='background'"],
  process_role_leases_token_hash_length: [4, 'octet_length(token_hash)=32'],
};
function fault(reason) {
  return Object.assign(Error('Подготовка аренды процесса PostgreSQL недоступна.'), {
    code: 'POSTGRES_ROLE_SCHEMA_INVALID',
    status: 503,
    reason,
  });
}
function need(value, reason) {
  if (!value) throw fault(reason);
}
function roleName(value) {
  need(typeof value === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(value), 'role-name');
  return '"' + value + '"';
}
// Parentheses inside regex literals remain significant.
function expression(value) {
  if (typeof value !== 'string') return null;
  return [
    ...value.matchAll(
      /'(?:[^']|'')*'|"(?:[^"]|"")*"|::[a-z_][a-z0-9_]*|[a-z_][a-z0-9_]*|\d+|\s+|./gi,
    ),
  ]
    .map((m) => m[0])
    .filter(
      (t) =>
        !(/^\s+$/.test(t) || ['(', ')'].includes(t) || /^::(?:text|boolean|integer)$/i.test(t)),
    )
    .map((t) => (t.startsWith("'") ? t : t.toLowerCase()))
    .join('');
}
async function appRole(client, name) {
  roleName(name);
  const rows = (
    await client.query(
      'SELECT oid,rolsuper,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=$1',
      [name],
    )
  ).rows;
  need(
    rows.length === 1 && rows[0].rolsuper === false && rows[0].rolbypassrls === false,
    'role-authority',
  );
  return rows[0].oid;
}
async function validate(client, name) {
  const app = await appRole(client, name);
  const rows = (
    await client.query(
      `SELECT c.oid,c.relowner,c.relkind,c.relpersistence,c.relispartition,
    c.relrowsecurity,c.relforcerowsecurity,c.reloptions,n.nspowner,
    pg_has_role($1::oid,c.relowner,'MEMBER') AS member_owner,
    pg_has_role($1::oid,n.nspowner,'MEMBER') AS member_schema_owner,
    has_schema_privilege($1::oid,n.oid,'USAGE') AS schema_usage,
    has_schema_privilege($1::oid,n.oid,'CREATE') AS schema_create,
    ARRAY[has_table_privilege($1::oid,c.oid,'SELECT'),has_table_privilege($1::oid,c.oid,'INSERT'),
      has_table_privilege($1::oid,c.oid,'UPDATE'),has_table_privilege($1::oid,c.oid,'DELETE')] AS allowed,
    ARRAY[has_table_privilege($1::oid,c.oid,'TRUNCATE'),has_table_privilege($1::oid,c.oid,'REFERENCES'),
      has_table_privilege($1::oid,c.oid,'TRIGGER'),has_table_privilege($1::oid,c.oid,'MAINTAIN')] AS forbidden
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='cartoteca_catalog' AND c.relname='process_role_leases'`,
      [app],
    )
  ).rows;
  need(rows.length === 1, 'table-missing');
  const t = rows[0];
  need(
    t.relkind === 'r' &&
      t.relpersistence === 'p' &&
      t.relispartition === false &&
      t.relrowsecurity === true &&
      t.relforcerowsecurity === true &&
      t.reloptions === null,
    'table-rls',
  );
  need(
    t.relowner !== app &&
      t.nspowner !== app &&
      t.member_owner === false &&
      t.member_schema_owner === false &&
      t.schema_usage === true &&
      t.schema_create === false,
    'native-owner',
  );
  need(
    t.allowed?.length === 4 &&
      t.allowed.every((v) => v === true) &&
      t.forbidden?.length === 4 &&
      t.forbidden.every((v) => v === false),
    'effective-privileges',
  );
  const columns = (
    await client.query(
      `SELECT a.attname,a.attnum,a.atttypmod,a.attnotnull,a.attidentity,
    a.attgenerated,a.attisdropped,a.attacl,ty.typname,ns.nspname AS type_schema,
    co.collname,cn.nspname AS collation_schema,pg_get_expr(d.adbin,d.adrelid) AS default_value
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type ty ON ty.oid=a.atttypid
    JOIN pg_catalog.pg_namespace ns ON ns.oid=ty.typnamespace
    LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation
    LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=$1::oid AND a.attnum>0 ORDER BY a.attnum`,
      [t.oid],
    )
  ).rows;
  const expected = [
    ['platform_store_id', 'text'],
    ['owner', 'text'],
    ['role', 'text'],
    ['token_hash', 'bytea'],
    ['expires_at', 'timestamptz'],
  ];
  need(columns.length === 5, 'columns-count');
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
      'column-definition',
    );
  }
  const allConstraints = (
    await client.query(
      `SELECT conname,contype,convalidated,condeferrable,condeferred,
    COALESCE((to_jsonb(pg_constraint)->>'conenforced')::boolean,true) AS enforced,
    connoinherit,conislocal,coninhcount,conkey,pg_get_expr(conbin,conrelid) AS expression
    FROM pg_catalog.pg_constraint WHERE conrelid=$1::oid ORDER BY conname`,
      [t.oid],
    )
  ).rows;
  // PG18 exposes implicit NOT NULL constraints separately; column flags above remain mandatory.
  const constraints = allConstraints.filter((c) => c.contype !== 'n'),
    nulls = allConstraints.filter((c) => c.contype === 'n');
  need(constraints.length === 5, 'constraints-count');
  if (nulls.length)
    need(
      nulls.length === 5 &&
        new Set(nulls.map((c) => c.conkey?.[0])).size === 5 &&
        nulls.every(
          (c) =>
            c.conkey?.length === 1 &&
            c.conkey[0] >= 1 &&
            c.conkey[0] <= 5 &&
            c.convalidated === true &&
            c.enforced === true &&
            !c.condeferrable &&
            !c.condeferred,
        ),
      'not-null-constraints',
    );
  for (const c of constraints) {
    need(
      c.convalidated === true &&
        c.enforced === true &&
        c.condeferrable === false &&
        c.condeferred === false &&
        c.conislocal === true &&
        c.coninhcount === 0,
      'constraint-flags',
    );
    if (c.contype === 'p')
      need(
        c.conname === 'process_role_leases_pkey' && JSON.stringify(c.conkey) === '[1,2]',
        'primary-key',
      );
    else {
      const check = CHECKS[c.conname];
      need(c.contype === 'c' && !!check && c.connoinherit === false, 'unexpected-constraint');
      need(
        JSON.stringify(c.conkey) === JSON.stringify([check[0]]) &&
          expression(c.expression) === expression(check[1]),
        'check-expression',
      );
    }
  }
  const indexes = (
    await client.query(
      `SELECT ic.relname,ic.relowner,i.indisprimary,i.indisunique,i.indisvalid,i.indisready,
    i.indnkeyatts,i.indnatts,i.indkey::text,i.indoption::text,am.amname,
    pg_get_expr(i.indexprs,i.indrelid) AS expressions,pg_get_expr(i.indpred,i.indrelid) AS predicate,
    ARRAY(SELECT co.collname::text FROM unnest(i.indcollation::oid[]) WITH ORDINALITY x(id,ord)
      JOIN pg_catalog.pg_collation co ON co.oid=x.id ORDER BY x.ord) AS collations,
    ARRAY(SELECT op.opcname::text FROM unnest(i.indclass::oid[]) WITH ORDINALITY x(id,ord)
      JOIN pg_catalog.pg_opclass op ON op.oid=x.id ORDER BY x.ord) AS classes,
    ARRAY(SELECT ns.nspname::text FROM unnest(i.indclass::oid[]) WITH ORDINALITY x(id,ord)
      JOIN pg_catalog.pg_opclass op ON op.oid=x.id JOIN pg_catalog.pg_namespace ns ON ns.oid=op.opcnamespace ORDER BY x.ord) AS class_schemas
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
    JOIN pg_catalog.pg_am am ON am.oid=ic.relam WHERE i.indrelid=$1::oid`,
      [t.oid],
    )
  ).rows;
  need(indexes.length === 1, 'indexes-count');
  const ix = indexes[0];
  need(
    ix.relname === 'process_role_leases_pkey' &&
      ix.relowner === t.relowner &&
      ix.indisprimary === true &&
      ix.indisunique === true &&
      ix.indisvalid === true &&
      ix.indisready === true &&
      ix.indnkeyatts === 2 &&
      ix.indnatts === 2 &&
      ix.indkey === '1 2' &&
      ix.indoption === '0 0' &&
      ix.expressions === null &&
      ix.predicate === null &&
      ix.amname === 'btree' &&
      JSON.stringify(ix.collations) === '["C","C"]' &&
      JSON.stringify(ix.classes) === '["text_ops","text_ops"]' &&
      JSON.stringify(ix.class_schemas) === '["pg_catalog","pg_catalog"]',
    'index-definition',
  );
  const policies = (
    await client.query(
      `SELECT polname,polcmd,polpermissive,polroles,pg_get_expr(polqual,polrelid) AS using_expression,
    pg_get_expr(polwithcheck,polrelid) AS check_expression FROM pg_catalog.pg_policy WHERE polrelid=$1::oid`,
      [t.oid],
    )
  ).rows;
  need(policies.length === 1, 'policies-count');
  const policy = policies[0];
  need(
    policy.polname === 'process_role_scope' &&
      policy.polcmd === '*' &&
      policy.polpermissive === true &&
      JSON.stringify(policy.polroles) === JSON.stringify([app]) &&
      expression(policy.using_expression) === expression(FILTER) &&
      expression(policy.check_expression) === expression(FILTER),
    'policy-definition',
  );
  const triggers = (
    await client.query('SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=$1::oid', [t.oid])
  ).rows;
  need(triggers.length === 0, 'unexpected-trigger');
  const inherits = (
    await client.query(
      'SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=$1::oid OR inhparent=$1::oid',
      [t.oid],
    )
  ).rows;
  need(inherits.length === 0, 'unexpected-inheritance');
  const acl = (
    await client.query(
      `SELECT a.grantee,a.grantor,a.privilege_type,a.is_grantable FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=$1::oid`,
      [t.oid],
    )
  ).rows;
  const privileges = [];
  for (const a of acl) {
    need(a.grantee === t.relowner || a.grantee === app, 'unexpected-grantee');
    if (a.grantee === app) {
      need(a.grantor === t.relowner && a.is_grantable === false, 'grant-option');
      privileges.push(a.privilege_type);
    }
  }
  need(
    JSON.stringify(privileges.sort()) === '["DELETE","INSERT","SELECT","UPDATE"]',
    'exact-app-grants',
  );
  return Object.freeze({ validated: true });
}
async function validateRoleLeaseSchema(client, name) {
  try {
    return await validate(client, name);
  } catch (e) {
    if (e?.code === 'POSTGRES_ROLE_SCHEMA_INVALID') throw e;
    throw fault('catalog-query');
  }
}
async function ensureRoleLeaseSchema(client, name) {
  try {
    const quoted = roleName(name);
    await appRole(client, name);
    const found = (await client.query('SELECT to_regclass($1) AS relation', [TABLE])).rows[0]
      ?.relation;
    if (found) {
      await validateRoleLeaseSchema(client, name);
      return Object.freeze({ created: false, validated: true });
    }
    // One fixed DDL message is atomic and joins an existing offline outer transaction.
    await client.query(`CREATE TABLE ${TABLE}(
      platform_store_id TEXT COLLATE "C" NOT NULL,owner TEXT COLLATE "C" NOT NULL,
      role TEXT COLLATE "C" NOT NULL,token_hash BYTEA NOT NULL,expires_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT process_role_leases_pkey PRIMARY KEY(platform_store_id,owner),
      CONSTRAINT process_role_leases_platform_uuid CHECK(platform_store_id ~ '${UUID}'),
      CONSTRAINT process_role_leases_owner_uuid CHECK(owner ~ '${UUID}'),
      CONSTRAINT process_role_leases_role CHECK(role='combined' OR role='background'),
      CONSTRAINT process_role_leases_token_hash_length CHECK(octet_length(token_hash)=32));
      ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY;
      REVOKE ALL ON TABLE ${TABLE} FROM PUBLIC;
      GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE ${TABLE} TO ${quoted};
      CREATE POLICY process_role_scope ON ${TABLE} FOR ALL TO ${quoted} USING(${FILTER}) WITH CHECK(${FILTER});`);
    await validateRoleLeaseSchema(client, name);
    return Object.freeze({ created: true, validated: true });
  } catch (e) {
    if (e?.code === 'POSTGRES_ROLE_SCHEMA_INVALID') throw e;
    throw fault('operator-preparation');
  }
}
module.exports = { ensureRoleLeaseSchema, validateRoleLeaseSchema };
