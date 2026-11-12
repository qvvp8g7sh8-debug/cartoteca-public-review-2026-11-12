const { createHash } = require('node:crypto');
const { identifier } = require('./catalog-sqlite.cjs');
const { KEYS } = require('./lock-intents.cjs');
const META = 'cartoteca_catalog.hot_read_component169';
const TABLE = 'cartoteca_catalog.hot_read_bindings169';
const FUNCTION = 'cartoteca_catalog.hot_read_metadata169';
const PROTOCOL = 1;
const MAX_AUTHORITY_BYTES = 65536;
const ARG_TYPES = 'text,text,text,text,text,text,text,text,text,bigint,text,bigint,text,bigint';
const bindingFields169 = (b) => [
  b.platform_store_id,
  b.organization_id,
  b.cabinet_store_id,
  b.migration_id,
  b.marker_hash,
  b.binding_epoch,
  String(b.platform_version),
  b.platform_hash,
  String(b.cabinet_version),
  b.cabinet_hash,
];
const bindingProof169 = (b) =>
  createHash('sha256')
    .update(JSON.stringify(bindingFields169(b)))
    .digest('hex');
const proofSQL = `pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
 pg_catalog.array_to_json(ARRAY[b.platform_store_id,b.organization_id,b.cabinet_store_id,
 b.migration_id,b.marker_hash,b.binding_epoch::text,b.platform_version::text,b.platform_hash,
 b.cabinet_version::text,b.cabinet_hash])::text,'UTF8')),'hex')`;
const RETURN_COLUMNS = `protocol169 bigint,fence_locked boolean,isolation169 text,eligibility169 text,
 component_epoch169 text,component_digest169 text,binding_epoch169 text,binding_proof_ok169 boolean,
 binding_org169 text,binding_cabinet169 text,lineage_migration169 text,lineage_marker169 text,
 p_catalog_version169 bigint,p_catalog_hash169 text,p_catalog_matches169 boolean,
 c_catalog_version169 bigint,c_catalog_hash169 text,c_catalog_matches169 boolean,
 scope_component_epoch169 text,scope_component_digest169 text,scope_rows169 jsonb,
 authority_bytes169 bigint,id text,account_id text,organization_id text,expires_at bigint,
 account_value bytea,session_value bytea,global_admin bigint,account_status text,
 membership_role text,membership_status text,organization_status text`;
// No table-reading command precedes the lock. All returned database values are
// read by the single RETURN QUERY below using its post-lock RC snapshot.
const functionBody169 = `
DECLARE v_isolation text;
BEGIN
 protocol169:=1;
 v_isolation:=pg_catalog.current_setting('transaction_isolation'); isolation169:=v_isolation;
 IF v_isolation<>'read committed' THEN eligibility169:='isolation'; RETURN NEXT; RETURN; END IF;
 IF p_platform IS NULL OR p_migration IS NULL OR p_marker_hash IS NULL OR p_account IS NULL OR
 p_org IS NULL OR p_token_hash IS NULL OR p_cabinet IS NULL OR p_component_epoch IS NULL OR
 p_component_digest IS NULL OR p_p_version IS NULL OR p_p_hash IS NULL OR
 p_c_version IS NULL OR p_c_hash IS NULL OR p_authority_limit IS NULL OR
 pg_catalog.length(p_platform) NOT BETWEEN 1 AND 120 OR pg_catalog.length(p_migration) NOT BETWEEN 1 AND 120 OR
 pg_catalog.length(p_account) NOT BETWEEN 1 AND 120 OR pg_catalog.length(p_org) NOT BETWEEN 1 AND 120 OR
 pg_catalog.length(p_cabinet) NOT BETWEEN 1 AND 120 OR
 p_marker_hash!~'^[a-f0-9]{64}$' OR p_token_hash!~'^[a-f0-9]{64}$' OR
 p_component_digest!~'^[a-f0-9]{64}$' OR p_p_hash!~'^[a-f0-9]{64}$' OR p_c_hash!~'^[a-f0-9]{64}$' OR
 p_component_epoch!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR
 p_p_version NOT IN(19,20) OR p_c_version NOT IN(1,2) OR p_authority_limit NOT BETWEEN 1 AND 65536
 THEN RAISE EXCEPTION 'Invalid metadata169 arguments' USING ERRCODE='22023'; END IF;
 fence_locked:=pg_catalog.pg_try_advisory_xact_lock_shared(${KEYS.maintenance}::bigint);
 IF NOT fence_locked THEN eligibility169:='busy'; RETURN NEXT; RETURN; END IF;
 RETURN QUERY
 WITH comp AS MATERIALIZED (SELECT m.epoch,m.digest,m.prepared_generations->p_platform generation FROM ${META} m WHERE m.version=1),
 sm AS MATERIALIZED (SELECT m.epoch,m.digest FROM cartoteca_catalog.read_scope_component163 m WHERE m.version=1),
 p AS MATERIALIZED (
  SELECT s.version,s.catalog_hash,s.metadata=t.metadata AS matches,
   ap.migration_id,ap.marker_hash
  FROM cartoteca_catalog.stores s
  JOIN cartoteca_catalog.templates t ON t.kind=s.kind AND t.version=s.version AND t.catalog_hash=s.catalog_hash
  LEFT JOIN cartoteca_catalog.asset_profiles ap ON ap.kind=s.kind AND ap.store_id=s.store_id
  WHERE s.kind='platform' AND s.store_id=p_platform
 ), a AS MATERIALIZED (
  SELECT s.id,s.account_id,s.organization_id,s.expires_at,ac.global_admin,ac.status account_status,
   m.role membership_role,m.status membership_status,o.status organization_status,
   (pg_catalog.octet_length(ac.value)::bigint+pg_catalog.octet_length(s.value)::bigint) bytes
  FROM cartoteca_platform.platform_sessions s
  JOIN cartoteca_platform.accounts ac ON ac._store_id=s._store_id AND ac.id=s.account_id
  LEFT JOIN cartoteca_platform.memberships m ON m._store_id=s._store_id AND m.organization_id=s.organization_id AND m.account_id=s.account_id
  LEFT JOIN cartoteca_platform.organizations o ON o._store_id=s._store_id AND o.id=s.organization_id
  WHERE s._store_id=p_platform AND s.token_hash=p_token_hash
 ), b AS MATERIALIZED (
  SELECT r.* FROM ${TABLE} r CROSS JOIN a
  WHERE r.platform_store_id=p_platform AND r.organization_id=p_org
   AND a.account_id=p_account AND a.organization_id=p_org AND a.global_admin=0
   AND a.account_status='active' AND a.membership_status='active' AND a.organization_status='active'
 ), c AS MATERIALIZED (
  SELECT s.version,s.catalog_hash,s.metadata=t.metadata AS matches
  FROM b JOIN cartoteca_catalog.stores s ON s.kind='cabinet' AND s.store_id=b.cabinet_store_id
  JOIN cartoteca_catalog.templates t ON t.kind=s.kind AND t.version=s.version AND t.catalog_hash=s.catalog_hash
 ), checks AS MATERIALIZED (
  SELECT ${proofSQL}=b.binding_proof AS proof_ok FROM b
 ), v AS MATERIALIZED (
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
    x.kind,x.store_id,x.scope_id,x.epoch::text,x.revision::text)
    ORDER BY CASE x.kind WHEN 'platform' THEN 0 ELSE 1 END,x.scope_id COLLATE "C"),'[]'::jsonb) rows
  FROM cartoteca_catalog.read_scope_versions163 x CROSS JOIN a CROSS JOIN b CROSS JOIN p CROSS JOIN c CROSS JOIN comp CROSS JOIN checks
  WHERE a.account_id=p_account AND a.organization_id=p_org AND a.global_admin=0 AND a.bytes<=p_authority_limit
   AND a.account_status='active' AND a.membership_status='active' AND a.organization_status='active'
   AND comp.epoch::text=p_component_epoch AND comp.digest=p_component_digest
   AND comp.generation->>'migrationId'=p_migration AND comp.generation->>'markerHash'=p_marker_hash
   AND p.migration_id=p_migration AND p.marker_hash=p_marker_hash
   AND b.migration_id=p_migration AND b.marker_hash=p_marker_hash AND b.binding_epoch=comp.epoch
   AND b.cabinet_store_id=p_cabinet AND checks.proof_ok
   AND p.matches AND c.matches AND p.version=p_p_version AND p.catalog_hash=p_p_hash
   AND c.version=p_c_version AND c.catalog_hash=p_c_hash
   AND b.platform_version=p.version AND b.platform_hash=p.catalog_hash
   AND b.cabinet_version=c.version AND b.cabinet_hash=c.catalog_hash
   AND ((x.kind='platform' AND x.store_id=p_platform AND x.scope_id IN('*',p_org)) OR
        (x.kind='cabinet' AND x.store_id=p_cabinet AND x.scope_id='*'))
 )
 SELECT 1::bigint,true,v_isolation,
 CASE
  WHEN comp.epoch IS NULL OR comp.digest IS DISTINCT FROM p_component_digest OR p.version IS NULL OR
   p.matches IS DISTINCT FROM true OR p.migration_id IS NULL OR p.marker_hash IS NULL OR sm.epoch IS NULL OR sm.digest IS NULL
   THEN 'dependency-invalid'
  WHEN a.id IS NULL THEN 'authority'
  WHEN a.bytes>p_authority_limit THEN 'authority-size'
  WHEN a.organization_id IS NULL THEN 'session-selection'
  WHEN a.account_id<>p_account OR a.organization_id<>p_org THEN 'context'
  WHEN a.global_admin<>0 OR a.account_status<>'active' OR a.membership_status IS DISTINCT FROM 'active' OR
   a.organization_status IS DISTINCT FROM 'active' THEN 'authority'
  WHEN comp.epoch::text<>p_component_epoch THEN 'component-generation'
  WHEN comp.generation IS NULL OR comp.generation->>'migrationId' IS DISTINCT FROM p_migration OR
   comp.generation->>'markerHash' IS DISTINCT FROM p_marker_hash THEN 'marker-generation'
  WHEN p.migration_id<>p_migration OR p.marker_hash<>p_marker_hash THEN 'marker-generation'
  WHEN b.organization_id IS NULL THEN 'binding-unprepared'
  WHEN checks.proof_ok IS DISTINCT FROM true OR b.cabinet_store_id<>p_cabinet OR b.binding_epoch<>comp.epoch THEN 'binding-invalid'
  WHEN b.migration_id<>p_migration OR b.marker_hash<>p_marker_hash THEN 'marker-generation'
  WHEN c.version IS NULL OR c.matches IS DISTINCT FROM true THEN 'dependency-invalid'
  WHEN p.version<>p_p_version OR p.catalog_hash<>p_p_hash OR c.version<>p_c_version OR c.catalog_hash<>p_c_hash OR
   b.platform_version<>p.version OR b.platform_hash<>p.catalog_hash OR b.cabinet_version<>c.version OR b.cabinet_hash<>c.catalog_hash
   THEN 'catalog-generation'
  WHEN pg_catalog.jsonb_array_length(v.rows)<>3 THEN 'clock-missing'
  ELSE 'ready' END,
 comp.epoch::text,comp.digest,b.binding_epoch::text,checks.proof_ok,b.organization_id,b.cabinet_store_id,
 p.migration_id,p.marker_hash,p.version,p.catalog_hash,p.matches,c.version,c.catalog_hash,c.matches,
 sm.epoch::text,sm.digest,v.rows,a.bytes,a.id,a.account_id,a.organization_id,a.expires_at,
 CASE WHEN a.bytes<=p_authority_limit THEN ac.value ELSE NULL::bytea END,
 CASE WHEN a.bytes<=p_authority_limit THEN ps.value ELSE NULL::bytea END,
 a.global_admin::bigint,a.account_status,a.membership_role,a.membership_status,a.organization_status
 FROM (VALUES(1)) seed(n) LEFT JOIN comp ON true LEFT JOIN sm ON true LEFT JOIN p ON true
 LEFT JOIN a ON true LEFT JOIN b ON true LEFT JOIN c ON true LEFT JOIN checks ON true CROSS JOIN v
 LEFT JOIN cartoteca_platform.accounts ac ON ac._store_id=p_platform AND ac.id=a.account_id AND a.bytes<=p_authority_limit
 LEFT JOIN cartoteca_platform.platform_sessions ps ON ps._store_id=p_platform AND ps.id=a.id AND ps.token_hash=p_token_hash AND a.bytes<=p_authority_limit;
END `;
function createHotMetadataSQL169(role) {
  const app = identifier(role);
  return `CREATE TABLE ${META}(version bigint PRIMARY KEY CHECK(version=1),epoch uuid NOT NULL,
 signature jsonb NOT NULL,digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),prepared_generations jsonb NOT NULL);
 CREATE TABLE ${TABLE}(platform_store_id text COLLATE "C" NOT NULL,organization_id text COLLATE "C" NOT NULL,
 cabinet_store_id text COLLATE "C" NOT NULL,migration_id text COLLATE "C" NOT NULL,marker_hash text COLLATE "C" NOT NULL CHECK(marker_hash~'^[a-f0-9]{64}$'),
 binding_epoch uuid NOT NULL,platform_version bigint NOT NULL CHECK(platform_version IN(19,20)),platform_hash text NOT NULL CHECK(platform_hash~'^[a-f0-9]{64}$'),
 cabinet_version bigint NOT NULL CHECK(cabinet_version IN(1,2)),cabinet_hash text NOT NULL CHECK(cabinet_hash~'^[a-f0-9]{64}$'),
 binding_proof text NOT NULL CHECK(binding_proof~'^[a-f0-9]{64}$'),
 PRIMARY KEY(platform_store_id,organization_id),UNIQUE(platform_store_id,cabinet_store_id),
 CHECK(pg_catalog.length(platform_store_id) BETWEEN 1 AND 120 AND pg_catalog.length(organization_id) BETWEEN 1 AND 120 AND
 pg_catalog.length(cabinet_store_id) BETWEEN 1 AND 120 AND pg_catalog.length(migration_id) BETWEEN 1 AND 120));
 ALTER TABLE ${META} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${META} FORCE ROW LEVEL SECURITY;
 ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY;
 REVOKE ALL ON ${META},${TABLE} FROM PUBLIC; REVOKE ALL ON ${META},${TABLE} FROM ${app};
 GRANT SELECT ON ${META} TO ${app};
 CREATE POLICY read_component169 ON ${META} FOR SELECT TO ${app} USING(true);
 CREATE POLICY owner_component169 ON ${META} FOR ALL TO CURRENT_USER USING(true) WITH CHECK(true);
 CREATE POLICY owner_binding169 ON ${TABLE} FOR ALL TO CURRENT_USER USING(true) WITH CHECK(true);
 CREATE FUNCTION ${FUNCTION}(p_platform text,p_migration text,p_marker_hash text,p_account text,p_org text,p_token_hash text,
 p_cabinet text,p_component_epoch text,p_component_digest text,p_p_version bigint,p_p_hash text,p_c_version bigint,p_c_hash text,p_authority_limit bigint)
 RETURNS TABLE(${RETURN_COLUMNS}) LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog,pg_temp
 AS $body$${functionBody169}$body$;
 REVOKE ALL ON FUNCTION ${FUNCTION}(${ARG_TYPES}) FROM PUBLIC;
 GRANT EXECUTE ON FUNCTION ${FUNCTION}(${ARG_TYPES}) TO ${app};`;
}
module.exports = {
  META,
  TABLE,
  FUNCTION,
  PROTOCOL,
  MAX_AUTHORITY_BYTES,
  ARG_TYPES,
  RETURN_COLUMNS,
  functionBody169,
  createHotMetadataSQL169,
  bindingFields169,
  bindingProof169,
};
