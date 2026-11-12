function createRecovery(context) {
  const {
    accountByEmail,
    audit,
    crypto,
    db,
    fail,
    normalizeEmail,
    open,
    passwordFields,
    seal,
    tokenHash,
    transaction,
  } = context;
  function verifyEmail(token) {
    return transaction(() => {
      const row = db
        .prepare('SELECT * FROM email_verifications WHERE token_hash=?')
        .get(tokenHash(String(token || '')));
      if (!row || row.used_at || row.expires_at <= Date.now())
        throw fail(400, 'Ссылка подтверждения недействительна или истекла.');
      const account = db
        .prepare('SELECT value FROM accounts WHERE id=? AND status=?')
        .get(row.account_id, 'active');
      if (!account) throw fail(404, 'Учётная запись не найдена.');
      const value = open(account.value);
      db.prepare('UPDATE accounts SET value=? WHERE id=?').run(
        seal({ ...value, emailVerified: true }),
        row.account_id,
      );
      db.prepare('UPDATE email_verifications SET used_at=? WHERE token_hash=?').run(
        Date.now(),
        row.token_hash,
      );
      audit('email_verified', row.account_id);
      return { accountId: row.account_id };
    });
  }
  function requestPasswordReset(email) {
    return transaction(() => {
      const found = accountByEmail(normalizeEmail(email));
      if (!found || found.row.status !== 'active') return null;
      const token = crypto.randomBytes(32).toString('base64url');
      // A new request cannot invalidate a previously delivered, still valid link.
      db.prepare(
        'DELETE FROM password_resets WHERE account_id=? AND (used_at IS NOT NULL OR expires_at<=?)',
      ).run(found.row.id, Date.now());
      db.prepare('INSERT INTO password_resets(token_hash,account_id,expires_at) VALUES(?,?,?)').run(
        tokenHash(token),
        found.row.id,
        Date.now() + 15 * 60000,
      );
      audit('password_reset_requested', found.row.id);
      return token;
    });
  }
  function revokePasswordReset(token) {
    db.prepare('DELETE FROM password_resets WHERE token_hash=? AND used_at IS NULL').run(
      tokenHash(token),
    );
  }
  async function resetPassword(token, password) {
    const row = db
      .prepare('SELECT * FROM password_resets WHERE token_hash=?')
      .get(tokenHash(String(token || '')));
    if (!row || row.used_at || row.expires_at <= Date.now())
      throw fail(400, 'Ссылка восстановления недействительна или истекла.');
    const account = db
      .prepare('SELECT value FROM accounts WHERE id=? AND status=?')
      .get(row.account_id, 'active');
    if (!account) throw fail(404, 'Учётная запись не найдена.');
    const fields = await passwordFields(password, row.account_id);
    transaction(() => {
      const freshToken = db
        .prepare('SELECT * FROM password_resets WHERE token_hash=?')
        .get(row.token_hash);
      if (!freshToken || freshToken.used_at || freshToken.expires_at <= Date.now())
        throw fail(400, 'Ссылка восстановления недействительна или истекла.');
      const fresh = db
        .prepare('SELECT value FROM accounts WHERE id=? AND status=?')
        .get(row.account_id, 'active');
      if (!fresh) throw fail(404, 'Учётная запись не найдена.');
      db.prepare('UPDATE accounts SET value=? WHERE id=?').run(
        seal({ ...open(fresh.value), ...fields }),
        row.account_id,
      );
      // All outstanding links become unusable after any successful reset.
      db.prepare('UPDATE password_resets SET used_at=? WHERE account_id=? AND used_at IS NULL').run(
        Date.now(),
        row.account_id,
      );
      db.prepare('DELETE FROM platform_sessions WHERE account_id=?').run(row.account_id);
      audit('password_reset_completed', row.account_id);
    });
    return { ok: true };
  }
  return { verifyEmail, requestPasswordReset, revokePasswordReset, resetPassword };
}
module.exports = { createRecovery };
