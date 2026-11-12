const { identifier } = require('./catalog-sqlite.cjs');
const { functionBody169, RETURN_COLUMNS, ARG_TYPES } = require('./hot-metadata-sql169.cjs');
const { META, HEAD } = require('./directory-state-sql196.cjs');
const FUNCTION196 = 'cartoteca_catalog.hot_directory_metadata196';
const ARG_TYPES196 = ARG_TYPES + ',text,text,text[],text';
const MAX_SELECTED_BYTES196 = 2 * 1024 * 1024;
const RETURN_COLUMNS196 =
  RETURN_COLUMNS +
  `,
 directory_eligibility196 text,directory_component_epoch196 text,directory_component_digest196 text,
 directory_head_epoch196 text,directory_seq196 text,directory_floor196 text,directory_reset196 text,
 cabinet_revision196 bytea,selected_ids196 text[],selected_ciphers196 bytea[],
 selected_bytes196 bigint,selected_complete196 boolean`;
function replaceOnce(value, before, after) {
  if (value.split(before).length !== 2) throw Error('Metadata169 source contract changed');
  return value.replace(before, () => after);
}
// This is a new versioned function, not a call to169 followed by another SELECT.
// Its ONLY table-reading command remains one post-fence RETURN QUERY snapshot.
let functionBody196 = replaceOnce(
  functionBody169,
  ' fence_locked:=',
  ` IF p_state_epoch IS NULL OR p_state_epoch!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR
 p_state_digest IS NULL OR p_state_digest!~'^[a-f0-9]{64}$' OR p_selected IS NULL OR
 COALESCE(array_ndims(p_selected),1)<>1 OR cardinality(p_selected)>100 OR
  EXISTS(SELECT 1 FROM unnest(p_selected) q(id) WHERE q.id IS NULL OR length(q.id) NOT BETWEEN 1 AND 120 OR octet_length(convert_to(q.id,'UTF8'))>360) OR
 (SELECT count(DISTINCT q.id) FROM unnest(p_selected) q(id))<>cardinality(p_selected) OR
 p_audience IS NULL OR NOT(p_audience='*' OR p_audience~'^[a-f0-9]{64}$')
 THEN RAISE EXCEPTION 'Invalid directory196 arguments' USING ERRCODE='22023'; END IF;
 fence_locked:=`,
);
functionBody196 = replaceOnce(
  functionBody196,
  '\n )\n SELECT 1::bigint,true,v_isolation,',
  `
 ), d196 AS MATERIALIZED (
  SELECT h.epoch head_epoch,h.seq,h.floor_seq,h.reset_seq,m.epoch component_epoch,m.digest component_digest,
   a.membership_role,((a.membership_role IN('owner','salon_admin') AND p_audience='*') OR
    (a.membership_role='cosmetologist' AND p_audience~'^[a-f0-9]{64}$')) audience_ok
  FROM ${HEAD} h CROSS JOIN ${META} m CROSS JOIN b CROSS JOIN a CROSS JOIN v
   CROSS JOIN comp CROSS JOIN sm CROSS JOIN p CROSS JOIN c CROSS JOIN checks
  WHERE m.version=1 AND h.store_id=p_cabinet AND b.cabinet_store_id=p_cabinet
   AND pg_catalog.jsonb_array_length(v.rows)=3
   AND a.account_id=p_account AND a.organization_id=p_org AND a.organization_id IS NOT NULL AND a.global_admin=0
   AND a.account_status='active' AND a.membership_status='active' AND a.organization_status='active'
   AND a.expires_at>floor(extract(epoch FROM clock_timestamp())*1000)::bigint AND a.bytes<=p_authority_limit
   AND comp.epoch::text=p_component_epoch AND comp.digest=p_component_digest
   AND sm.epoch IS NOT NULL AND sm.digest IS NOT NULL
   AND comp.generation->>'migrationId'=p_migration AND comp.generation->>'markerHash'=p_marker_hash
   AND p.migration_id=p_migration AND p.marker_hash=p_marker_hash
   AND b.migration_id=p_migration AND b.marker_hash=p_marker_hash AND b.binding_epoch=comp.epoch AND checks.proof_ok
   AND p.matches AND c.matches AND p.version=p_p_version AND p.catalog_hash=p_p_hash
   AND c.version=p_c_version AND c.catalog_hash=p_c_hash
   AND b.platform_version=p.version AND b.platform_hash=p.catalog_hash
   AND b.cabinet_version=c.version AND b.cabinet_hash=c.catalog_hash
 ), rb196 AS MATERIALIZED (
  SELECT count(*) n,COALESCE(sum(octet_length(s.value)),0)::bigint bytes
  FROM cartoteca_cabinet.meta s CROSS JOIN d196
  WHERE s._store_id=p_cabinet AND s.key='revision'
   AND d196.component_epoch::text=p_state_epoch AND d196.component_digest=p_state_digest AND d196.audience_ok
 ), r196 AS MATERIALIZED (
  SELECT s.value FROM rb196 CROSS JOIN d196 JOIN cartoteca_cabinet.meta s
   ON s._store_id=p_cabinet AND s.key='revision'
  WHERE rb196.n=1 AND rb196.bytes<=65536 AND d196.component_epoch::text=p_state_epoch
   AND d196.component_digest=p_state_digest AND d196.audience_ok
 ), sb196 AS MATERIALIZED (
  SELECT count(*) n,COALESCE(sum(octet_length(s.value)),0)::bigint bytes
  FROM cartoteca_cabinet.cabinet_summaries s CROSS JOIN d196
  WHERE s._store_id=p_cabinet AND s.audience=p_audience AND s.patient_id=ANY(p_selected)
   AND d196.component_epoch::text=p_state_epoch AND d196.component_digest=p_state_digest AND d196.audience_ok
 ), sr196 AS MATERIALIZED (
  SELECT COALESCE(array_agg(s.patient_id ORDER BY s.patient_id COLLATE "C"),'{}'::text[]) ids,
   COALESCE(array_agg(s.value ORDER BY s.patient_id COLLATE "C"),'{}'::bytea[]) ciphers
  FROM cartoteca_cabinet.cabinet_summaries s CROSS JOIN sb196 CROSS JOIN d196
  WHERE s._store_id=p_cabinet AND s.audience=p_audience AND s.patient_id=ANY(p_selected)
   AND sb196.n=cardinality(p_selected) AND sb196.bytes<=${MAX_SELECTED_BYTES196}
   AND d196.component_epoch::text=p_state_epoch AND d196.component_digest=p_state_digest AND d196.audience_ok
 )
 SELECT 1::bigint,true,v_isolation,`,
);
functionBody196 = replaceOnce(
  functionBody196,
  ' a.global_admin::bigint,a.account_status,a.membership_role,a.membership_status,a.organization_status\n FROM',
  ` a.global_admin::bigint,a.account_status,a.membership_role,a.membership_status,a.organization_status,
 CASE WHEN d196.head_epoch IS NULL THEN 'state-unprepared'
  WHEN d196.component_epoch::text IS DISTINCT FROM p_state_epoch OR d196.component_digest IS DISTINCT FROM p_state_digest THEN 'state-generation'
  WHEN d196.audience_ok IS DISTINCT FROM true THEN 'audience'
  WHEN r196.value IS NULL THEN 'revision-size-or-missing'
  WHEN sb196.n<>cardinality(p_selected) THEN 'selected-missing'
  WHEN sb196.bytes>${MAX_SELECTED_BYTES196} THEN 'selected-size' ELSE 'ready' END,
 d196.component_epoch::text,d196.component_digest,d196.head_epoch::text,
 d196.seq::text,d196.floor_seq::text,d196.reset_seq::text,r196.value,
 sr196.ids,sr196.ciphers,sb196.bytes,
 (d196.head_epoch IS NOT NULL AND d196.component_epoch::text=p_state_epoch AND d196.component_digest=p_state_digest
  AND d196.audience_ok AND r196.value IS NOT NULL AND sb196.n=cardinality(p_selected) AND sb196.bytes<=${MAX_SELECTED_BYTES196})
 FROM`,
);
functionBody196 = replaceOnce(
  functionBody196,
  ' LEFT JOIN cartoteca_platform.platform_sessions ps ON ps._store_id=p_platform AND ps.id=a.id AND ps.token_hash=p_token_hash AND a.bytes<=p_authority_limit;',
  ` LEFT JOIN cartoteca_platform.platform_sessions ps ON ps._store_id=p_platform AND ps.id=a.id AND ps.token_hash=p_token_hash AND a.bytes<=p_authority_limit
 LEFT JOIN d196 ON true LEFT JOIN r196 ON true CROSS JOIN sb196 CROSS JOIN sr196;`,
);
function createDirectoryHotSQL196(role) {
  return `CREATE FUNCTION ${FUNCTION196}(p_platform text,p_migration text,p_marker_hash text,p_account text,p_org text,p_token_hash text,
 p_cabinet text,p_component_epoch text,p_component_digest text,p_p_version bigint,p_p_hash text,p_c_version bigint,p_c_hash text,p_authority_limit bigint,
 p_state_epoch text,p_state_digest text,p_selected text[],p_audience text)
 RETURNS TABLE(${RETURN_COLUMNS196}) LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog,pg_temp
 AS $body$${functionBody196}$body$;
 REVOKE ALL ON FUNCTION ${FUNCTION196}(${ARG_TYPES196}) FROM PUBLIC;
 GRANT EXECUTE ON FUNCTION ${FUNCTION196}(${ARG_TYPES196}) TO ${identifier(role)};`;
}
module.exports = {
  FUNCTION196,
  ARG_TYPES196,
  RETURN_COLUMNS196,
  MAX_SELECTED_BYTES196,
  functionBody196,
  createDirectoryHotSQL196,
};
