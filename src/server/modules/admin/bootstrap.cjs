function createBootstrap(context) {
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
    passwordFields,
    seal,
    textRule,
    tokenHash,
    transaction,
  } = context;
  async function bootstrapGlobalAdmin({ email, password, displayName }, authorize = () => {}) {
    if (db.prepare('SELECT 1 FROM accounts WHERE global_admin=1').get())
      throw fail(409, 'Глобальный администратор уже создан.');
    email = normalizeEmail(email);
    emailRule(email);
    displayName = textRule(displayName, 'имя');
    if (accountByEmail(email)) throw fail(409, 'Пользователь с такой почтой уже существует.');
    const passwordData = await passwordFields(password);
    const accountId = id();
    transaction(() => {
      authorize();
      if (db.prepare('SELECT 1 FROM accounts WHERE global_admin=1').get())
        throw fail(409, 'Глобальный администратор уже создан.');
      if (accountByEmail(email)) throw fail(409, 'Пользователь с такой почтой уже существует.');
      db.prepare(
        'INSERT INTO accounts(id,email_hash,value,global_admin,created_at) VALUES(?,?,?,1,?)',
      ).run(
        accountId,
        emailHash(email),
        seal({ email, displayName, ...passwordData, emailVerified: true }),
        Date.now(),
      );
      audit('global_admin_created', accountId);
    });
    return { accountId };
  }
  function issueGlobalAdminBootstrap(expiresInMs = 30 * 60000) {
    if (db.prepare('SELECT 1 FROM accounts WHERE global_admin=1').get())
      throw fail(409, 'Глобальный администратор уже создан.');
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM admin_bootstraps').run();
    db.prepare('INSERT INTO admin_bootstraps(token_hash,expires_at) VALUES(?,?)').run(
      tokenHash(token),
      Date.now() + expiresInMs,
    );
    return token;
  }
  function globalAdminBootstrapStatus(token) {
    const exists = Boolean(db.prepare('SELECT 1 FROM accounts WHERE global_admin=1').get());
    const row = db
      .prepare('SELECT expires_at,used_at FROM admin_bootstraps WHERE token_hash=?')
      .get(tokenHash(String(token || '')));
    return {
      exists,
      valid: !exists && Boolean(row && !row.used_at && row.expires_at > Date.now()),
    };
  }
  async function consumeGlobalAdminBootstrap(token, fields) {
    if (!globalAdminBootstrapStatus(token).valid)
      throw fail(403, 'Ссылка настройки недействительна или истекла.');
    const result = await bootstrapGlobalAdmin(fields, () => {
      if (!globalAdminBootstrapStatus(token).valid)
        throw fail(403, 'Ссылка настройки недействительна или истекла.');
    });
    db.prepare('UPDATE admin_bootstraps SET used_at=? WHERE token_hash=?').run(
      Date.now(),
      tokenHash(String(token)),
    );
    return result;
  }
  return {
    bootstrapGlobalAdmin,
    issueGlobalAdminBootstrap,
    globalAdminBootstrapStatus,
    consumeGlobalAdminBootstrap,
  };
}
module.exports = { createBootstrap };
