// Shared projection for ordinary and native reads. It neither repairs sessions
// nor caches authority; the caller supplies a freshly joined database row.
function sessionView(row, open, organizationAccess) {
  if (!row || row.expires_at <= Date.now() || row.account_status !== 'active') return null;
  if (
    row.organization_id &&
    (row.membership_status !== 'active' || row.organization_status !== 'active')
  )
    return null;
  const value = open(row.account_value);
  if (
    row.global_admin &&
    value.adminMfa?.enabled &&
    open(row.session_value).adminMfaRevision !== value.adminMfa.revision
  )
    return null;
  return {
    sessionId: row.id,
    accountId: row.account_id,
    organizationId: row.organization_id,
    role: row.membership_role || null,
    globalAdmin: Boolean(row.global_admin),
    email: value.email,
    displayName: value.displayName,
    expiresAt: row.expires_at,
    ...(organizationAccess ? { organizationAccess } : {}),
  };
}
module.exports = { sessionView };
