const { createHash } = require('node:crypto');
const { lockPlan } = require('./lock-intents.cjs');
const { sessionView } = require('../../modules/auth/session-view152.cjs');
function authorityQuery(platform, token) {
  const [lock] = lockPlan(platform, 'READONLY', false);
  return {
    text: `WITH auth_guard AS MATERIALIZED (SELECT pg_catalog.pg_try_advisory_xact_lock_shared($1::bigint) AS held)
SELECT g.held AS fence_locked,a.* FROM auth_guard g LEFT JOIN LATERAL (
SELECT s.id,s.account_id,s.organization_id,s.expires_at,a.value AS account_value,s.value AS session_value,a.global_admin,a.status AS account_status,
m.role AS membership_role,m.status AS membership_status,o.status AS organization_status
FROM cartoteca_platform.platform_sessions s JOIN cartoteca_platform.accounts a ON a._store_id=s._store_id AND a.id=s.account_id
LEFT JOIN cartoteca_platform.memberships m ON m._store_id=s._store_id AND m.organization_id=s.organization_id AND m.account_id=s.account_id
LEFT JOIN cartoteca_platform.organizations o ON o._store_id=s._store_id AND o.id=s.organization_id
WHERE g.held AND s._store_id=$2 AND s.token_hash=$3) a ON true`,
    values: [
      lock.key,
      platform.storeId,
      createHash('sha256')
        .update(String(token || ''))
        .digest('hex'),
    ],
  };
}
function authorityValue(rows, open) {
  if (rows.length !== 1 || rows[0].fence_locked !== true)
    throw Object.assign(Error('PostgreSQL authority guard unavailable'), {
      status: 503,
      code: 'POSTGRES_BUSY',
    });
  const row = rows[0];
  if (row.id == null) return { supported: true, current: null };
  // Organization selection and session repair keep their established owner.
  if (!row.organization_id) return { unsupported: 'session-selection' };
  row.expires_at = Number(row.expires_at);
  row.global_admin = Number(row.global_admin);
  if (!Number.isSafeInteger(row.expires_at) || ![0, 1].includes(row.global_admin))
    throw Object.assign(Error('Invalid PostgreSQL authority row'), {
      status: 503,
      code: 'POSTGRES_AUTHORITY_ROW',
    });
  return { supported: true, current: sessionView(row, open) };
}
module.exports = { authorityQuery, authorityValue };
