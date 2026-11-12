'use strict';
// Profile 3 uses native MVCC snapshots for cache invalidation. A trigger still
// guards immutable store identity and catalog membership; it writes no shared
// revision row. Profile 2 SQL and state remain intact for an explicit inverse.
const revisionBody = `
DECLARE scope TEXT;
BEGIN
 scope := CASE WHEN TG_OP='DELETE' THEN OLD._store_id ELSE NEW._store_id END;
 IF TG_OP='UPDATE' AND OLD._store_id IS DISTINCT FROM NEW._store_id THEN RAISE EXCEPTION 'Store identity cannot change' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM cartoteca_catalog.stores WHERE kind=TG_ARGV[0] AND store_id=scope) THEN
  RAISE EXCEPTION 'Store catalog missing' USING ERRCODE='23514';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END `;
function functionSQL() {
  return `CREATE OR REPLACE FUNCTION cartoteca_catalog.bump_store_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$${revisionBody}$body$;
REVOKE ALL ON FUNCTION cartoteca_catalog.bump_store_revision() FROM PUBLIC;`;
}
module.exports = { revisionBody, functionSQL };
