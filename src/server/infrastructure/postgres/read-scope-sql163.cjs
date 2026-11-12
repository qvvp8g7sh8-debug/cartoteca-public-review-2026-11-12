const { identifier, namespace } = require('./catalog-sqlite.cjs');
const TABLE = 'cartoteca_catalog.read_scope_versions163';
const META = 'cartoteca_catalog.read_scope_component163';
// The closed dependency set covers the calendar DTO and its display policy.
// Other queues, sessions, usage and unrelated organizations do not share a clock.
const platformTables = Object.freeze({
  organizations: 'organization',
  subscriptions: 'organization_id',
  memberships: 'organization_id',
  accounts: 'account',
  telegram_runtime: 'runtime',
  telegram_settings: 'organization_id',
  telegram_links: 'organization_id',
  telegram_confirmations: 'organization_id',
  telegram_jobs: 'organization_id',
  appointment_manual_confirmations: 'organization_id',
  notification_confirmations: 'organization_id',
  notification_channel_jobs: 'organization_id',
  max_client_links: 'organization_id',
  booking_requests: 'organization_id',
  work_schedule_profiles: 'organization_id',
  work_schedule_days: 'organization_id',
});
const body = `
DECLARE store TEXT; scopes TEXT[]; selected TEXT; tx xid8; old_id TEXT; new_id TEXT;
BEGIN
 tx := pg_current_xact_id();
 IF TG_OP='TRUNCATE' THEN
  UPDATE ${TABLE} SET revision=revision+1,last_xid=tx
   WHERE kind=TG_ARGV[0] AND last_xid IS DISTINCT FROM tx;
  RETURN NULL;
 END IF;
 store := CASE WHEN TG_OP='DELETE' THEN OLD._store_id ELSE NEW._store_id END;
 IF TG_ARGV[0]='cabinet' THEN scopes:=ARRAY['*'];
 ELSIF TG_ARGV[1]='runtime' THEN
  IF (TG_OP<>'INSERT' AND OLD.key='notification-channel-state-v1') OR
     (TG_OP<>'DELETE' AND NEW.key='notification-channel-state-v1') THEN scopes:=ARRAY['*'];
  ELSE RETURN NULL; END IF;
 ELSIF TG_ARGV[1]='account' THEN
  IF TG_OP<>'INSERT' THEN old_id:=OLD.id; END IF;
  IF TG_OP<>'DELETE' THEN new_id:=NEW.id; END IF;
  SELECT array_agg(DISTINCT organization_id ORDER BY organization_id) INTO scopes
   FROM cartoteca_platform.memberships WHERE _store_id=store AND account_id IN(old_id,new_id);
 ELSIF TG_ARGV[1]='organization' THEN
  IF TG_OP<>'INSERT' THEN old_id:=OLD.id; END IF;
  IF TG_OP<>'DELETE' THEN new_id:=NEW.id; END IF;
  scopes:=ARRAY[old_id,new_id];
 ELSIF TG_ARGV[1]='organization_id' THEN
  IF TG_OP<>'INSERT' THEN old_id:=OLD.organization_id; END IF;
  IF TG_OP<>'DELETE' THEN new_id:=NEW.organization_id; END IF;
  scopes:=ARRAY[old_id,new_id];
 ELSE RAISE EXCEPTION 'Invalid read scope dependency' USING ERRCODE='23514'; END IF;
 FOR selected IN SELECT DISTINCT s COLLATE "C" FROM unnest(scopes) AS u(s) WHERE s IS NOT NULL ORDER BY 1 LOOP
  INSERT INTO ${TABLE} AS v(kind,store_id,scope_id,revision,last_xid)
   VALUES(TG_ARGV[0],store,selected,1,tx)
   ON CONFLICT(kind,store_id,scope_id) DO UPDATE SET revision=v.revision+1,last_xid=excluded.last_xid
   WHERE v.last_xid IS DISTINCT FROM excluded.last_xid;
 END LOOP;
 RETURN NULL;
END `;
function trackedTables(catalogs) {
  const result = [];
  for (const [kind, catalog] of Object.entries(catalogs)) {
    if (!['platform', 'cabinet'].includes(kind)) continue;
    for (const table of Object.keys(catalog.tables).sort()) {
      const scope = kind === 'cabinet' ? 'cabinet' : platformTables[table];
      if (scope) result.push({ kind, table, scope });
    }
  }
  return result;
}
function createSQL(role) {
  const app = identifier(role);
  return `CREATE TABLE ${TABLE}(
 kind TEXT COLLATE "C" NOT NULL,store_id TEXT COLLATE "C" NOT NULL,scope_id TEXT COLLATE "C" NOT NULL,
 epoch UUID NOT NULL DEFAULT gen_random_uuid(),revision BIGINT NOT NULL CHECK(revision>0),last_xid xid8 NOT NULL,
 PRIMARY KEY(kind,store_id,scope_id),
 FOREIGN KEY(kind,store_id) REFERENCES cartoteca_catalog.stores(kind,store_id) ON DELETE CASCADE,
 CHECK(kind IN('platform','cabinet')));
 ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY;
 REVOKE ALL ON ${TABLE} FROM PUBLIC; GRANT SELECT ON ${TABLE} TO ${app};
 CREATE POLICY read_scope163 ON ${TABLE} FOR SELECT TO ${app}
 USING(kind=current_setting('cartoteca.kind',true) AND store_id=current_setting('cartoteca.store_id',true));
 CREATE POLICY owner_scope163 ON ${TABLE} FOR ALL TO CURRENT_USER USING(true) WITH CHECK(true);
 CREATE TABLE ${META}(version BIGINT PRIMARY KEY CHECK(version=1),epoch UUID NOT NULL,signature JSONB NOT NULL,digest TEXT NOT NULL);
 ALTER TABLE ${META} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${META} FORCE ROW LEVEL SECURITY;
 REVOKE ALL ON ${META} FROM PUBLIC; GRANT SELECT ON ${META} TO ${app};
 CREATE POLICY read_component163 ON ${META} FOR SELECT TO ${app} USING(true);
 CREATE POLICY owner_component163 ON ${META} FOR ALL TO CURRENT_USER USING(true) WITH CHECK(true);
 CREATE FUNCTION cartoteca_catalog.bump_read_scope163() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$${body}$body$;
 REVOKE ALL ON FUNCTION cartoteca_catalog.bump_read_scope163() FROM PUBLIC;`;
}
function triggerSQL({ kind, table, scope }, remove = false) {
  const target = identifier(namespace(kind)) + '.' + identifier(table);
  const drop = `DROP TRIGGER ct_read_scope163 ON ${target}; DROP TRIGGER ct_read_truncate163 ON ${target};`;
  return remove
    ? drop
    : `CREATE TRIGGER ct_read_scope163 AFTER INSERT OR UPDATE OR DELETE ON ${target} FOR EACH ROW EXECUTE FUNCTION cartoteca_catalog.bump_read_scope163('${kind}','${scope}');
CREATE TRIGGER ct_read_truncate163 AFTER TRUNCATE ON ${target} FOR EACH STATEMENT EXECUTE FUNCTION cartoteca_catalog.bump_read_scope163('${kind}','${scope}');`;
}
module.exports = { TABLE, META, body, platformTables, trackedTables, createSQL, triggerSQL };
