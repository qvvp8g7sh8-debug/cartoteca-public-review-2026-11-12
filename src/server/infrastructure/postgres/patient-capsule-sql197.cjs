const { identifier } = require('./catalog-sqlite.cjs');
const { KEYS } = require('./lock-intents.cjs');
const { functionBody169, ARG_TYPES: ARGS169 } = require('./hot-metadata-sql169.cjs');
const { modes, sourceSQL197, bodySQL197 } = require('./patient-capsule-plan197.cjs');
const META = 'cartoteca_catalog.patient_read_component197';
const FUNCTION = 'cartoteca_catalog.patient_read_capsule197';
const ARG_TYPES = ARGS169 + ',text,text,text,text,text,text,bigint[],text,text';
const RETURN_COLUMNS =
  'section197 text,payload197 jsonb,cipher197 bytea,account197 bytea,session197 bytea';
const MAX_SOURCE_BYTES197 = 65536;
const MAX_BODY_ROWS197 = 199;
const first = functionBody169.indexOf(' WITH comp AS MATERIALIZED'),
  last = functionBody169.indexOf(' ), v AS MATERIALIZED');
if (first < 0 || last <= first) throw Error('Metadata169 CTE source contract changed.');
// Reuse the exact existing authority/catalog/binding checks, without the global
// clock cohort which a point read does not consume. No169 function is modified.
const baseCTEs = functionBody169.slice(first, last) + '\n )';
const sourceUnion = modes
  .map((mode) => `SELECT q.* FROM (${sourceSQL197(mode)}) q WHERE p_kind='${mode}'`)
  .join('\nUNION ALL\n');
const bodies = modes
  .map(
    (mode, i) => `${i ? 'ELSIF' : 'IF'} p_kind='${mode}' THEN
 RETURN QUERY SELECT 'body197'::text,to_jsonb(q)-'value',q.value,NULL::bytea,NULL::bytea FROM (${bodySQL197(mode)}) q;`,
  )
  .join('\n');
const functionBody197 = `
DECLARE v_locked boolean;v_released boolean;v_header jsonb;v_sources jsonb;
 v_reason text;v_account bytea;v_session bytea;v_bytes bigint;v_rows bigint;
BEGIN
 IF current_setting('transaction_isolation')<>'repeatable read' OR
 current_setting('transaction_read_only')<>'on' OR
 current_setting('cartoteca.kind',true) IS DISTINCT FROM 'platform' OR
 current_setting('cartoteca.store_id',true) IS DISTINCT FROM p_platform
 THEN RAISE EXCEPTION 'Invalid capsule197 lifecycle' USING ERRCODE='22023'; END IF;
 IF p_kind IS NULL OR p_kind NOT IN('card','history','upcoming','appointment') OR
 p_patient IS NULL OR length(p_patient) NOT BETWEEN 1 AND 120 OR octet_length(convert_to(p_patient,'UTF8'))>360 OR
 p_audience IS NULL OR NOT(p_audience='*' OR p_audience~'^[a-f0-9]{64}$') OR
 p_cursors IS NULL OR cardinality(p_cursors)<>3 OR array_ndims(p_cursors)<>1 OR
 EXISTS(SELECT 1 FROM unnest(p_cursors) x(n) WHERE x.n IS NULL OR x.n NOT BETWEEN 0 AND 9007199254740940) OR
 (p_kind='appointment' AND(p_appointment IS NULL OR length(p_appointment) NOT BETWEEN 1 AND 120 OR octet_length(convert_to(p_appointment,'UTF8'))>360)) OR
 p_session IS NULL OR p_role IS NULL OR p_role NOT IN('owner','salon_admin','cosmetologist') OR
 p_platform IS NULL OR p_cabinet IS NULL OR p_org IS NULL OR p_account IS NULL OR p_migration IS NULL OR
 EXISTS(SELECT 1 FROM unnest(ARRAY[p_platform,p_cabinet,p_org,p_account,p_session,p_migration,p_component_epoch,p_capsule_epoch]) u(id)
 WHERE u.id IS NULL OR u.id!~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') OR
 p_authority_limit IS DISTINCT FROM 65536 OR p_p_version NOT IN(19,20) OR p_c_version<>2 OR
 p_token_hash IS NULL OR p_token_hash!~'^[a-f0-9]{64}$' OR
 p_marker_hash IS NULL OR p_marker_hash!~'^[a-f0-9]{64}$' OR
 p_p_hash IS NULL OR p_p_hash!~'^[a-f0-9]{64}$' OR p_c_hash IS NULL OR p_c_hash!~'^[a-f0-9]{64}$' OR
 p_component_epoch IS NULL OR p_component_digest IS NULL OR p_component_digest!~'^[a-f0-9]{64}$' OR
 p_capsule_epoch IS NULL OR p_capsule_digest IS NULL OR p_capsule_digest!~'^[a-f0-9]{64}$'
 THEN RAISE EXCEPTION 'Invalid capsule197 arguments' USING ERRCODE='22023'; END IF;
 -- A matching session fence was acquired by this physical owner BEFORE BEGIN.
 -- The transaction fence is established before its one matching unlock.
 v_locked:=pg_try_advisory_xact_lock_shared(${KEYS.maintenance}::bigint);
 v_released:=pg_advisory_unlock_shared(${KEYS.maintenance}::bigint);
 ${baseCTEs}, cm197 AS MATERIALIZED(SELECT m.epoch,m.digest FROM ${META} m WHERE m.version=1),
 e197 AS MATERIALIZED(
 SELECT true allowed FROM comp CROSS JOIN p CROSS JOIN a CROSS JOIN b CROSS JOIN c CROSS JOIN checks CROSS JOIN cm197
 WHERE v_locked AND v_released AND comp.epoch::text=p_component_epoch AND comp.digest=p_component_digest
 AND cm197.epoch::text=p_capsule_epoch AND cm197.digest=p_capsule_digest
 AND comp.generation->>'migrationId'=p_migration AND comp.generation->>'markerHash'=p_marker_hash
 AND p.migration_id=p_migration AND p.marker_hash=p_marker_hash
 AND b.migration_id=p_migration AND b.marker_hash=p_marker_hash AND b.binding_epoch=comp.epoch
 AND b.cabinet_store_id=p_cabinet AND checks.proof_ok
 AND p.matches AND c.matches AND p.version=p_p_version AND p.catalog_hash=p_p_hash
 AND c.version=p_c_version AND c.catalog_hash=p_c_hash
 AND b.platform_version=p.version AND b.platform_hash=p.catalog_hash
 AND b.cabinet_version=c.version AND b.cabinet_hash=c.catalog_hash
 AND a.id=p_session AND a.account_id=p_account AND a.organization_id=p_org AND a.global_admin=0
 AND a.account_status='active' AND a.membership_status='active' AND a.organization_status='active'
 AND a.membership_role=p_role AND a.expires_at>floor(extract(epoch FROM clock_timestamp())*1000)::bigint
 AND a.bytes<=65536 AND ((p_role IN('owner','salon_admin') AND p_audience='*') OR(p_role='cosmetologist' AND p_audience~'^[a-f0-9]{64}$'))
 ), src197 AS MATERIALIZED(
 SELECT q.* FROM (${sourceUnion}) q WHERE EXISTS(SELECT 1 FROM e197)
 ), sb197 AS MATERIALIZED(
 SELECT COALESCE(sum(q.bytes),0)::bigint bytes,COALESCE(sum(q.rows),0)::bigint rows,
 COALESCE(jsonb_agg(to_jsonb(q) ORDER BY q.source),'[]'::jsonb) sources FROM src197 q
 ), empty197 AS MATERIALIZED(
 SELECT CASE WHEN EXISTS(SELECT 1 FROM e197) THEN NOT EXISTS(SELECT 1 FROM cartoteca_cabinet.cabinet_history_entries h
 WHERE h._store_id=p_cabinet AND h.patient_id=p_patient AND h.audience=p_audience AND h.stream='upcoming') ELSE true END empty
 ), provenance197 AS MATERIALIZED(
 SELECT count(*)::bigint rows,COALESCE(sum(64+48+2*(COALESCE(octet_length(r.id),0)+COALESCE(octet_length(r.organization_id),0)+COALESCE(octet_length(r.staff_id),0)+COALESCE(octet_length(r.request_key),0)+COALESCE(octet_length(r.status),0)+COALESCE(octet_length(r.day_key),0))+COALESCE(octet_length(r.value),0)),0)::bigint bytes
 FROM cartoteca_platform.booking_requests r CROSS JOIN empty197 z
 WHERE NOT z.empty AND p_kind IN('card','upcoming') AND EXISTS(SELECT 1 FROM e197)
 AND r._store_id=p_platform AND r.organization_id=p_org AND r.status IN('accepted','pending','requested','expired')
 )
 SELECT jsonb_build_object('locked',v_locked,'released',v_released,'snapshot',pg_current_snapshot()::text,
 'version',p.version,'catalog_hash',p.catalog_hash,'catalog_matches',p.matches,
 'cabinetCatalog',jsonb_build_object('version',c.version,'hash',c.catalog_hash,'matches',c.matches),
 'componentEpoch',cm197.epoch::text,'componentDigest',cm197.digest,
 'reason',CASE WHEN NOT v_locked OR NOT v_released THEN 'fence'
 WHEN comp.epoch::text IS DISTINCT FROM p_component_epoch OR comp.digest IS DISTINCT FROM p_component_digest OR
 cm197.epoch::text IS DISTINCT FROM p_capsule_epoch OR cm197.digest IS DISTINCT FROM p_capsule_digest OR
 p.version IS DISTINCT FROM p_p_version OR p.catalog_hash IS DISTINCT FROM p_p_hash OR p.matches IS DISTINCT FROM true OR
 c.version IS DISTINCT FROM p_c_version OR c.catalog_hash IS DISTINCT FROM p_c_hash OR c.matches IS DISTINCT FROM true THEN 'dependency'
 WHEN NOT EXISTS(SELECT 1 FROM e197) THEN 'authority'
 WHEN sb197.bytes>${MAX_SOURCE_BYTES197} OR sb197.rows>1024 THEN 'size'
 WHEN provenance197.bytes>8388608 THEN 'provenance' ELSE 'ready' END,
 'patientPageEmpty165',empty197.empty,'provenanceBound',jsonb_build_object('rows',provenance197.rows,'bytes',provenance197.bytes),
 'authority',jsonb_build_object('fence_locked',v_locked,'id',a.id,'account_id',a.account_id,'organization_id',a.organization_id,
 'expires_at',a.expires_at::text,'global_admin',a.global_admin::bigint,'account_status',a.account_status,
 'membership_role',a.membership_role,'membership_status',a.membership_status,'organization_status',a.organization_status)),
 sb197.sources,sb197.bytes,sb197.rows,
 CASE WHEN EXISTS(SELECT 1 FROM e197) THEN ac.value END,CASE WHEN EXISTS(SELECT 1 FROM e197) THEN ps.value END
 INTO v_header,v_sources,v_bytes,v_rows,v_account,v_session
 FROM (SELECT 1) z LEFT JOIN comp ON true LEFT JOIN p ON true LEFT JOIN a ON true LEFT JOIN b ON true LEFT JOIN c ON true LEFT JOIN cm197 ON true
 CROSS JOIN sb197 CROSS JOIN empty197 CROSS JOIN provenance197
 LEFT JOIN cartoteca_platform.accounts ac ON ac._store_id=p_platform AND ac.id=a.account_id AND a.bytes<=65536
 LEFT JOIN cartoteca_platform.platform_sessions ps ON ps._store_id=p_platform AND ps.id=a.id AND a.bytes<=65536;
 -- All statements inside this function use the unchanged owning RR snapshot.
 -- Explicit metadata-first control, not an optimizer-dependent body WHERE gate.
 section197:='guard197';payload197:=v_header;cipher197:=NULL;account197:=v_account;session197:=v_session;RETURN NEXT;
 RETURN QUERY SELECT 'source197'::text,x,NULL::bytea,NULL::bytea,NULL::bytea FROM jsonb_array_elements(v_sources) x;
 v_reason:=v_header->>'reason';
 IF v_reason<>'ready' THEN RETURN; END IF;
 ${bodies}
 END IF;
END;`;
function createPatientCapsuleSQL197(role) {
  return `CREATE FUNCTION ${FUNCTION}(p_platform text,p_migration text,p_marker_hash text,p_account text,p_org text,p_token_hash text,
 p_cabinet text,p_component_epoch text,p_component_digest text,p_p_version bigint,p_p_hash text,p_c_version bigint,p_c_hash text,p_authority_limit bigint,
 p_session text,p_role text,p_kind text,p_patient text,p_appointment text,p_audience text,p_cursors bigint[],p_capsule_epoch text,p_capsule_digest text)
 RETURNS TABLE(${RETURN_COLUMNS}) LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog,pg_temp
 AS $body$${functionBody197}$body$;
 REVOKE ALL ON FUNCTION ${FUNCTION}(${ARG_TYPES}) FROM PUBLIC;
 GRANT EXECUTE ON FUNCTION ${FUNCTION}(${ARG_TYPES}) TO ${identifier(role)};`;
}
module.exports = {
  META,
  FUNCTION,
  ARG_TYPES,
  RETURN_COLUMNS,
  functionBody197,
  createPatientCapsuleSQL197,
  MAX_SOURCE_BYTES197,
  MAX_BODY_ROWS197,
};
