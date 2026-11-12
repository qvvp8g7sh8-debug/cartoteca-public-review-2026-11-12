function createAdminAccounts(context, policy, commands) {
  const { db, open, memberships } = context;
  function profile(row) {
    const value = open(row.value);
    return {
      id: row.id,
      email: value.email,
      displayName: value.displayName,
      globalAdmin: Boolean(row.global_admin),
      status: row.status,
      createdAt: row.created_at,
      emailVerified: Boolean(value.emailVerified),
    };
  }
  function detail(actorId, accountId) {
    policy.assert(actorId, 'accounts.read');
    const row = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId);
    if (!row) throw context.fail(404, 'Пользователь не найден.');
    const last = db
      .prepare(
        "SELECT max(time) time FROM platform_audit WHERE actor_id=? AND event='login_succeeded'",
      )
      .get(accountId);
    const pending = db
      .prepare(
        'SELECT id,expires_at,value FROM admin_email_recoveries WHERE account_id=? AND used_at IS NULL AND expires_at>? ORDER BY expires_at DESC LIMIT 1',
      )
      .get(accountId, Date.now());
    return {
      ...profile(row),
      memberships: memberships(row.id),
      revision: commands.revision('account', accountId),
      lastLoginAt: last.time || null,
      sessions: db
        .prepare('SELECT count(*) n FROM platform_sessions WHERE account_id=? AND expires_at>?')
        .get(accountId, Date.now()).n,
      recovery: pending
        ? {
            id: pending.id,
            expiresAt: pending.expires_at,
            email: open(pending.value).nextEmail,
            deliveries: db
              .prepare('SELECT kind,status,attempts FROM admin_email_jobs WHERE operation_id=?')
              .all(pending.id),
          }
        : null,
    };
  }
  function updateAccess(actorId, accountId, input) {
    if (actorId === accountId)
      throw context.fail(400, 'Нельзя заблокировать собственную учётную запись.');
    return commands.execute(
      actorId,
      'accounts.access',
      'account',
      accountId,
      input,
      () => {
        const row = policy.targetAccount(accountId);
        if (!['active', 'suspended'].includes(input.status))
          throw context.fail(400, 'Недопустимый статус пользователя.');
        db.prepare('UPDATE accounts SET status=? WHERE id=?').run(input.status, accountId);
        if (input.status === 'suspended')
          db.prepare('DELETE FROM platform_sessions WHERE account_id=?').run(accountId);
        return {
          event: 'account_access_admin_updated',
          detail: {
            before: { status: row.status },
            after: { status: input.status },
            scope: 'all_organizations',
          },
        };
      },
      { reasonRequired: true },
    );
  }
  function revokeSessions(actorId, accountId, input) {
    return commands.execute(
      actorId,
      'accounts.sessions',
      'account',
      accountId,
      input,
      () => {
        policy.targetAccount(accountId);
        const removed = db
          .prepare('DELETE FROM platform_sessions WHERE account_id=?')
          .run(accountId).changes;
        return {
          event: 'account_sessions_admin_revoked',
          detail: { after: { sessionsRevoked: Number(removed) } },
        };
      },
      { reasonRequired: true },
    );
  }
  return { profile, detail, updateAccess, revokeSessions };
}
module.exports = { createAdminAccounts };
