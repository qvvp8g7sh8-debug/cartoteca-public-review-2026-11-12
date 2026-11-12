const { identifier } = require('./catalog-sqlite.cjs');
const META = 'cartoteca_catalog.directory_state_component196';
const HEAD = 'cartoteca_catalog.directory_state_heads196';
const CHANGES = 'cartoteca_catalog.directory_state_changes196';
const RECORD = 'cartoteca_catalog.record_directory_state196';
const TRIGGER = 'cartoteca_catalog.change_directory_state196';
const MAX_CHANGES = 4096;
const SEQ_WINDOW = 128;
const MAX_SEQ = 9007199254740991;
const RECORD_ARGS = 'text,text,text,text,boolean,boolean,boolean';
// The row lock, head and feed all belong to the caller's transaction. Sequence
// allocation cannot outrun commit order: the next writer waits for this lock.
const recordBody196 = `
DECLARE h RECORD; tx xid8; removed bigint; inserted bigint;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM cartoteca_catalog.stores s
  WHERE s.kind='cabinet' AND s.store_id=p_store AND s.version=2) THEN RETURN; END IF;
 tx:=pg_current_xact_id();
 INSERT INTO ${HEAD}(store_id,last_xid) VALUES(p_store,'0'::xid8) ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT h FROM ${HEAD} WHERE store_id=p_store FOR UPDATE;
 IF h.last_xid IS DISTINCT FROM tx THEN
  IF h.seq>=${MAX_SEQ} THEN
   DELETE FROM ${CHANGES} WHERE store_id=p_store;
   UPDATE ${HEAD} SET epoch=gen_random_uuid(),seq=1,floor_seq=1,reset_seq=1,
    last_xid=tx,change_count=0 WHERE store_id=p_store RETURNING * INTO h;
  ELSE
   UPDATE ${HEAD} SET seq=seq+1,last_xid=tx WHERE store_id=p_store RETURNING * INTO h;
   DELETE FROM ${CHANGES} WHERE store_id=p_store AND seq<=h.seq-${SEQ_WINDOW};
   GET DIAGNOSTICS removed=ROW_COUNT;
   UPDATE ${HEAD} SET floor_seq=GREATEST(floor_seq,h.seq-${SEQ_WINDOW}),
    change_count=change_count-removed WHERE store_id=p_store RETURNING * INTO h;
  END IF;
 END IF;
 IF p_reset OR p_digest IS NULL OR p_digest!~'^[a-f0-9]{64}$' OR
  p_audience IS NULL OR NOT(p_audience='*' OR p_audience~'^[a-f0-9]{64}$') OR
  (p_patient IS NOT NULL AND (length(p_patient) NOT BETWEEN 1 AND 120 OR
   encode(sha256(convert_to(p_patient,'UTF8')),'hex')<>p_digest)) THEN
  DELETE FROM ${CHANGES} WHERE store_id=p_store;
  UPDATE ${HEAD} SET floor_seq=seq,reset_seq=seq,change_count=0 WHERE store_id=p_store;
  RETURN;
 END IF;
 -- A reset/overflow transaction is deliberately not a partial journal. The
 -- following transaction can append again; every earlier reader must bootstrap.
 IF h.reset_seq=h.seq THEN RETURN; END IF;
 IF EXISTS(SELECT 1 FROM ${CHANGES} c WHERE c.store_id=p_store AND c.seq=h.seq
  AND c.identity_digest=p_digest AND c.audience=p_audience AND c.patient_id IS NOT NULL
  AND p_patient IS NOT NULL AND c.patient_id<>p_patient) THEN
  DELETE FROM ${CHANGES} WHERE store_id=p_store;
  UPDATE ${HEAD} SET floor_seq=seq,reset_seq=seq,change_count=0 WHERE store_id=p_store;
  RETURN;
 END IF;
 INSERT INTO ${CHANGES}(store_id,seq,identity_digest,audience,patient_id,summary_changed,projection_changed)
 VALUES(p_store,h.seq,p_digest,p_audience,p_patient,p_summary,p_projection) ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS inserted=ROW_COUNT;
 UPDATE ${CHANGES} SET patient_id=COALESCE(patient_id,p_patient),
  summary_changed=summary_changed OR p_summary,projection_changed=projection_changed OR p_projection
 WHERE store_id=p_store AND seq=h.seq AND identity_digest=p_digest AND audience=p_audience;
 IF h.change_count+inserted>${MAX_CHANGES} THEN
  DELETE FROM ${CHANGES} WHERE store_id=p_store;
  UPDATE ${HEAD} SET floor_seq=seq,reset_seq=seq,change_count=0 WHERE store_id=p_store;
 ELSE
  UPDATE ${HEAD} SET change_count=change_count+inserted WHERE store_id=p_store;
 END IF;
END `;
const triggerBody196 = `
DECLARE events jsonb:='[]'::jsonb; e jsonb; r RECORD; k text; a text; d text;
BEGIN
 IF TG_OP='TRUNCATE' THEN
  FOR r IN SELECT store_id FROM ${HEAD} ORDER BY store_id COLLATE "C" LOOP
   PERFORM ${RECORD}(r.store_id,NULL,NULL,NULL,false,false,true);
  END LOOP;
  RETURN NULL;
 END IF;
 IF TG_TABLE_NAME='cabinet_summaries' THEN
  IF TG_OP<>'INSERT' THEN
   events:=events||jsonb_build_array(jsonb_build_object('store',OLD._store_id,'id',OLD.patient_id,'aud',OLD.audience));
  END IF;
  IF TG_OP<>'DELETE' THEN
   events:=events||jsonb_build_array(jsonb_build_object('store',NEW._store_id,'id',NEW.patient_id,'aud',NEW.audience));
  END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(events) ORDER BY value->>'store',value->>'id',value->>'aud' LOOP
   PERFORM ${RECORD}(e->>'store',encode(sha256(convert_to(e->>'id','UTF8')),'hex'),e->>'aud',e->>'id',true,false,false);
  END LOOP;
 ELSIF TG_TABLE_NAME='meta' THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('store',OLD._store_id,'key',OLD.key)); END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('store',NEW._store_id,'key',NEW.key)); END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(events) ORDER BY value->>'store',value->>'key' LOOP
   k:=e->>'key';
   IF k='directory164-ready' THEN
    PERFORM ${RECORD}(e->>'store',NULL,NULL,NULL,false,false,true);
   ELSIF left(k,13)='directory164:' THEN
    IF k~'^directory164:[a-f0-9]{64}:(\\*|[a-f0-9]{64})$' THEN
     d:=substring(k,14,64); a:=substring(k,79);
     PERFORM ${RECORD}(e->>'store',d,a,NULL,false,true,false);
    ELSE
     PERFORM ${RECORD}(e->>'store',NULL,NULL,NULL,false,false,true);
    END IF;
   END IF;
  END LOOP;
 ELSE RAISE EXCEPTION 'Invalid directory state source' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END `;
function triggerSQL196(remove = false) {
  return ['cabinet_summaries', 'meta']
    .map((table) => {
      const target = 'cartoteca_cabinet.' + identifier(table);
      if (remove)
        return `DROP TRIGGER ct_directory_state196 ON ${target}; DROP TRIGGER ct_directory_state_truncate196 ON ${target};`;
      return `CREATE TRIGGER ct_directory_state196 AFTER INSERT OR UPDATE OR DELETE ON ${target} FOR EACH ROW EXECUTE FUNCTION ${TRIGGER}();
CREATE TRIGGER ct_directory_state_truncate196 AFTER TRUNCATE ON ${target} FOR EACH STATEMENT EXECUTE FUNCTION ${TRIGGER}();`;
    })
    .join('\n');
}
function createDirectoryStateSQL196(role) {
  const app = identifier(role);
  return `CREATE TABLE ${META}(version bigint PRIMARY KEY CHECK(version=1),epoch uuid NOT NULL,
 signature jsonb NOT NULL,digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'));
CREATE TABLE ${HEAD}(store_id text COLLATE "C" PRIMARY KEY,kind text COLLATE "C" NOT NULL DEFAULT 'cabinet' CHECK(kind='cabinet'),
 epoch uuid NOT NULL DEFAULT gen_random_uuid(),seq bigint NOT NULL DEFAULT 1 CHECK(seq BETWEEN 1 AND ${MAX_SEQ}),
 floor_seq bigint NOT NULL DEFAULT 1 CHECK(floor_seq BETWEEN 1 AND seq),reset_seq bigint NOT NULL DEFAULT 1 CHECK(reset_seq BETWEEN 1 AND seq),
 last_xid xid8 NOT NULL,change_count bigint NOT NULL DEFAULT 0 CHECK(change_count BETWEEN 0 AND ${MAX_CHANGES}),
 FOREIGN KEY(kind,store_id) REFERENCES cartoteca_catalog.stores(kind,store_id) ON DELETE CASCADE);
CREATE TABLE ${CHANGES}(store_id text COLLATE "C" NOT NULL REFERENCES ${HEAD}(store_id) ON DELETE CASCADE,
 seq bigint NOT NULL CHECK(seq BETWEEN 1 AND ${MAX_SEQ}),identity_digest text COLLATE "C" NOT NULL CHECK(identity_digest~'^[a-f0-9]{64}$'),
 audience text COLLATE "C" NOT NULL CHECK(audience='*' OR audience~'^[a-f0-9]{64}$'),patient_id text COLLATE "C",
 summary_changed boolean NOT NULL,projection_changed boolean NOT NULL,
 CHECK(patient_id IS NULL OR length(patient_id) BETWEEN 1 AND 120),CHECK(summary_changed OR projection_changed),
 PRIMARY KEY(store_id,seq,identity_digest,audience));
ALTER TABLE ${META} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${META} FORCE ROW LEVEL SECURITY;
ALTER TABLE ${HEAD} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${HEAD} FORCE ROW LEVEL SECURITY;
ALTER TABLE ${CHANGES} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${CHANGES} FORCE ROW LEVEL SECURITY;
REVOKE ALL ON ${META},${HEAD},${CHANGES} FROM PUBLIC,${app}; GRANT SELECT ON ${META},${HEAD},${CHANGES} TO ${app};
CREATE POLICY read_component196 ON ${META} FOR SELECT TO ${app} USING(true);
CREATE POLICY owner_component196 ON ${META} FOR ALL TO CURRENT_USER USING(true) WITH CHECK(true);
CREATE POLICY read_head196 ON ${HEAD} FOR SELECT TO ${app} USING(current_setting('cartoteca.kind',true)='cabinet' AND store_id=current_setting('cartoteca.store_id',true));
CREATE POLICY owner_head196 ON ${HEAD} FOR ALL TO CURRENT_USER USING(true) WITH CHECK(true);
CREATE POLICY read_changes196 ON ${CHANGES} FOR SELECT TO ${app} USING(current_setting('cartoteca.kind',true)='cabinet' AND store_id=current_setting('cartoteca.store_id',true));
CREATE POLICY owner_changes196 ON ${CHANGES} FOR ALL TO CURRENT_USER USING(true) WITH CHECK(true);
CREATE FUNCTION ${RECORD}(p_store text,p_digest text,p_audience text,p_patient text,p_summary boolean,p_projection boolean,p_reset boolean)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$${recordBody196}$body$;
REVOKE ALL ON FUNCTION ${RECORD}(${RECORD_ARGS}) FROM PUBLIC,${app};
CREATE FUNCTION ${TRIGGER}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$${triggerBody196}$body$;
REVOKE ALL ON FUNCTION ${TRIGGER}() FROM PUBLIC,${app};
${triggerSQL196()}`;
}
module.exports = {
  META,
  HEAD,
  CHANGES,
  RECORD,
  TRIGGER,
  RECORD_ARGS,
  MAX_CHANGES,
  SEQ_WINDOW,
  MAX_SEQ,
  recordBody196,
  triggerBody196,
  triggerSQL196,
  createDirectoryStateSQL196,
};
