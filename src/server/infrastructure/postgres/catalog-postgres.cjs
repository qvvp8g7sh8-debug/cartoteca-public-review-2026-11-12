const { identifier: q, namespace, digest } = require('./catalog-sqlite.cjs');
const catalogSQL = `CREATE SCHEMA IF NOT EXISTS cartoteca_catalog;
CREATE TABLE IF NOT EXISTS cartoteca_catalog.stores(
 kind TEXT COLLATE "C" NOT NULL CHECK(kind IN ('platform','cabinet','budget')),store_id TEXT COLLATE "C" NOT NULL,
 version BIGINT NOT NULL,catalog_hash TEXT COLLATE "C" NOT NULL,metadata JSONB NOT NULL,revision BIGINT NOT NULL DEFAULT 0,
 PRIMARY KEY(kind,store_id));
CREATE TABLE IF NOT EXISTS cartoteca_catalog.asset_profiles(
 kind TEXT COLLATE "C" NOT NULL CHECK(kind='platform'),store_id TEXT COLLATE "C" NOT NULL,
 migration_id TEXT COLLATE "C" NOT NULL,marker_hash TEXT COLLATE "C" NOT NULL CHECK(marker_hash ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(kind,store_id),FOREIGN KEY(kind,store_id) REFERENCES cartoteca_catalog.stores(kind,store_id));
CREATE TABLE IF NOT EXISTS cartoteca_catalog.objects(kind TEXT COLLATE "C" NOT NULL,store_id TEXT COLLATE "C" NOT NULL,type TEXT COLLATE "C" NOT NULL,name TEXT COLLATE "C" NOT NULL,tbl_name TEXT COLLATE "C" NOT NULL,sql TEXT COLLATE "C",PRIMARY KEY(kind,store_id,type,name));
CREATE TABLE IF NOT EXISTS cartoteca_catalog.columns(kind TEXT COLLATE "C" NOT NULL,store_id TEXT COLLATE "C" NOT NULL,table_name TEXT COLLATE "C" NOT NULL,cid BIGINT NOT NULL,name TEXT COLLATE "C" NOT NULL,type TEXT COLLATE "C" NOT NULL,"notnull" BIGINT NOT NULL,dflt_value TEXT COLLATE "C",pk BIGINT NOT NULL,PRIMARY KEY(kind,store_id,table_name,cid));
CREATE TABLE IF NOT EXISTS cartoteca_catalog.indexes(kind TEXT COLLATE "C" NOT NULL,store_id TEXT COLLATE "C" NOT NULL,table_name TEXT COLLATE "C" NOT NULL,seq BIGINT NOT NULL,name TEXT COLLATE "C" NOT NULL,"unique" BIGINT NOT NULL,origin TEXT COLLATE "C" NOT NULL,partial BIGINT NOT NULL,PRIMARY KEY(kind,store_id,table_name,name));
CREATE TABLE IF NOT EXISTS cartoteca_catalog.index_columns(kind TEXT COLLATE "C" NOT NULL,store_id TEXT COLLATE "C" NOT NULL,index_name TEXT NOT NULL,seqno BIGINT NOT NULL,cid BIGINT NOT NULL,name TEXT COLLATE "C","desc" BIGINT NOT NULL,coll TEXT COLLATE "C","key" BIGINT NOT NULL,PRIMARY KEY(kind,store_id,index_name,seqno));
CREATE TABLE IF NOT EXISTS cartoteca_catalog.templates(kind TEXT COLLATE "C" NOT NULL,version BIGINT NOT NULL,catalog_hash TEXT COLLATE "C" NOT NULL,metadata JSONB NOT NULL,PRIMARY KEY(kind,version,catalog_hash));
CREATE TABLE IF NOT EXISTS cartoteca_catalog.native_objects(kind TEXT COLLATE "C" NOT NULL,type TEXT COLLATE "C" NOT NULL,name TEXT COLLATE "C" NOT NULL,table_name TEXT COLLATE "C" NOT NULL,definition_hash TEXT COLLATE "C" NOT NULL,definition TEXT COLLATE "C" NOT NULL,PRIMARY KEY(kind,type,name,table_name));
CREATE TABLE IF NOT EXISTS cartoteca_catalog.native_manifests(kind TEXT COLLATE "C" PRIMARY KEY,signature JSONB NOT NULL,digest TEXT COLLATE "C" NOT NULL);
CREATE TABLE IF NOT EXISTS cartoteca_catalog.restore_jobs(id TEXT PRIMARY KEY,platform_store_id TEXT NOT NULL,organization_id TEXT NOT NULL,before_fingerprint TEXT NOT NULL,after_fingerprint TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('committed','rolled-back')),created_at BIGINT NOT NULL);
`;
const metadataTables = [
  'stores',
  'asset_profiles',
  'objects',
  'columns',
  'indexes',
  'index_columns',
];
async function ensureCatalog(client, applicationRole) {
  q(applicationRole);
  const role = await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1', [
    applicationRole,
  ]);
  if (!role.rows.length || role.rows[0].rolsuper || role.rows[0].rolbypassrls)
    throw Error('Application role must exist without superuser or BYPASSRLS.');
  await client.query(catalogSQL);
  for (const kind of ['platform', 'cabinet', 'budget'])
    await client.query('CREATE SCHEMA IF NOT EXISTS ' + q(namespace(kind)));
  const helper = require('./dialect-functions.cjs').compatibilityFunctionsSQL;
  for (const sql of Array.isArray(helper) ? helper : [helper]) if (sql) await client.query(sql);
  for (const table of metadataTables) {
    await client.query(
      `ALTER TABLE cartoteca_catalog.${q(table)} ENABLE ROW LEVEL SECURITY; ALTER TABLE cartoteca_catalog.${q(table)} FORCE ROW LEVEL SECURITY`,
    );
    const exists = await client.query(
      'SELECT 1 FROM pg_policies WHERE schemaname=$1 AND tablename=$2 AND policyname=$3',
      ['cartoteca_catalog', table, 'store_scope'],
    );
    if (!exists.rows.length)
      await client.query(
        `CREATE POLICY store_scope ON cartoteca_catalog.${q(table)} USING(kind=current_setting('cartoteca.kind',true) AND store_id=current_setting('cartoteca.store_id',true))`,
      );
  }
  await client.query('REVOKE ALL ON SCHEMA cartoteca_catalog FROM PUBLIC');
  for (const schema of [
    'cartoteca_catalog',
    'cartoteca_platform',
    'cartoteca_cabinet',
    'cartoteca_budget',
  ])
    await client.query('GRANT USAGE ON SCHEMA ' + q(schema) + ' TO ' + q(applicationRole));
  for (const table of [...metadataTables, 'templates', 'native_objects', 'native_manifests'])
    await client.query(
      'GRANT SELECT ON cartoteca_catalog.' + q(table) + ' TO ' + q(applicationRole),
    );
  await require('./process-role-schema.cjs').ensureRoleLeaseSchema(client, applicationRole);
  await require('./revision-profile132.cjs').ensureRevisionFunction(client, applicationRole);
}
async function storeCatalog(client, { kind, storeId, source, template = true }) {
  namespace(kind);
  if (typeof storeId !== 'string' || !/^[a-f0-9-]{36}$/i.test(storeId))
    throw Error('Invalid store identity.');
  const hash = digest(source);
  const exists = await client.query(
    'SELECT catalog_hash FROM cartoteca_catalog.stores WHERE kind=$1 AND store_id=$2',
    [kind, storeId],
  );
  if (exists.rows.length) {
    if (exists.rows[0].catalog_hash !== hash)
      throw Error('Store catalog differs from its registered schema.');
    return { newStore: false, metadata: source, catalogHash: hash };
  }
  await client.query(
    'INSERT INTO cartoteca_catalog.stores(kind,store_id,version,catalog_hash,metadata) VALUES($1,$2,$3,$4,$5)',
    [kind, storeId, source.version, hash, source],
  );
  for (const row of source.objects)
    await client.query('INSERT INTO cartoteca_catalog.objects VALUES($1,$2,$3,$4,$5,$6)', [
      kind,
      storeId,
      row.type,
      row.name,
      row.tbl_name,
      row.sql,
    ]);
  for (const table of Object.values(source.tables)) {
    for (const c of table.columns)
      await client.query(
        'INSERT INTO cartoteca_catalog.columns VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [kind, storeId, table.name, c.cid, c.name, c.type, c.notnull, c.dflt_value, c.pk],
      );
    for (const i of table.indexes) {
      await client.query('INSERT INTO cartoteca_catalog.indexes VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [
        kind,
        storeId,
        table.name,
        i.seq,
        i.name,
        i.unique,
        i.origin,
        i.partial,
      ]);
      for (const c of i.columns)
        await client.query(
          'INSERT INTO cartoteca_catalog.index_columns VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [kind, storeId, i.name, c.seqno, c.cid, c.name, c.desc, c.coll, c.key],
        );
    }
  }
  if (template)
    await client.query(
      'INSERT INTO cartoteca_catalog.templates VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [kind, source.version, hash, source],
    );
  return { newStore: true, metadata: source, catalogHash: hash };
}
async function nativeSignature(client, kind) {
  const schema = namespace(kind);
  const queries = [
    [
      'tables',
      `SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.attidentity,pg_get_expr(d.adbin,d.adrelid) AS default FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname=$1 AND c.relkind='r' ORDER BY c.relname,a.attnum`,
    ],
    [
      'constraints',
      `SELECT t.relname,c.conname,c.contype,pg_get_constraintdef(c.oid,true) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 ORDER BY t.relname,c.conname`,
    ],
    [
      'indexes',
      `SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=$1 ORDER BY tablename,indexname`,
    ],
    [
      'policies',
      `SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname=$1 ORDER BY tablename,policyname`,
    ],
    [
      'triggers',
      `SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true) AS definition,pg_get_functiondef(t.tgfoid) AS function FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,
    ],
    [
      'helpers',
      `SELECT p.proname,p.prosecdef,p.proconfig,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='cartoteca_catalog' AND (p.proname IN ('json_each','json_extract','json_valid','sqlite_typeof','glob_match','like_match','ascii_lower','ascii_upper','bump_store_revision') OR ($1='cartoteca_platform' AND p.proname='provision_store')) ORDER BY p.proname,p.oid::regprocedure::text`,
    ],
  ];
  const signature = {};
  for (const [key, sql] of queries) signature[key] = (await client.query(sql, [schema])).rows;
  if (signature.tables.some((row) => !row.relrowsecurity || !row.relforcerowsecurity))
    throw Error('Native store RLS is incomplete.');
  return signature;
}
async function validatePostgresSchema(client, { kind, applicationRole }) {
  const expected = (
    await client.query(
      'SELECT signature,digest FROM cartoteca_catalog.native_manifests WHERE kind=$1',
      [kind],
    )
  ).rows[0];
  const actual = await nativeSignature(client, kind);
  if (
    !expected ||
    digest(actual) !== expected.digest ||
    digest(expected.signature) !== expected.digest
  )
    throw Error('Native PostgreSQL schema differs from its prepared manifest.');
  if (applicationRole) {
    const role = (
      await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1', [
        applicationRole,
      ])
    ).rows[0];
    const owned = await client.query(
      'SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname=$1 AND r.rolname=$2 LIMIT 1',
      [namespace(kind), applicationRole],
    );
    if (!role || role.rolsuper || role.rolbypassrls || owned.rows.length)
      throw Error('Unsafe PostgreSQL application role.');
  }
  if (applicationRole)
    await require('./revision-profile132.cjs').readRevisionProfile(client, applicationRole);
  return { kind, digest: expected.digest };
}
function assetIdentity(profile) {
  const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
  if (
    profile?.version !== 1 ||
    profile.backend !== 'postgres' ||
    !uuid.test(profile.platformStoreId || '') ||
    !uuid.test(profile.migrationId || '')
  )
    throw Error('Invalid PostgreSQL asset lineage.');
  return {
    storeId: profile.platformStoreId,
    migrationId: profile.migrationId,
    markerHash: digest(profile),
  };
}
async function verifyAssetProfile(client, profile) {
  const identity = assetIdentity(profile);
  await client.query(
    "SELECT set_config('cartoteca.kind','platform',false),set_config('cartoteca.store_id',$1,false)",
    [identity.storeId],
  );
  const rows = (
    await client.query(
      "SELECT migration_id,marker_hash FROM cartoteca_catalog.asset_profiles WHERE kind='platform' AND store_id=$1",
      [identity.storeId],
    )
  ).rows;
  if (
    rows.length !== 1 ||
    rows[0].migration_id !== identity.migrationId ||
    rows[0].marker_hash !== identity.markerHash
  ) {
    const error = Error('PostgreSQL assets do not match their registered database.');
    error.code = 'POSTGRES_ASSET_PROFILE_MISMATCH';
    throw error;
  }
  return { verified: true, ...identity };
}
async function registerAssetProfile(client, profile) {
  const identity = assetIdentity(profile);
  await client.query(
    "SELECT set_config('cartoteca.kind','platform',false),set_config('cartoteca.store_id',$1,false)",
    [identity.storeId],
  );
  // Never replace a live binding. An unknown COMMIT must be reconciled, not
  // retried with another marker/migration ID against the same SQL store.
  await client.query(
    "INSERT INTO cartoteca_catalog.asset_profiles(kind,store_id,migration_id,marker_hash) VALUES('platform',$1,$2,$3) ON CONFLICT(kind,store_id) DO NOTHING",
    [identity.storeId, identity.migrationId, identity.markerHash],
  );
  return verifyAssetProfile(client, profile);
}
module.exports = {
  ensureCatalog,
  storeCatalog,
  nativeSignature,
  validatePostgresSchema,
  registerAssetProfile,
  verifyAssetProfile,
};
