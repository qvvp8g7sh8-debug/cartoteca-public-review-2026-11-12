'use strict';
const { queueDomainNames, queueDomainTables } = require('./queue-domains.cjs');
const domains = Object.freeze(['business', ...queueDomainNames]);
const TABLE = 'cartoteca_catalog.revision_state';
const legacyBody = `
DECLARE scope TEXT;
BEGIN
 scope := CASE WHEN TG_OP='DELETE' THEN OLD._store_id ELSE NEW._store_id END;
 IF TG_OP='UPDATE' AND OLD._store_id IS DISTINCT FROM NEW._store_id THEN RAISE EXCEPTION 'Store identity cannot change' USING ERRCODE='23514'; END IF;
 UPDATE cartoteca_catalog.stores SET revision=revision+1 WHERE kind=TG_ARGV[0] AND store_id=scope;
 IF NOT FOUND THEN RAISE EXCEPTION 'Store catalog missing' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END `;
function domainExpression(key) {
  const cases = Object.entries(queueDomainTables)
    .flatMap(([domain, tables]) => tables.map((table) => `WHEN '${table}' THEN '${domain}'`))
    .join('\n   ');
  return `CASE TG_TABLE_NAME ${cases}
   WHEN 'telegram_runtime' THEN CASE
    WHEN ${key} ~ '^staff-selftest-v1:telegram:[A-Za-z0-9_-]{1,128}$' THEN 'staff-telegram'
    WHEN ${key} ~ '^staff-selftest-v1:max:[A-Za-z0-9_-]{1,128}$' THEN 'staff-max'
    ELSE 'business' END
   ELSE 'business' END`;
}
// TG_TABLE_NAME and the closed table/key catalog determine the revision lane.
// No caller-supplied setting can suppress or reroute an invalidation.
const revisionBody = `
DECLARE scope TEXT; lane TEXT; row_key TEXT; old_key TEXT; lanes TEXT[]; tx xid8;
BEGIN
 scope := CASE WHEN TG_OP='DELETE' THEN OLD._store_id ELSE NEW._store_id END;
 IF TG_OP='UPDATE' AND OLD._store_id IS DISTINCT FROM NEW._store_id THEN RAISE EXCEPTION 'Store identity cannot change' USING ERRCODE='23514'; END IF;
 tx := pg_current_xact_id();
 IF TG_ARGV[0]='platform' THEN
  IF TG_TABLE_NAME='telegram_runtime' THEN
   row_key := CASE WHEN TG_OP='DELETE' THEN OLD.key ELSE NEW.key END;
  END IF;
  lanes := ARRAY[${domainExpression('row_key')}];
  IF TG_TABLE_NAME='telegram_runtime' AND TG_OP='UPDATE' THEN
   old_key := OLD.key;
   IF old_key IS DISTINCT FROM row_key THEN lanes := array_append(lanes,${domainExpression('old_key')}); END IF;
  END IF;
 ELSE lanes := ARRAY['business']; END IF;
 FOREACH lane IN ARRAY lanes LOOP
  INSERT INTO cartoteca_catalog.revision_state AS state(kind,store_id,domain,revision,last_xid)
   SELECT TG_ARGV[0],scope,lane,1,tx FROM cartoteca_catalog.stores WHERE kind=TG_ARGV[0] AND store_id=scope
   ON CONFLICT(kind,store_id,domain) DO UPDATE SET revision=state.revision+1,last_xid=excluded.last_xid
   WHERE state.last_xid IS DISTINCT FROM excluded.last_xid;
  IF NOT FOUND AND NOT EXISTS(SELECT 1 FROM cartoteca_catalog.revision_state WHERE kind=TG_ARGV[0] AND store_id=scope AND domain=lane) THEN
   RAISE EXCEPTION 'Store catalog missing' USING ERRCODE='23514';
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END `;
function functionSQL(version, replace = true) {
  if (![1, 2].includes(version)) throw Error('Unsupported revision profile.');
  return `CREATE ${replace ? 'OR REPLACE ' : ''}FUNCTION cartoteca_catalog.bump_store_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$${version === 2 ? revisionBody : legacyBody}$body$;
REVOKE ALL ON FUNCTION cartoteca_catalog.bump_store_revision() FROM PUBLIC;`;
}
const filter =
  "kind=current_setting('cartoteca.kind',true) AND store_id=current_setting('cartoteca.store_id',true)";
function tableSQL(role) {
  if (typeof role !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(role))
    throw Error('Invalid revision role.');
  return `CREATE TABLE ${TABLE}(
 kind TEXT COLLATE "C" NOT NULL,store_id TEXT COLLATE "C" NOT NULL,domain TEXT COLLATE "C" NOT NULL,
 revision BIGINT NOT NULL,last_xid xid8 NOT NULL,
 CONSTRAINT revision_state_pkey PRIMARY KEY(kind,store_id,domain),
 CONSTRAINT revision_state_store_fkey FOREIGN KEY(kind,store_id) REFERENCES cartoteca_catalog.stores(kind,store_id) ON UPDATE RESTRICT ON DELETE CASCADE,
 CONSTRAINT revision_state_kind CHECK(kind='platform' OR kind='cabinet' OR kind='budget'),
 CONSTRAINT revision_state_domain CHECK(${domains.map((v) => "domain='" + v + "'").join(' OR ')}),
 CONSTRAINT revision_state_nonnegative CHECK(revision>=0));
 ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY;
 ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY;
 REVOKE ALL ON TABLE ${TABLE} FROM PUBLIC;
 GRANT SELECT ON TABLE ${TABLE} TO "${role}";
 CREATE POLICY revision_scope ON ${TABLE} FOR SELECT TO "${role}" USING(${filter});
 CREATE POLICY revision_owner ON ${TABLE} FOR ALL TO CURRENT_USER USING(true) WITH CHECK(true);`;
}
function revisionSelect(alias, scope) {
  if (scope.revisionProfile === 3)
    throw Object.assign(Error('Use the opaque PostgreSQL MVCC read version capability.'), {
      code: 'POSTGRES_OPAQUE_READ_VERSION_REQUIRED',
    });
  const legacy = `SELECT revision AS ${alias} FROM cartoteca_catalog.stores WHERE kind=$1 AND store_id=$2`;
  if (scope.revisionProfile !== 2) return legacy;
  return `SELECT (s.revision+COALESCE((SELECT SUM(r.revision) FROM cartoteca_catalog.revision_state r WHERE r.kind=s.kind AND r.store_id=s.store_id),0))::bigint AS ${alias} FROM cartoteca_catalog.stores s WHERE s.kind=$1 AND s.store_id=$2`;
}
module.exports = {
  TABLE,
  domains,
  filter,
  legacyBody,
  revisionBody,
  functionSQL,
  tableSQL,
  revisionSelect,
};
