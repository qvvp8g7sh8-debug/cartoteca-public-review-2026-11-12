const { createInvitationPassword } = require('./invitation-password.cjs');
function createOrganizations(context) {
  const {
    accountByEmail,
    audit,
    crypto,
    db,
    emailHash,
    emailRule,
    fail,
    id,
    normalizeEmail,
    open,
    passwordFields,
    seal,
    staffRoles,
    textRule,
    tokenHash,
    transaction,
    verifyPassword,
    loginLimitKeys,
    assertLoginAllowed,
    recordLoginFailure,
    clearLoginFailures,
  } = context;
  const invitationPassword = createInvitationPassword(context);
  let organizationStatement, subscriptionStatement;
  function uniqueSlug(name) {
    const base =
      name
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9а-яё]+/giu, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48) || 'salon';
    let candidate = base,
      suffix = 1;
    while (db.prepare('SELECT 1 FROM organizations WHERE slug=?').get(candidate))
      candidate = `${base}-${++suffix}`;
    return candidate;
  }
  function memberships(accountId) {
    return readMemberships(accountId, false);
  }
  function availableMemberships(accountId) {
    return readMemberships(accountId, true);
  }
  function readMemberships(accountId, availableOnly) {
    return db
      .prepare(
        `SELECT m.organization_id,m.role,m.status,o.slug,o.value
      FROM memberships m JOIN organizations o ON o.id=m.organization_id
      WHERE m.account_id=?${availableOnly ? " AND m.status='active' AND o.status='active'" : ''}
      ORDER BY m.created_at`,
      )
      .all(accountId)
      .map((row) => ({
        organizationId: row.organization_id,
        role: row.role,
        status: row.status,
        slug: row.slug,
        organizationName: open(row.value).name,
      }));
  }
  function createInvitation({
    organizationId,
    invitedBy,
    role,
    email = '',
    expiresInMs = 7 * 86400000,
  }) {
    if (!staffRoles.has(role)) throw fail(400, 'Недопустимая роль сотрудника.');
    const actor = db
      .prepare('SELECT role,status FROM memberships WHERE organization_id=? AND account_id=?')
      .get(organizationId, invitedBy);
    if (!actor || actor.status !== 'active' || !['owner', 'salon_admin'].includes(actor.role))
      throw fail(403, 'Недостаточно прав для приглашения.');
    if (actor.role === 'salon_admin' && role !== 'cosmetologist')
      throw fail(403, 'Администратор может приглашать только сотрудников.');
    email = normalizeEmail(email);
    if (email) emailRule(email);
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare(
      'INSERT INTO invitations(token_hash,organization_id,invited_by,email_hash,role,expires_at) VALUES(?,?,?,?,?,?)',
    ).run(
      tokenHash(token),
      organizationId,
      invitedBy,
      email ? emailHash(email) : null,
      role,
      Date.now() + expiresInMs,
    );
    audit('invitation_created', invitedBy, organizationId, { role });
    return { token, expiresAt: Date.now() + expiresInMs };
  }
  async function acceptInvitation(
    { token, email, password, passwordConfirmation, displayName, privacyConsent = null },
    clientAddress = 'unknown',
    { requireEmailDelivery = false } = {},
  ) {
    const delivery = requireEmailDelivery ? context.assertEmailInvitation(token) : null;
    const invitation = db
      .prepare('SELECT * FROM invitations WHERE token_hash=?')
      .get(tokenHash(String(token || '')));
    if (!invitation || invitation.used_at || invitation.expires_at <= Date.now())
      throw fail(400, 'Приглашение недействительно или истекло.');
    email = normalizeEmail(email);
    emailRule(email);
    invitationPassword.assertEmail(invitation, email, delivery);
    const keys = loginLimitKeys(email, clientAddress);
    assertLoginAllowed(keys);
    const found = accountByEmail(email);
    const retiredOrganizationId = invitationPassword.assertOrganization(
      found,
      email,
      invitation.organization_id,
      requireEmailDelivery,
    );
    let accountId;
    const passwordSetupRequired =
      !found || (requireEmailDelivery && invitationPassword.setupRequired(found, email));
    if (passwordSetupRequired) displayName = textRule(displayName, 'имя');
    if (requireEmailDelivery && passwordSetupRequired)
      invitationPassword.assertConfirmation(password, passwordConfirmation);
    let passwordData;
    if (passwordSetupRequired) passwordData = await passwordFields(password, found?.row.id);
    else if (
      found.row.status !== 'active' ||
      !(await verifyPassword(found.value, password, found.row.id))
    )
      recordLoginFailure(keys);
    transaction(() => {
      assertLoginAllowed(keys);
      const freshDelivery = requireEmailDelivery ? context.assertEmailInvitation(token) : null;
      const freshInvitation = db
        .prepare('SELECT * FROM invitations WHERE token_hash=?')
        .get(invitation.token_hash);
      if (!freshInvitation || freshInvitation.used_at || freshInvitation.expires_at <= Date.now())
        throw fail(400, 'Приглашение недействительно или истекло.');
      invitationPassword.assertEmail(freshInvitation, email, freshDelivery);
      if (
        freshInvitation.organization_id !== invitation.organization_id ||
        freshInvitation.invited_by !== invitation.invited_by ||
        freshInvitation.role !== invitation.role ||
        freshInvitation.email_hash !== invitation.email_hash
      )
        throw fail(409, 'Приглашение изменилось. Откройте письмо повторно.');
      const inviter = db
        .prepare(
          `SELECT m.role,m.status,a.status account_status,o.status organization_status
          FROM memberships m JOIN accounts a ON a.id=m.account_id
          JOIN organizations o ON o.id=m.organization_id
          WHERE m.organization_id=? AND m.account_id=?`,
        )
        .get(invitation.organization_id, invitation.invited_by);
      if (
        !inviter ||
        inviter.status !== 'active' ||
        inviter.account_status !== 'active' ||
        inviter.organization_status !== 'active' ||
        !['owner', 'salon_admin'].includes(inviter.role) ||
        (inviter.role === 'salon_admin' && invitation.role !== 'cosmetologist')
      )
        throw fail(403, 'Пригласивший сотрудник больше не имеет доступа.');
      const currentAccount = accountByEmail(email);
      invitationPassword.assertCurrent(
        found,
        currentAccount,
        email,
        passwordSetupRequired,
        requireEmailDelivery,
      );
      if (
        invitationPassword.assertOrganization(
          currentAccount,
          email,
          invitation.organization_id,
          requireEmailDelivery,
        ) !== retiredOrganizationId
      )
        throw fail(409, 'Доступ изменился. Откройте приглашение из письма повторно.');
      if (!found) {
        accountId = id();
        db.prepare('INSERT INTO accounts(id,email_hash,value,created_at) VALUES(?,?,?,?)').run(
          accountId,
          emailHash(email),
          seal({
            email,
            displayName,
            ...passwordData,
            emailVerified: true,
            ...(privacyConsent ? { privacyConsent } : {}),
          }),
          Date.now(),
        );
      } else {
        accountId = found.row.id;
        if (passwordSetupRequired)
          invitationPassword.complete(currentAccount, {
            passwordData,
            displayName,
            privacyConsent,
            organizationId: invitation.organization_id,
            retiredOrganizationId,
          });
        else if (requireEmailDelivery && !found.value.emailVerified)
          db.prepare('UPDATE accounts SET value=? WHERE id=?').run(
            seal({ ...currentAccount.value, emailVerified: true }),
            accountId,
          );
      }
      if (
        db
          .prepare('SELECT 1 FROM memberships WHERE organization_id=? AND account_id=?')
          .get(invitation.organization_id, accountId)
      )
        throw fail(409, 'Пользователь уже состоит в этом кабинете.');
      db.prepare(
        'INSERT INTO memberships(organization_id,account_id,role,created_at) VALUES(?,?,?,?)',
      ).run(invitation.organization_id, accountId, invitation.role, Date.now());
      db.prepare('UPDATE invitations SET used_at=? WHERE token_hash=?').run(
        Date.now(),
        invitation.token_hash,
      );
      audit('invitation_accepted', accountId, invitation.organization_id, {
        role: invitation.role,
      });
    });
    clearLoginFailures(keys);
    return { accountId, organizationId: invitation.organization_id, role: invitation.role };
  }
  function organizationAccess(organizationId, actorId) {
    const actor = db
      .prepare('SELECT role,status FROM memberships WHERE organization_id=? AND account_id=?')
      .get(organizationId, actorId);
    if (!actor || actor.status !== 'active' || !['owner', 'salon_admin'].includes(actor.role))
      throw fail(403, 'Управление сотрудниками доступно владельцу и администратору.');
    const members = db
      .prepare(
        `SELECT m.account_id,m.role,m.status,a.value
      FROM memberships m JOIN accounts a ON a.id=m.account_id
      WHERE m.organization_id=? ORDER BY m.created_at`,
      )
      .all(organizationId)
      .map((row) => {
        const value = open(row.value);
        return {
          accountId: row.account_id,
          displayName: value.displayName,
          specialty: context.staffSpecialty(organizationId, row.account_id),
          email: value.email,
          role: row.role,
          status: row.status,
          notifications: require('./team-connections.cjs').teamConnections(
            context,
            organizationId,
            row.account_id,
          ),
        };
      });
    return {
      actorRole: actor.role,
      canManageMembers: actor.role === 'owner',
      members,
      invitations: context.emailInvitations(organizationId, actorId),
    };
  }
  function updateMembership({ organizationId, actorId, accountId, role, status }) {
    return transaction(() => {
      const actor = db
        .prepare(
          `SELECT m.role,m.status,a.status account_status,o.status organization_status
        FROM memberships m JOIN accounts a ON a.id=m.account_id
        JOIN organizations o ON o.id=m.organization_id
        WHERE m.organization_id=? AND m.account_id=?`,
        )
        .get(organizationId, actorId);
      if (
        !actor ||
        actor.status !== 'active' ||
        actor.role !== 'owner' ||
        actor.account_status !== 'active' ||
        actor.organization_status !== 'active'
      )
        throw fail(403, 'Изменять роли и доступ может только владелец.');
      const member = db
        .prepare(
          `SELECT m.role,m.status,a.status account_status FROM memberships m
        JOIN accounts a ON a.id=m.account_id WHERE m.organization_id=? AND m.account_id=?`,
        )
        .get(organizationId, accountId);
      if (!member) throw fail(404, 'Сотрудник не найден.');
      if (member.role === 'owner' || accountId === actorId)
        throw fail(403, 'Нельзя изменить доступ владельца кабинета.');
      if (!staffRoles.has(role)) throw fail(400, 'Недопустимая роль сотрудника.');
      if (!['active', 'suspended'].includes(status))
        throw fail(400, 'Недопустимый статус доступа.');
      if (status === 'active') {
        if (member.account_status !== 'active')
          throw fail(409, 'Учётная запись получателя недоступна.');
        if (availableMemberships(accountId).some((link) => link.organizationId !== organizationId))
          throw fail(
            409,
            'Для другой организации используйте отдельную учётную запись с другой почтой.',
          );
      }
      db.prepare(
        'UPDATE memberships SET role=?,status=? WHERE organization_id=? AND account_id=?',
      ).run(role, status, organizationId, accountId);
      db.prepare('DELETE FROM platform_sessions WHERE organization_id=? AND account_id=?').run(
        organizationId,
        accountId,
      );
      audit('membership_updated', actorId, organizationId, { accountId, role, status });
      return organizationAccess(organizationId, actorId);
    });
  }
  const subscriptionQuery = () =>
    (subscriptionStatement ??= db.prepare(
      'SELECT plan,status,limits,changed_at FROM subscriptions WHERE organization_id=?',
    ));
  function subscription(organizationId) {
    const row = subscriptionQuery().get(organizationId);
    if (!row) throw fail(404, 'Тариф кабинета не найден.');
    return {
      plan: row.plan,
      status: row.status,
      limits: open(row.limits),
      changedAt: row.changed_at,
    };
  }
  const organizationQuery = () =>
    (organizationStatement ??= db.prepare(
      'SELECT id,value,slug,status FROM organizations WHERE id=?',
    ));
  function organization(organizationId) {
    const row = organizationQuery().get(organizationId);
    if (!row) throw fail(404, 'Кабинет не найден.');
    return { id: row.id, slug: row.slug, status: row.status, ...open(row.value) };
  }
  const responseReadRequests = (query, organizationId) => {
    if (!db.canPrefetchReads) return [];
    const statement = query();
    return statement.readRequest ? [statement.readRequest('get', [organizationId])] : [];
  };
  subscription.readRequests = (org) => responseReadRequests(subscriptionQuery, org);
  organization.readRequests = (org) => responseReadRequests(organizationQuery, org);
  return {
    uniqueSlug,
    memberships,
    createInvitation,
    acceptInvitation,
    organizationAccess,
    updateMembership,
    subscription,
    organization,
    availableMemberships,
  };
}
module.exports = { createOrganizations };
