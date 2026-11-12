function createInvitationPassword(context) {
  const { audit, db, emailHash, fail, normalizeEmail, open, seal } = context;
  function setupRequired(account, email) {
    return !account || Boolean(unfinishedOrganization(account, email));
  }
  function unfinishedOrganization(account, email) {
    if (!account) return null;
    const { row, value } = account;
    if (
      row.status !== 'active' ||
      row.global_admin !== 0 ||
      value.emailVerified !== false ||
      normalizeEmail(value.email) !== normalizeEmail(email)
    )
      return null;
    const memberships = db
      .prepare(
        `SELECT m.organization_id,m.role,m.status,m.created_at,
          o.status organization_status,o.created_at organization_created_at
        FROM memberships m JOIN organizations o ON o.id=m.organization_id
        WHERE m.account_id=?`,
      )
      .all(row.id);
    const member = memberships[0];
    if (
      memberships.length !== 1 ||
      member.role !== 'owner' ||
      member.status !== 'active' ||
      member.organization_status !== 'active' ||
      member.created_at !== row.created_at ||
      member.organization_created_at !== row.created_at
    )
      return null;
    const origins = db
      .prepare(
        "SELECT organization_id FROM platform_audit WHERE actor_id=? AND event='owner_registered'",
      )
      .all(row.id);
    if (origins.length !== 1 || origins[0].organization_id !== member.organization_id) return null;
    if (
      db
        .prepare(
          `SELECT 1 FROM platform_audit WHERE actor_id=?
          AND event IN ('login_succeeded','invitation_accepted','email_verified') LIMIT 1`,
        )
        .get(row.id) ||
      db.prepare('SELECT 1 FROM platform_sessions WHERE account_id=? LIMIT 1').get(row.id)
    )
      return null;
    if (
      db
        .prepare('SELECT 1 FROM memberships WHERE organization_id=? AND account_id<>? LIMIT 1')
        .get(member.organization_id, row.id) ||
      db
        .prepare(
          `SELECT 1 FROM platform_audit WHERE organization_id=?
          AND event NOT IN ('owner_registered','registration_verification_retried',
            'subscription_terms_admin_updated') LIMIT 1`,
        )
        .get(member.organization_id)
    )
      return null;
    return member.organization_id;
  }
  function assertOrganization(account, email, organizationId, allowUnfinished = false) {
    if (!account) return null;
    const other = context
      .availableMemberships(account.row.id)
      .filter((member) => member.organizationId !== organizationId);
    if (!other.length) return null;
    const unfinished = allowUnfinished ? unfinishedOrganization(account, email) : null;
    if (other.length === 1 && other[0].organizationId === unfinished) return unfinished;
    throw fail(409, 'Для другой организации используйте отдельную учётную запись с другой почтой.');
  }
  function assertEmail(invitation, email, delivery) {
    const hash = emailHash(email);
    if (
      (invitation.email_hash && invitation.email_hash !== hash) ||
      (delivery &&
        (invitation.email_hash !== hash ||
          normalizeEmail(open(delivery.value).email) !== email ||
          delivery.organization_id !== invitation.organization_id ||
          delivery.token_hash !== invitation.token_hash))
    )
      throw fail(403, 'Приглашение предназначено для другой почты.');
  }
  function assertConfirmation(password, passwordConfirmation) {
    if (typeof passwordConfirmation !== 'string')
      throw fail(400, 'Откройте приглашение из письма повторно и подтвердите новый пароль.');
    if (password !== passwordConfirmation) throw fail(400, 'Пароли не совпадают.');
  }
  function assertCurrent(previous, current, email, required, delivered) {
    const changed = previous
      ? !current ||
        current.row.id !== previous.row.id ||
        current.row.status !== 'active' ||
        current.row.global_admin !== previous.row.global_admin ||
        current.row.email_hash !== previous.row.email_hash ||
        !Buffer.from(current.row.value).equals(Buffer.from(previous.row.value))
      : Boolean(current);
    if (changed || (!current || (delivered && setupRequired(current, email))) !== required)
      throw fail(409, 'Учётная запись изменилась. Откройте приглашение из письма повторно.');
  }
  // Called only inside the invitation acceptance transaction.
  function complete(
    account,
    { passwordData, displayName, privacyConsent, organizationId, retiredOrganizationId },
  ) {
    if (!db.isTransaction) throw Error('Invitation completion requires the platform transaction.');
    if (retiredOrganizationId) {
      db.prepare(
        "UPDATE memberships SET status='suspended' WHERE organization_id=? AND account_id=?",
      ).run(retiredOrganizationId, account.row.id);
      db.prepare("UPDATE organizations SET status='suspended' WHERE id=?").run(
        retiredOrganizationId,
      );
      require('../notifications/pause-pending.cjs').pausePendingNotifications(
        context,
        retiredOrganizationId,
      );
      audit('invitation_unfinished_organization_retired', account.row.id, retiredOrganizationId, {
        invitedOrganizationId: organizationId,
      });
    }
    db.prepare('UPDATE accounts SET value=? WHERE id=?').run(
      seal({
        ...account.value,
        ...passwordData,
        displayName,
        emailVerified: true,
        ...(privacyConsent ? { privacyConsent } : {}),
      }),
      account.row.id,
    );
    for (const table of ['platform_sessions', 'password_resets', 'email_verifications'])
      db.prepare('DELETE FROM ' + table + ' WHERE account_id=?').run(account.row.id);
    audit('invitation_password_created', account.row.id, organizationId, {
      registrationCompleted: true,
    });
  }
  return {
    setupRequired,
    assertOrganization,
    assertEmail,
    assertConfirmation,
    assertCurrent,
    complete,
  };
}
module.exports = { createInvitationPassword };
