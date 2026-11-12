// Call from the same synchronous transaction that authorizes the revocation.
// The parent capability owns the mail row through ON DELETE CASCADE.
function deleteUnacceptedInvitation(db, row) {
  const deleted = db
    .prepare(
      `DELETE FROM invitations WHERE token_hash=? AND organization_id=? AND used_at IS NULL
      AND EXISTS (SELECT 1 FROM email_invitations e WHERE e.id=?
        AND e.organization_id=invitations.organization_id AND e.token_hash=invitations.token_hash)`,
    )
    .run(row.token_hash, row.organization_id, row.id);
  if (deleted.changes !== 1) throw Error('Invitation changed before removal.');
}

// Explicit maintenance only: never registered as a startup hook, timer or HTTP route.
function pruneRevokedInvitations({ db, transaction, audit }, { organizationId = null } = {}) {
  if (organizationId !== null && (typeof organizationId !== 'string' || !organizationId.trim()))
    throw Error('Specify an organization or an explicit all-organizations cleanup.');
  return transaction(() => {
    const scope = organizationId === null ? '' : ' AND organization_id=?';
    const statement = db.prepare(
      `DELETE FROM invitations WHERE used_at IS NULL${scope}
      AND EXISTS (SELECT 1 FROM email_invitations e WHERE e.status='revoked'
        AND e.organization_id=invitations.organization_id AND e.token_hash=invitations.token_hash)`,
    );
    const deleted = Number(
      (organizationId === null ? statement.run() : statement.run(organizationId)).changes,
    );
    if (deleted) audit('invitation_revoked_cleanup', null, organizationId, { deleted });
    return { deleted };
  });
}

module.exports = { deleteUnacceptedInvitation, pruneRevokedInvitations };
