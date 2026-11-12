// Public request budgets are independent of password failures. Shared, HMAC-keyed
// SQLite counters survive restarts and are reserved atomically before expensive work.
const MINUTE = 60000,
  HOUR = 60 * MINUTE,
  DAY = 24 * HOUR;
const PUBLIC_AUTH_LIMITS = Object.freeze({
  invitation: Object.freeze([
    { scope: 'email-pause', max: 1, window: MINUTE },
    { scope: 'email', max: 3, window: HOUR },
    { scope: 'client', max: 30, window: HOUR },
    { scope: 'site-hour', max: 200, window: HOUR },
  ]),
  register: Object.freeze([
    { scope: 'email', max: 6, window: HOUR },
    { scope: 'client', max: 10, window: HOUR },
    { scope: 'site-hour', max: 100, window: HOUR },
    { scope: 'site-day', max: 500, window: DAY },
  ]),
  forgot: Object.freeze([
    { scope: 'email-pause', max: 1, window: MINUTE },
    { scope: 'email', max: 3, window: HOUR },
    { scope: 'client', max: 30, window: HOUR },
    { scope: 'site-hour', max: 100, window: HOUR },
  ]),
});
function createPublicAuthLimits({
  db,
  transaction,
  limitKey,
  normalizeEmail,
  emailRule,
  fail,
  now = Date.now,
}) {
  function consumePublicAuthRequest(action, email, clientAddress) {
    const policy = PUBLIC_AUTH_LIMITS[action];
    if (!policy) throw Error('Unknown public authentication action');
    email = normalizeEmail(email);
    emailRule(email);
    return transaction(() => {
      const time = now();
      // Never prune login failure counters or extend a blocked budget with rejected requests.
      db.prepare("DELETE FROM login_limits WHERE key LIKE 'public:%' AND blocked_until<=?").run(
        time,
      );
      const records = policy.map((rule) => {
        const value = rule.scope.startsWith('email')
          ? email
          : rule.scope === 'client'
            ? clientAddress
            : 'all';
        const key = limitKey('public:' + action + ':' + rule.scope, value);
        return {
          rule,
          key,
          row: db
            .prepare('SELECT failures,window_started,blocked_until FROM login_limits WHERE key=?')
            .get(key),
        };
      });
      const wait = Math.max(
        0,
        ...records
          .filter(({ rule, row }) => row && row.blocked_until > time && row.failures >= rule.max)
          .map(({ row }) => row.blocked_until - time),
      );
      if (wait) {
        const error = fail(
          429,
          `Слишком частые запросы. Повторите через ${Math.max(1, Math.ceil(wait / MINUTE))} мин.`,
        );
        error.retryAfter = Math.ceil(wait / 1000);
        throw error;
      }
      const put = db.prepare(
        'INSERT INTO login_limits(key,failures,window_started,blocked_until) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET failures=excluded.failures,window_started=excluded.window_started,blocked_until=excluded.blocked_until',
      );
      for (const { rule, key, row } of records) {
        const active = row && row.blocked_until > time;
        put.run(
          key,
          active ? row.failures + 1 : 1,
          active ? row.window_started : time,
          active ? row.blocked_until : time + rule.window,
        );
      }
    });
  }
  return { consumePublicAuthRequest };
}
module.exports = { createPublicAuthLimits, PUBLIC_AUTH_LIMITS };
