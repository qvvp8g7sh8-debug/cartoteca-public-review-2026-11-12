function createLoginLimits(context) {
  const {
    LOGIN_ATTEMPT_WINDOW_MS,
    LOGIN_BLOCK_MS,
    LOGIN_MAX_FAILURES,
    audit,
    db,
    fail,
    limitKey,
    normalizeEmail,
    transaction,
  } = context;
  function loginLimitKeys(email, clientAddress) {
    return [limitKey('email', normalizeEmail(email)), limitKey('client', clientAddress)];
  }
  function assertLoginAllowed(keys) {
    const now = Date.now(),
      present = [];
    for (const currentKey of keys) {
      const row = db
        .prepare('SELECT failures,window_started,blocked_until FROM login_limits WHERE key=?')
        .get(currentKey);
      if (!row) continue;
      present.push(currentKey);
      if (row.blocked_until > now) {
        const minutes = Math.max(1, Math.ceil((row.blocked_until - now) / 60000));
        throw fail(429, `Слишком много неверных попыток. Повторите вход через ${minutes} мин.`);
      }
      // Expired counters are inert. A later failure replaces their window;
      // successful authentication removes only observed keys in its own TX.
    }
    return present;
  }
  function recordLoginFailure(keys) {
    const now = Date.now();
    let highest = 0;
    transaction(() => {
      for (const currentKey of keys) {
        const row = db
          .prepare('SELECT failures,window_started FROM login_limits WHERE key=?')
          .get(currentKey);
        const expired = !row || row.window_started + LOGIN_ATTEMPT_WINDOW_MS <= now;
        const failures = expired ? 1 : row.failures + 1;
        const windowStarted = expired ? now : row.window_started;
        const blockedUntil = failures >= LOGIN_MAX_FAILURES ? now + LOGIN_BLOCK_MS : 0;
        db.prepare(
          `INSERT INTO login_limits(key,failures,window_started,blocked_until) VALUES(?,?,?,?)
          ON CONFLICT(key) DO UPDATE SET failures=excluded.failures,window_started=excluded.window_started,blocked_until=excluded.blocked_until`,
        ).run(currentKey, failures, windowStarted, blockedUntil);
        highest = Math.max(highest, failures);
      }
    });
    audit('login_failed', null, null, { failures: Math.min(highest, LOGIN_MAX_FAILURES) });
    if (highest >= LOGIN_MAX_FAILURES)
      throw fail(429, 'Слишком много неверных попыток. Вход заблокирован на 15 минут.');
    throw fail(
      401,
      `Неверная почта или пароль. Осталось попыток: ${LOGIN_MAX_FAILURES - highest}.`,
    );
  }
  function clearLoginFailures(keys, { transactionOwned = false } = {}) {
    const statement = db.prepare('DELETE FROM login_limits WHERE key=?');
    const clear = () => {
      for (const currentKey of keys) statement.run(currentKey);
    };
    if (transactionOwned) {
      if (!db.isTransaction) throw Error('Authentication reset requires its owning transaction');
      return clear();
    }
    return transaction(clear);
  }
  return { loginLimitKeys, assertLoginAllowed, recordLoginFailure, clearLoginFailures };
}
module.exports = { createLoginLimits };
