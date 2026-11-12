const { createPreparedStatements } = require('../../infrastructure/prepared-statements.cjs');
const { sessionView } = require('./session-view152.cjs');
function createSessions(context) {
  const {
    SESSION_MS,
    assertLoginAllowed,
    audit,
    authenticate,
    availableMemberships,
    clearLoginFailures,
    crypto,
    db,
    fail,
    id,
    loginLimitKeys,
    open,
    recordLoginFailure,
    seal,
    tokenHash,
    transaction,
  } = context;
  const { prepare } = createPreparedStatements(db, { limit: 24 });
  async function login(
    email,
    password,
    userAgent = '',
    clientAddress = 'unknown',
    oneTimeCode = '',
  ) {
    const limitKeys = loginLimitKeys(email, clientAddress);
    assertLoginAllowed(limitKeys);
    let authenticated;
    try {
      authenticated = await authenticate(email, password);
    } catch (error) {
      if (error.status === 401) recordLoginFailure(limitKeys);
      throw error;
    }
    let ordinary = null;
    if (context.asyncAuthTransaction && authenticated.account.globalAdmin === false) {
      const hints = availableMemberships(authenticated.account.id);
      if (
        hints.length === 1 &&
        prepare(
          "SELECT a.id FROM accounts a JOIN organizations o ON o.id=? JOIN admin_directory_records d ON d.kind='account' AND d.resource_id=a.id AND d.source_value=a.value JOIN admin_directory_records g ON g.kind='organization' AND g.resource_id=o.id AND g.source_value=o.value WHERE a.id=?",
        ).get(hints[0].organizationId, authenticated.account.id)
      )
        ordinary = Object.freeze({
          accountId: authenticated.account.id,
          organizationId: hints[0].organizationId,
          emailHash: context.emailHash(email),
          clientKey: limitKeys[1],
        });
    }
    const write = ordinary
      ? (callback) =>
          context.asyncAuthTransaction(callback, ordinary).catch((error) => {
            if (
              error.code === 'POSTGRES_AUTH_AUTHORITY_CHANGED' &&
              error.transactionOpen === false &&
              !error.outcomeUnknown &&
              !error.channelPoisoned
            )
              throw fail(401, 'Войдите снова.');
            throw error;
          })
      : context.asyncTransaction || ((callback) => transaction(callback));
    const result = await write(() => {
      const resetKeys = assertLoginAllowed(limitKeys) || limitKeys;
      const row = prepare("SELECT * FROM accounts WHERE id=? AND status='active'").get(
        authenticated.account.id,
      );
      if (!row) throw fail(401, 'Войдите снова.');
      if (ordinary && (row.global_admin || row.email_hash !== ordinary.emailHash))
        throw fail(401, 'Войдите снова.');
      const value = open(row.value);
      if (require('./admin-mfa-values.cjs').passwordProof(value) !== authenticated.credentialProof)
        throw fail(401, 'Пароль изменился. Войдите снова.');
      if (!value.emailVerified)
        throw fail(
          403,
          'Подтвердите электронную почту. Если письмо не пришло, повторите регистрацию с той же почтой и паролем.',
        );
      const mfa = context.adminMfa.loginCheck(row, value, oneTimeCode);
      if (!mfa.ok) return { mfa };
      const memberships = availableMemberships(row.id);
      if (memberships.length > 1)
        throw fail(
          409,
          'К этой учётной записи привязано несколько организаций. Используйте отдельную учётную запись для каждой организации или обратитесь в поддержку.',
        );
      const organizationId = memberships.length === 1 ? memberships[0].organizationId : null;
      if (ordinary && organizationId !== ordinary.organizationId) throw fail(401, 'Войдите снова.');
      // Rate-limit reset, session and audit form one known atomic outcome.
      if (resetKeys.length) clearLoginFailures(resetKeys, { transactionOwned: true });
      const token = crypto.randomBytes(32).toString('base64url'),
        now = Date.now();
      prepare(
        'INSERT INTO platform_sessions(token_hash,id,account_id,organization_id,value,expires_at) VALUES(?,?,?,?,?,?)',
      ).run(
        tokenHash(token),
        id(),
        row.id,
        organizationId,
        seal({
          createdAt: now,
          userAgent: String(userAgent).slice(0, 200),
          ...(mfa.revision ? { adminMfaRevision: mfa.revision } : {}),
        }),
        now + SESSION_MS,
      );
      audit('login_succeeded', row.id, organizationId);
      return { token, account: context.publicAccount(row), memberships, organizationId };
    });
    if (result.mfa) {
      if (result.mfa.required)
        throw Object.assign(fail(401, 'Введите код из приложения или резервный код.'), {
          code: 'MFA_REQUIRED',
        });
      try {
        recordLoginFailure(limitKeys);
      } catch (error) {
        if (error.status === 401)
          throw Object.assign(fail(401, 'Код неверен, истёк или уже использован.'), {
            code: 'MFA_INVALID',
          });
        throw error;
      }
    }
    return result;
  }

  function session(token) {
    // Clinical compound transactions only observe authority. Session cleanup
    // and automatic cabinet selection belong to ordinary policy commands.
    const readOnly = ['COMPOUND', 'QUEUEORG', 'QUEUEENTITY', 'READONLY'].includes(
      db.transactionIntent,
    );
    const hash = tokenHash(String(token || ''));
    // Read authority as one current SQLite snapshot. Prepared SQL is reused;
    // session, account, membership and organization results are never cached.
    const row = prepare(
      `SELECT s.id,s.account_id,s.organization_id,s.expires_at,
        a.value AS account_value,s.value AS session_value,a.global_admin,a.status AS account_status,
        m.role AS membership_role,m.status AS membership_status,
        o.status AS organization_status
      FROM platform_sessions s JOIN accounts a ON a.id=s.account_id
      LEFT JOIN memberships m ON m.organization_id=s.organization_id AND m.account_id=s.account_id
      LEFT JOIN organizations o ON o.id=s.organization_id WHERE s.token_hash=?`,
    ).get(hash);
    if (!row || row.expires_at <= Date.now() || row.account_status !== 'active') {
      if (row && !readOnly) prepare('DELETE FROM platform_sessions WHERE token_hash=?').run(hash);
      return null;
    }
    let organizationAccess;
    if (!row.organization_id) {
      const available = availableMemberships(row.account_id);
      if (available.length === 1) {
        if (readOnly) return null;
        if (!db.isTransaction) return transaction(() => session(token));
        row.organization_id = available[0].organizationId;
        prepare('UPDATE platform_sessions SET organization_id=? WHERE token_hash=?').run(
          row.organization_id,
          hash,
        );
        audit('organization_selected', row.account_id, row.organization_id, { automatic: true });
        // The first joined row had no organization. Read the repaired session
        // within this transaction before exposing any authority from it.
        return session(token);
      } else organizationAccess = available.length ? 'conflict' : 'none';
    }
    return sessionView(row, open, organizationAccess);
  }
  function selectOrganization(token, organizationId) {
    return transaction(() => {
      const current = session(token);
      if (!current) throw fail(401, 'Войдите в картотеку.');
      const available = availableMemberships(current.accountId);
      if (available.length > 1)
        throw fail(
          409,
          'Для другой организации используйте отдельную учётную запись с другой почтой.',
        );
      const membership = available.find((member) => member.organizationId === organizationId);
      if (!membership) throw fail(403, 'Нет доступа к этому кабинету.');
      prepare('UPDATE platform_sessions SET organization_id=? WHERE token_hash=?').run(
        organizationId,
        tokenHash(token),
      );
      audit('organization_selected', current.accountId, organizationId);
      return session(token);
    });
  }
  function logout(token) {
    const current = session(token);
    prepare('DELETE FROM platform_sessions WHERE token_hash=?').run(tokenHash(String(token || '')));
    if (current) audit('logout', current.accountId, current.organizationId);
  }
  return { login, session, selectOrganization, logout };
}
module.exports = { createSessions };
