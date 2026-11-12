const { KEYS } = require('./lock-intents.cjs');
const denied = (code) => Object.assign(Error(code), { code, status: 503 });
const snapshot = (value) => typeof value === 'string' && value.length > 0 && value.length < 65536;

// Closed native RR guard, never a general SQL builder. All relations use one
// unchanged PLATFORM RLS scope. The session fence was acquired by run() before
// BEGIN; xact acquisition is consumed before the unconditional matching unlock.
function platformGuard167({ platform, locks, organizationId = null }) {
  if (
    platform?.kind !== 'platform' ||
    !/^[a-f0-9-]{36}$/i.test(platform.storeId || '') ||
    !Array.isArray(locks) ||
    locks.length !== 1 ||
    !locks[0] ||
    locks[0].key !== KEYS.maintenance ||
    locks[0].shared !== true ||
    (organizationId !== null &&
      (typeof organizationId !== 'string' || !organizationId || organizationId.length > 120))
  )
    throw denied('POSTGRES_READ_GUARD_CONTEXT167');
  const values = [locks[0].key, platform.storeId];
  let clocks = '';
  if (organizationId !== null) {
    values.push(['*', organizationId]);
    clocks = `,(SELECT m.epoch::text FROM cartoteca_catalog.read_scope_component163 m WHERE m.version=1) AS read_scope_epoch165,
      (SELECT COALESCE(jsonb_agg(jsonb_build_array(v.scope_id,v.epoch::text,v.revision::text) ORDER BY v.scope_id COLLATE "C"),'[]'::jsonb)
       FROM cartoteca_catalog.read_scope_versions163 v WHERE v.kind='platform' AND v.store_id=$2 AND v.scope_id=ANY($3::text[])) AS read_scope_rows165`;
  }
  return {
    text: `WITH ct_xact167 AS MATERIALIZED (
    SELECT pg_catalog.pg_try_advisory_xact_lock_shared($1::bigint) AS locked
  ),ct_release167 AS MATERIALIZED (
    SELECT locked,pg_catalog.pg_advisory_unlock_shared($1::bigint) AS released FROM ct_xact167
  ),ct_catalog167 AS MATERIALIZED (
    SELECT s.version,s.catalog_hash,s.metadata=t.metadata AS catalog_matches
    FROM cartoteca_catalog.stores s JOIN cartoteca_catalog.templates t ON t.kind=s.kind AND t.version=s.version AND t.catalog_hash=s.catalog_hash
    CROSS JOIN ct_release167 h WHERE h.locked AND h.released AND s.kind='platform' AND s.store_id=$2
  ) SELECT ARRAY[h.locked] AS locked,ARRAY[h.released] AS released,pg_current_snapshot()::text AS snapshot,
      c.version,c.catalog_hash,c.catalog_matches${clocks}
    FROM ct_release167 h LEFT JOIN ct_catalog167 c ON true`,
    values,
  };
}
function fenceRow167(result) {
  const row = result?.rows?.[0];
  if (
    !Array.isArray(result?.rows) ||
    result.rows.length !== 1 ||
    !Array.isArray(row?.locked) ||
    row.locked.length !== 1 ||
    typeof row.locked[0] !== 'boolean' ||
    !Array.isArray(row.released) ||
    row.released.length !== 1 ||
    typeof row.released[0] !== 'boolean' ||
    !snapshot(row.snapshot)
  )
    throw denied('POSTGRES_READ_GUARD_FENCE167');
  return row;
}
function catalogRow167(row, expected) {
  if (row.version == null && row.catalog_hash == null && row.catalog_matches == null) return false;
  if (
    Number(row.version) !== expected?.metadata?.version ||
    row.catalog_hash !== expected?.hash ||
    row.catalog_matches !== true
  )
    throw denied('POSTGRES_CATALOG_INVALID');
  return true;
}
function scopeRows167(rows, wanted, epoch, expectedEpoch) {
  if (epoch !== expectedEpoch) throw denied('POSTGRES_READ_SCOPE_COMPONENT_CHANGED');
  if (!Array.isArray(rows)) throw denied('POSTGRES_READ_SCOPE_VERSION');
  if (
    rows.length !== wanted.length ||
    wanted.some((id) => !rows.some((row) => Array.isArray(row) && row[0] === id))
  )
    return null;
  if (
    rows.some(
      (row) =>
        row.length !== 3 ||
        !/^[a-f0-9-]{36}$/.test(row[1]) ||
        typeof row[2] !== 'string' ||
        !/^[1-9][0-9]{0,18}$/.test(row[2]),
    )
  )
    throw denied('POSTGRES_READ_SCOPE_VERSION');
  return rows;
}
module.exports = { platformGuard167, fenceRow167, catalogRow167, scopeRows167 };
