// Only the mail-backed wrapper is exposed by HTTP. Low-level invitations remain
// available for trusted internal provisioning and synthetic fixtures, not public acceptance.
const { createInvitationPassword } = require('./invitation-password.cjs');
const { deleteUnacceptedInvitation } = require('./invitation-revocation.cjs');
function createEmailInvitations(context) {
  const invitationPassword = createInvitationPassword(context);
  const {
    db,
    fail,
    transaction,
    seal,
    open,
    normalizeEmail,
    emailRule,
    emailHash,
    tokenHash,
    id,
    audit,
    consumePublicAuthRequest,
  } = context;
  const rowsSql = `SELECT e.*,i.role,i.expires_at,i.used_at,i.invited_by,i.email_hash
    FROM email_invitations e JOIN invitations i ON i.token_hash=e.token_hash`;
  function actor(organizationId, accountId, role) {
    const member = db
      .prepare(
        `SELECT m.role,m.status,o.status organization_status,a.status account_status
      FROM memberships m JOIN organizations o ON o.id=m.organization_id
      JOIN accounts a ON a.id=m.account_id WHERE m.organization_id=? AND m.account_id=?`,
      )
      .get(organizationId, accountId);
    if (
      !member ||
      member.status !== 'active' ||
      member.account_status !== 'active' ||
      member.organization_status !== 'active' ||
      !['owner', 'salon_admin'].includes(member.role) ||
      (member.role === 'salon_admin' && role && role !== 'cosmetologist')
    )
      throw fail(403, 'Недостаточно прав для управления приглашением.');
    return member;
  }
  function record(organizationId, invitationId, accountId) {
    const row = db
      .prepare(rowsSql + ' WHERE e.id=? AND e.organization_id=?')
      .get(invitationId, organizationId);
    if (!row) throw fail(404, 'Приглашение не найдено.');
    actor(organizationId, accountId, row.role);
    return row;
  }
  function state(row) {
    if (row.used_at) return 'accepted';
    if (row.status === 'revoked') return 'revoked';
    if (row.expires_at <= Date.now()) return 'expired';
    return row.status;
  }
  function summary(row, actorRole) {
    const status = state(row);
    return {
      id: row.id,
      email: open(row.value).email,
      role: row.role,
      status,
      createdAt: row.created_at,
      sentAt: row.sent_at,
      expiresAt: row.expires_at,
      canManage: actorRole === 'owner' || row.role === 'cosmetologist',
      canResend:
        !['accepted', 'revoked'].includes(status) && Date.now() - row.attempted_at >= 60000,
    };
  }
  function emailInvitations(organizationId, accountId) {
    const member = actor(organizationId, accountId);
    return db
      .prepare(
        rowsSql +
          ` WHERE e.organization_id=? AND (e.status<>'revoked' OR i.used_at IS NOT NULL)
          ORDER BY e.created_at DESC,e.id LIMIT 100`,
      )
      .all(organizationId)
      .map((row) => summary(row, member.role));
  }
  function assertNotMember(organizationId, email) {
    const account = context.accountByEmail(email);
    if (
      account &&
      db
        .prepare('SELECT 1 FROM memberships WHERE organization_id=? AND account_id=?')
        .get(organizationId, account.row.id)
    )
      throw fail(409, 'Эта почта уже принадлежит сотруднику организации.');
    if (account && account.row.status !== 'active')
      throw fail(409, 'Учётная запись получателя недоступна.');
    invitationPassword.assertOrganization(account, email, organizationId, true);
  }
  function prepareEmailInvitation({ organizationId, actorId, email, role, invitationId }) {
    const previous = invitationId ? record(organizationId, invitationId, actorId) : null;
    email = previous ? open(previous.value).email : normalizeEmail(email);
    role = previous ? previous.role : role;
    emailRule(email);
    // The recipient must be one bare mailbox, not a mail-client address list.
    if (/[<>,;:"()[\]\\\x00-\x1f\x7f]/.test(email))
      throw fail(
        400,
        'Укажите один адрес электронной почты без имени и дополнительных получателей.',
      );
    actor(organizationId, actorId, role);
    if (!context.staffRoles.has(role)) throw fail(400, 'Недопустимая роль сотрудника.');
    assertNotMember(organizationId, email);
    if (previous && ['accepted', 'revoked'].includes(state(previous)))
      throw fail(409, 'Это приглашение больше нельзя отправить.');
    consumePublicAuthRequest('invitation', email, organizationId);
    return transaction(() => {
      actor(organizationId, actorId, role);
      assertNotMember(organizationId, email);
      const fresh = previous ? record(organizationId, invitationId, actorId) : null;
      if (fresh && ['accepted', 'revoked'].includes(state(fresh)))
        throw fail(409, 'Это приглашение больше нельзя отправить.');
      // One active invitation per organization/email; a repeat uses its visible row.
      if (
        !fresh &&
        db
          .prepare(
            rowsSql +
              ` WHERE e.organization_id=? AND i.email_hash=?
        AND i.used_at IS NULL AND i.expires_at>? AND e.status IN ('pending','sent','failed')`,
          )
          .get(organizationId, emailHash(email), Date.now())
      )
        throw fail(409, 'Приглашение уже есть в списке. Используйте «Отправить повторно».');
      if (fresh && Date.now() - fresh.attempted_at < 60000)
        throw fail(429, 'Повторить отправку можно через минуту.');
      const invitation = context.createInvitation({
        organizationId,
        invitedBy: actorId,
        email,
        role,
      });
      const hash = tokenHash(invitation.token),
        recordId = fresh?.id || id(),
        now = Date.now();
      if (fresh) {
        db.prepare('UPDATE invitations SET used_at=? WHERE token_hash=? AND used_at IS NULL').run(
          now,
          fresh.token_hash,
        );
        db.prepare(
          "UPDATE email_invitations SET token_hash=?,status='pending',attempted_at=?,sent_at=NULL WHERE id=?",
        ).run(hash, now, recordId);
      } else {
        db.prepare(
          `INSERT INTO email_invitations(id,token_hash,organization_id,value,status,created_at,attempted_at)
          VALUES(?,?,?,?,'pending',?,?)`,
        ).run(recordId, hash, organizationId, seal({ email }), now, now);
      }
      return {
        id: recordId,
        token: invitation.token,
        email,
        expiresAt: invitation.expiresAt,
        organizationName: context.organization(organizationId).name,
        roleName: role === 'salon_admin' ? 'Администратор' : 'Сотрудник',
      };
    });
  }
  function finishEmailInvitation({ organizationId, actorId, invitationId, token }, delivered) {
    return transaction(() => {
      const row = db
        .prepare(rowsSql + ' WHERE e.id=? AND e.organization_id=?')
        .get(invitationId, organizationId);
      if (!row || row.token_hash !== tokenHash(token) || row.status !== 'pending')
        throw fail(409, 'Приглашение изменилось. Обновите список.');
      if (delivered) {
        try {
          actor(organizationId, actorId, row.role);
          assertNotMember(organizationId, open(row.value).email);
        } catch (error) {
          deleteUnacceptedInvitation(db, row);
          audit('invitation_revoked', actorId, organizationId, { invitationId: row.id });
          // Return the error after COMMIT so the invalidation is not rolled back.
          return { error };
        }
      }
      db.prepare('UPDATE email_invitations SET status=?,sent_at=? WHERE id=?').run(
        delivered ? 'sent' : 'failed',
        delivered ? Date.now() : null,
        row.id,
      );
      audit(
        delivered ? 'invitation_emailed' : 'invitation_delivery_failed',
        actorId,
        organizationId,
        { invitationId: row.id },
      );
      return {};
    });
  }
  function revokeEmailInvitation({ organizationId, actorId, invitationId }) {
    return transaction(() => {
      const row = record(organizationId, invitationId, actorId);
      if (row.used_at) throw fail(409, 'Приглашение уже принято. Управляйте доступом сотрудника.');
      deleteUnacceptedInvitation(db, row);
      audit('invitation_revoked', actorId, organizationId, { invitationId: row.id });
      return {};
    });
  }
  function assertEmailInvitation(token) {
    const row = db.prepare(rowsSql + ' WHERE e.token_hash=?').get(tokenHash(String(token || '')));
    if (!row || state(row) !== 'sent')
      throw fail(400, 'Приглашение недействительно, отозвано или истекло. Попросите новое письмо.');
    actor(row.organization_id, row.invited_by, row.role);
    return row;
  }
  function emailInvitationInfo(token) {
    const row = assertEmailInvitation(token),
      email = open(row.value).email;
    const account = context.accountByEmail(email);
    invitationPassword.assertEmail(row, normalizeEmail(email), row);
    invitationPassword.assertOrganization(account, email, row.organization_id, true);
    const passwordSetupRequired = invitationPassword.setupRequired(account, email);
    return {
      email,
      organizationName: context.organization(row.organization_id).name,
      roleName: row.role === 'salon_admin' ? 'Администратор' : 'Сотрудник',
      existingAccount: Boolean(account),
      passwordSetupRequired,
      displayName: passwordSetupRequired ? '' : account?.value.displayName || '',
      expiresAt: row.expires_at,
    };
  }
  function acceptEmailInvitation(values, clientAddress) {
    return context.acceptInvitation(values, clientAddress, { requireEmailDelivery: true });
  }
  return {
    emailInvitations,
    prepareEmailInvitation,
    finishEmailInvitation,
    revokeEmailInvitation,
    assertEmailInvitation,
    emailInvitationInfo,
    acceptEmailInvitation,
  };
}
module.exports = { createEmailInvitations };
