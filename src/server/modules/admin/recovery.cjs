function createAdminRecovery(context, policy, commands, queue) {
  const {
    db,
    open,
    seal,
    emailHash,
    normalizeEmail,
    emailRule,
    fail,
    crypto,
    id,
    tokenHash,
    limitKey,
    transaction,
    verifyPassword,
    audit,
  } = context;
  async function verifyActor(actorId, password, clientAddress = 'unknown') {
    policy.assert(actorId, 'accounts.recover');
    const row = db.prepare('SELECT value FROM accounts WHERE id=?').get(actorId);
    const value = open(row.value);
    const keys = [
      limitKey('admin-reauth-account', actorId),
      limitKey('admin-reauth-client', clientAddress),
    ];
    context.assertLoginAllowed(keys);
    if (!(await verifyPassword(value, password, actorId))) context.recordLoginFailure(keys);
    context.assertLoginAllowed(keys);
    policy.assert(actorId, 'accounts.recover');
    const fresh = open(db.prepare('SELECT value FROM accounts WHERE id=?').get(actorId).value);
    if (fresh.passwordHash !== value.passwordHash || fresh.salt !== value.salt)
      throw fail(409, 'Доступ администратора изменился. Повторите подтверждение.');
    context.clearLoginFailures(keys);
  }
  function prepare(actorId, accountId, input, origin) {
    const nextEmail = normalizeEmail(input.email);
    emailRule(nextEmail);
    if (input.identityConfirmed !== true)
      throw fail(400, 'Подтвердите проверку принадлежности аккаунта.');
    return commands.execute(
      actorId,
      'accounts.recover',
      'account',
      accountId,
      input,
      () => {
        const row = policy.targetAccount(accountId),
          value = open(row.value);
        if (row.status !== 'active') throw fail(409, 'Сначала восстановите доступ пользователя.');
        if (normalizeEmail(value.email) === nextEmail) throw fail(400, 'Укажите новую почту.');
        if (db.prepare('SELECT 1 FROM accounts WHERE email_hash=?').get(emailHash(nextEmail)))
          throw fail(409, 'Пользователь с такой почтой уже существует.');
        const pending = db
          .prepare(
            'SELECT 1 FROM admin_email_recoveries WHERE account_id=? AND used_at IS NULL AND expires_at>?',
          )
          .get(accountId, Date.now());
        if (pending) throw fail(409, 'Уже есть запрос смены почты. Отмените его перед новым.');
        const token = crypto.randomBytes(32).toString('base64url'),
          recoveryId = id();
        const expiresAt = Date.now() + 30 * 60000;
        db.prepare('INSERT INTO admin_email_recoveries VALUES(?,?,?,?,?,?,?)').run(
          recoveryId,
          accountId,
          actorId,
          tokenHash(token),
          expiresAt,
          null,
          seal({
            nextEmail,
            previousEmail: value.email,
            revision: input.expectedRevision + 1,
          }),
        );
        queue.enqueue(
          recoveryId,
          'email-recovery',
          {
            actorId,
            accountId,
            recoveryId,
            email: nextEmail,
            link: origin + '/login.html#confirm-email-change=' + encodeURIComponent(token),
          },
          expiresAt,
        );
        return {
          event: 'account_email_recovery_prepared',
          detail: {
            after: { recoveryPending: true },
            identityConfirmed: true,
          },
          result: { recoveryId, expiresAt, pending: true },
        };
      },
      { reasonRequired: true },
    );
  }
  function consumeConfirmation(clientAddress) {
    const now = Date.now();
    const keys = [
      [limitKey('email-confirm-client', clientAddress), 20],
      [limitKey('email-confirm-platform', 'global'), 300],
    ];
    const allowed = transaction(() => {
      for (const [key, maximum] of keys) {
        const row = db
          .prepare('SELECT failures,blocked_until FROM login_limits WHERE key=?')
          .get(key);
        if (row && row.blocked_until > now && row.failures >= maximum) return false;
      }
      for (const [key] of keys) {
        const row = db
          .prepare('SELECT failures,window_started,blocked_until FROM login_limits WHERE key=?')
          .get(key);
        const active = row && row.blocked_until > now;
        db.prepare(
          'INSERT INTO login_limits VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET failures=excluded.failures,window_started=excluded.window_started,blocked_until=excluded.blocked_until',
        ).run(
          key,
          active ? row.failures + 1 : 1,
          active ? row.window_started : now,
          active ? row.blocked_until : now + 60000,
        );
      }
      return true;
    });
    if (!allowed) {
      const error = fail(429, 'Слишком много подтверждений. Повторите через минуту.');
      error.retryAfter = 60;
      throw error;
    }
  }
  function cancel(actorId, accountId, input) {
    return commands.execute(
      actorId,
      'accounts.recover',
      'account',
      accountId,
      input,
      () => {
        policy.targetAccount(accountId);
        db.prepare(
          'UPDATE admin_email_recoveries SET used_at=? WHERE account_id=? AND used_at IS NULL',
        ).run(Date.now(), accountId);
        return {
          event: 'account_email_recovery_cancelled',
          detail: { after: { recoveryPending: false } },
        };
      },
      { reasonRequired: true },
    );
  }
  function confirm(token) {
    return transaction(() => {
      const row = db
        .prepare('SELECT * FROM admin_email_recoveries WHERE token_hash=?')
        .get(tokenHash(String(token || '')));
      if (!row || row.expires_at <= Date.now())
        throw fail(400, 'Ссылка недействительна или истекла.');
      const details = open(row.value);
      if (row.used_at) {
        if (details.completed === true) return { ok: true };
        throw fail(400, 'Запрос смены почты отменён.');
      }
      policy.assert(row.actor_id, 'accounts.recover');
      const account = policy.targetAccount(row.account_id),
        value = open(account.value);
      if (
        account.status !== 'active' ||
        value.email !== details.previousEmail ||
        commands.revision('account', row.account_id) !== details.revision
      )
        throw fail(409, 'Учётная запись изменилась. Обратитесь в поддержку за новой ссылкой.');
      if (db.prepare('SELECT 1 FROM accounts WHERE email_hash=?').get(emailHash(details.nextEmail)))
        throw fail(409, 'Эта почта уже используется другим аккаунтом.');
      db.prepare('UPDATE accounts SET email_hash=?,value=? WHERE id=?').run(
        emailHash(details.nextEmail),
        seal({ ...value, email: details.nextEmail, emailVerified: true }),
        row.account_id,
      );
      for (const table of ['platform_sessions', 'email_verifications', 'password_resets'])
        db.prepare('DELETE FROM ' + table + ' WHERE account_id=?').run(row.account_id);
      db.prepare('DELETE FROM login_limits WHERE key IN (?,?)').run(
        limitKey('email', value.email),
        limitKey('email', details.nextEmail),
      );
      db.prepare('UPDATE admin_email_recoveries SET used_at=?,value=? WHERE id=?').run(
        Date.now(),
        seal({ ...details, completed: true }),
        row.id,
      );
      commands.touch('account', row.account_id);
      commands.record(row.actor_id, 'account', row.account_id, 'account_email_changed', {
        operationId: row.id,
        after: { emailVerified: true, sessionsRevoked: true },
        reason: 'Новая почта подтверждена по проверенному запросу восстановления.',
      });
      for (const [kind, email] of [
        ['email-change-old', value.email],
        ['email-change-new', details.nextEmail],
      ])
        queue.enqueue(row.id, kind, {
          actorId: row.actor_id,
          email,
          message:
            'Адрес для входа в Картотеку изменён после обращения в поддержку. ' +
            'Прежние сеансы завершены. Если вы не запрашивали изменение, обратитесь в поддержку.',
        });
      audit('email_recovery_confirmed', row.account_id);
      return { ok: true };
    });
  }
  return { verifyActor, prepare, cancel, confirm, consumeConfirmation };
}
module.exports = { createAdminRecovery };
