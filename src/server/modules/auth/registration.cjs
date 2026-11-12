function createRegistration(context) {
  const {
    FREE_LIMITS,
    accountByEmail,
    audit,
    crypto,
    db,
    emailHash,
    emailRule,
    fail,
    id,
    normalizeEmail,
    passwordFields,
    seal,
    textRule,
    tokenHash,
    transaction,
    uniqueSlug,
    verifyPassword,
    loginLimitKeys,
    assertLoginAllowed,
    recordLoginFailure,
    clearLoginFailures,
  } = context;
  function issueEmailVerification(accountId) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM email_verifications WHERE account_id=? OR expires_at<=?').run(
      accountId,
      Date.now(),
    );
    db.prepare(
      'INSERT INTO email_verifications(token_hash,account_id,expires_at) VALUES(?,?,?)',
    ).run(tokenHash(token), accountId, Date.now() + 24 * 3600000);
    return token;
  }
  function revokeEmailVerification(token) {
    db.prepare('DELETE FROM email_verifications WHERE token_hash=? AND used_at IS NULL').run(
      tokenHash(token),
    );
  }
  async function registerOwner(
    {
      email,
      password,
      displayName,
      organizationName,
      city = '',
      phone = '',
      privacyConsent = null,
    },
    clientAddress = 'unknown',
  ) {
    email = normalizeEmail(email);
    emailRule(email);
    displayName = textRule(displayName, 'имя');
    organizationName = textRule(organizationName, 'название организации или имя специалиста');
    city = typeof city === 'string' ? city.trim().slice(0, 120) : '';
    phone = typeof phone === 'string' ? phone.trim().slice(0, 40) : '';
    const existing = accountByEmail(email);
    if (existing) {
      if (existing.row.status !== 'active' || existing.value.emailVerified)
        throw fail(409, 'Пользователь с такой почтой уже существует.');
      const keys = loginLimitKeys(email, clientAddress);
      assertLoginAllowed(keys);
      if (!(await verifyPassword(existing.value, password, existing.row.id)))
        recordLoginFailure(keys);
      const result = transaction(() => {
        assertLoginAllowed(keys);
        const fresh = accountByEmail(email);
        if (
          !fresh ||
          fresh.row.id !== existing.row.id ||
          fresh.row.status !== 'active' ||
          fresh.value.emailVerified ||
          fresh.value.passwordHash !== existing.value.passwordHash ||
          fresh.value.salt !== existing.value.salt
        )
          throw fail(409, 'Учётная запись изменилась. Повторите вход.');
        const membership = db
          .prepare(
            "SELECT organization_id FROM memberships WHERE account_id=? AND role='owner' AND status='active'",
          )
          .get(fresh.row.id);
        if (!membership)
          throw fail(409, 'Повторная регистрация недоступна. Обратитесь к владельцу сервиса.');
        if (privacyConsent)
          db.prepare('UPDATE accounts SET value=? WHERE id=?').run(
            seal({ ...fresh.value, privacyConsent }),
            fresh.row.id,
          );
        audit('registration_verification_retried', fresh.row.id, membership.organization_id);
        return {
          accountId: fresh.row.id,
          organizationId: membership.organization_id,
          emailVerified: false,
          verificationToken: issueEmailVerification(fresh.row.id),
        };
      });
      clearLoginFailures(keys);
      return result;
    }
    const passwordData = await passwordFields(password);
    const accountId = id(),
      organizationId = id(),
      now = Date.now();
    const verificationToken = transaction(() => {
      if (accountByEmail(email)) throw fail(409, 'Пользователь с такой почтой уже существует.');
      db.prepare('INSERT INTO accounts(id,email_hash,value,created_at) VALUES(?,?,?,?)').run(
        accountId,
        emailHash(email),
        seal({
          email,
          displayName,
          ...passwordData,
          emailVerified: false,
          ...(privacyConsent ? { privacyConsent } : {}),
        }),
        now,
      );
      db.prepare('INSERT INTO organizations(id,value,slug,created_at) VALUES(?,?,?,?)').run(
        organizationId,
        seal({ name: organizationName, city, phone, timeZone: 'Europe/Moscow' }),
        uniqueSlug(organizationName),
        now,
      );
      db.prepare(
        'INSERT INTO memberships(organization_id,account_id,role,created_at) VALUES(?,?,?,?)',
      ).run(organizationId, accountId, 'owner', now);
      db.prepare(
        'INSERT INTO subscriptions(organization_id,plan,status,limits,changed_at) VALUES(?,?,?,?,?)',
      ).run(organizationId, 'free', 'active', seal(FREE_LIMITS), now);
      audit('owner_registered', accountId, organizationId);
      return issueEmailVerification(accountId);
    });
    return { accountId, organizationId, emailVerified: false, verificationToken };
  }
  function importLegacyOwner({
    email,
    displayName = 'Владелец',
    organizationName = 'Картотека',
    salt,
    passwordHash,
  }) {
    if (db.prepare('SELECT 1 FROM accounts LIMIT 1').get())
      throw fail(409, 'Платформа уже содержит пользователей.');
    email = normalizeEmail(email);
    emailRule(email);
    displayName = textRule(displayName, 'имя');
    organizationName = textRule(organizationName, 'название кабинета');
    if (
      !/^[a-f0-9]{32}$/i.test(String(salt || '')) ||
      !/^[a-f0-9]{128}$/i.test(String(passwordHash || ''))
    )
      throw fail(400, 'Некорректные данные прежнего владельца.');
    const accountId = id(),
      organizationId = id(),
      now = Date.now();
    transaction(() => {
      db.prepare('INSERT INTO accounts(id,email_hash,value,created_at) VALUES(?,?,?,?)').run(
        accountId,
        emailHash(email),
        seal({ email, displayName, salt, passwordHash, emailVerified: true }),
        now,
      );
      db.prepare('INSERT INTO organizations(id,value,slug,created_at) VALUES(?,?,?,?)').run(
        organizationId,
        seal({ name: organizationName, legacyData: true, timeZone: 'Europe/Moscow' }),
        uniqueSlug(organizationName),
        now,
      );
      db.prepare(
        'INSERT INTO memberships(organization_id,account_id,role,created_at) VALUES(?,?,?,?)',
      ).run(organizationId, accountId, 'owner', now);
      db.prepare(
        'INSERT INTO subscriptions(organization_id,plan,status,limits,changed_at) VALUES(?,?,?,?,?)',
      ).run(organizationId, 'free', 'active', seal(FREE_LIMITS), now);
      audit('legacy_owner_imported', accountId, organizationId);
    });
    return { accountId, organizationId };
  }
  return { issueEmailVerification, revokeEmailVerification, registerOwner, importLegacyOwner };
}
module.exports = { createRegistration };
