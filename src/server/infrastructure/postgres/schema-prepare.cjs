const { identifier: q, namespace, digest } = require('./catalog-sqlite.cjs');
const { nativeSchemaPlan } = require('./schema-plan.cjs');
const {
  ensureCatalog,
  storeCatalog,
  nativeSignature,
  validatePostgresSchema,
} = require('./catalog-postgres.cjs');
const provisionSQL = `CREATE OR REPLACE FUNCTION cartoteca_catalog.provision_store(p_kind TEXT,p_store TEXT,p_version BIGINT,p_hash TEXT,p_platform TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE template JSONB; existing TEXT;
BEGIN
 IF p_kind<>'cabinet' OR p_store !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR p_platform !~ '^[a-f0-9-]{36}$' THEN RAISE EXCEPTION 'Invalid cabinet provisioning scope' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM cartoteca_platform.organizations WHERE _store_id=p_platform AND id=p_store) THEN RAISE EXCEPTION 'Cabinet organization is missing' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('cartoteca-store:'||p_store,0));
 SELECT catalog_hash INTO existing FROM cartoteca_catalog.stores WHERE kind=p_kind AND store_id=p_store;
 IF FOUND THEN
  IF existing<>p_hash THEN RAISE EXCEPTION 'Prepared cabinet profile mismatch' USING ERRCODE='23514'; END IF;
  RETURN FALSE;
 END IF;
 SELECT metadata INTO template FROM cartoteca_catalog.templates WHERE kind=p_kind AND version=p_version AND catalog_hash=p_hash;
 IF NOT FOUND THEN RAISE EXCEPTION 'Unregistered cabinet template' USING ERRCODE='23514'; END IF;
 INSERT INTO cartoteca_catalog.stores(kind,store_id,version,catalog_hash,metadata) VALUES(p_kind,p_store,p_version,p_hash,template);
 INSERT INTO cartoteca_catalog.objects SELECT p_kind,p_store,x.type,x.name,x.tbl_name,x.sql FROM jsonb_to_recordset(template->'objects') x(type TEXT,name TEXT,tbl_name TEXT,sql TEXT);
 INSERT INTO cartoteca_catalog.columns SELECT p_kind,p_store,t.key,c.cid,c.name,c.type,c."notnull",c.dflt_value,c.pk FROM jsonb_each(template->'tables') t CROSS JOIN LATERAL jsonb_to_recordset(t.value->'columns') c(cid BIGINT,name TEXT,type TEXT,"notnull" BIGINT,dflt_value TEXT,pk BIGINT);
 INSERT INTO cartoteca_catalog.indexes SELECT p_kind,p_store,t.key,i.seq,i.name,i."unique",i.origin,i.partial FROM jsonb_each(template->'tables') t CROSS JOIN LATERAL jsonb_to_recordset(t.value->'indexes') i(seq BIGINT,name TEXT,"unique" BIGINT,origin TEXT,partial BIGINT);
 INSERT INTO cartoteca_catalog.index_columns SELECT p_kind,p_store,i->>'name',c.seqno,c.cid,c.name,c."desc",c.coll,c."key" FROM jsonb_each(template->'tables') t CROSS JOIN LATERAL jsonb_array_elements(t.value->'indexes') i CROSS JOIN LATERAL jsonb_to_recordset(i->'columns') c(seqno BIGINT,cid BIGINT,name TEXT,"desc" BIGINT,coll TEXT,"key" BIGINT);
 RETURN TRUE;
END $body$;
REVOKE ALL ON FUNCTION cartoteca_catalog.provision_store(TEXT,TEXT,BIGINT,TEXT,TEXT) FROM PUBLIC;`;
async function preparePostgresSchema(
  client,
  { kind, storeId, source, applicationRole, register = true } = {},
) {
  const plan = nativeSchemaPlan(kind, source);
  await ensureCatalog(client, applicationRole);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('cartoteca-schema',0))");
  const previous = (
    await client.query('SELECT kind FROM cartoteca_catalog.native_manifests WHERE kind=$1', [kind])
  ).rows[0];
  if (previous) await validatePostgresSchema(client, { kind, applicationRole });
  for (const object of plan.objects) {
    const hash = digest(object.sql);
    const existing = (
      await client.query(
        'SELECT definition_hash FROM cartoteca_catalog.native_objects WHERE kind=$1 AND type=$2 AND name=$3 AND table_name=$4',
        [kind, object.type, object.name, object.table],
      )
    ).rows[0];
    if (existing) {
      if (existing.definition_hash !== hash)
        throw Error('Native schema requires an explicit structural upgrade: ' + object.name);
      continue;
    }
    try {
      await client.query(object.sql);
    } catch (error) {
      // Object identifiers are canonical source names, never record data.
      error.nativeSchemaObject = {
        kind,
        type: object.type,
        name: object.name,
        table: object.table,
      };
      throw error;
    }
    await client.query('INSERT INTO cartoteca_catalog.native_objects VALUES($1,$2,$3,$4,$5,$6)', [
      kind,
      object.type,
      object.name,
      object.table,
      hash,
      object.sql,
    ]);
  }
  const schema = q(namespace(kind));
  await client.query('REVOKE ALL ON SCHEMA ' + schema + ' FROM PUBLIC');
  await client.query(
    'GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ' +
      schema +
      ' TO ' +
      q(applicationRole),
  );
  await client.query(
    'GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ' + schema + ' TO ' + q(applicationRole),
  );
  if (kind === 'platform') {
    await client.query(provisionSQL);
    await client.query(
      'GRANT EXECUTE ON FUNCTION cartoteca_catalog.provision_store(TEXT,TEXT,BIGINT,TEXT,TEXT) TO ' +
        q(applicationRole),
    );
  }
  const signature = await nativeSignature(client, kind);
  await client.query(
    'INSERT INTO cartoteca_catalog.native_manifests VALUES($1,$2,$3) ON CONFLICT(kind) DO UPDATE SET signature=excluded.signature,digest=excluded.digest',
    [kind, signature, digest(signature)],
  );
  await client.query(
    'INSERT INTO cartoteca_catalog.templates VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
    [kind, source.version, digest(source), source],
  );
  const registered = register ? await storeCatalog(client, { kind, storeId, source }) : null;
  await validatePostgresSchema(client, { kind, applicationRole });
  return { ...registered, planHash: plan.hash };
}
async function registerCanonicalTemplate(client, { kind, source }) {
  // Its physical union must already contain every native object required here.
  const plan = nativeSchemaPlan(kind, source);
  for (const object of plan.objects) {
    const row = (
      await client.query(
        'SELECT definition_hash FROM cartoteca_catalog.native_objects WHERE kind=$1 AND type=$2 AND name=$3 AND table_name=$4',
        [kind, object.type, object.name, object.table],
      )
    ).rows[0];
    if (!row || row.definition_hash !== digest(object.sql))
      throw Error('Template physical schema is not prepared.');
  }
  await client.query(
    'INSERT INTO cartoteca_catalog.templates VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
    [kind, source.version, digest(source), source],
  );
  return digest(source);
}
module.exports = { preparePostgresSchema, registerCanonicalTemplate, provisionSQL };
