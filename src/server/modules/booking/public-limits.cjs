const { fail } = require('../../../shared/errors.cjs');
const { phoneKey } = require('./contacts.cjs');
function createBookingPublicLimits(context, { readBudget = null, clock = Date.now } = {}) {
  const { limitKey } = context;
  function counters(store) {
    return {
      ...store,
      lastCleanup: null,
      sweep: store.db.prepare(
        "DELETE FROM login_limits WHERE key IN (SELECT key FROM login_limits WHERE key>='booking-budget:' AND key<'booking-budget;' AND blocked_until<=? ORDER BY key LIMIT 500)",
      ),
      select: store.db.prepare(
        'SELECT failures,window_started,blocked_until FROM login_limits WHERE key=?',
      ),
      put: store.db.prepare(
        'INSERT INTO login_limits(key,failures,window_started,blocked_until) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET failures=excluded.failures,window_started=excluded.window_started,blocked_until=excluded.blocked_until',
      ),
    };
  }
  const common = counters(context),
    read = readBudget ? counters(readBudget) : common;
  function consume(action, org, address, phone = '', time = clock, options = null) {
    const store = action === 'read' ? read : common;
    const rules =
      action === 'submit'
        ? [
            ['address', address, 12, 3600000],
            ['phone', [org, phoneKey(phone)].join(':'), 3, 3600000],
            ['organization', org, 120, 3600000],
            ['site-write', 'all', 2000, 3600000],
          ]
        : [
            ['read-address', address, 240, 60000],
            ['site-read', 'all', 20000, 60000],
          ];
    if (!['read', 'submit'].includes(action)) throw Error('Unknown booking budget.');
    let cleanedAt = null;
    const commitCleanup = () => {
      if (cleanedAt !== null) store.lastCleanup = cleanedAt;
    };
    const callback = () => {
      // Compute after admission, not when this request joined the async queue.
      const now = typeof time === 'function' ? time() : time;
      const last = store.cleanup ? store.cleanup.last() : store.lastCleanup;
      const clean = last === null || now < last || now - last >= 1000;
      const records = rules.map(([scope, value, max, window]) => {
        const key = limitKey('booking-budget:' + scope, value);
        const saved = store.select.get(key);
        // Expiry is checked independently of physical cleanup and other workers.
        const row = saved?.blocked_until > now ? saved : undefined;
        return { key, row, max, window };
      });
      const wait = Math.max(
        0,
        ...records
          .filter((r) => r.row?.blocked_until > now && r.row.failures >= r.max)
          .map((r) => r.row.blocked_until - now),
      );
      if (wait) {
        const error = fail(429, 'Слишком частые запросы. Попробуйте позже.');
        error.retryAfter = Math.ceil(wait / 1000);
        throw error;
      }
      // Denied requests do not perform cleanup that would be rolled back anyway.
      if (clean) {
        store.sweep.run(now);
        // The isolated store's marker is atomic with the counters, shared by workers.
        store.cleanup?.mark(now);
        cleanedAt = now;
      }
      for (const r of records)
        store.put.run(
          r.key,
          r.row ? r.row.failures + 1 : 1,
          r.row?.window_started ?? now,
          r.row?.blocked_until ?? now + r.window,
        );
    };
    if (options && store.asyncTransaction)
      return store.asyncTransaction(callback, { ...options, committed: commitCleanup });
    const result = store.transaction(callback);
    // Update synchronously after COMMIT, before a subsequent queued callback starts.
    commitCleanup();
    return result;
  }
  return {
    consume,
    consumeReadAsync: (address, options = {}) => consume('read', '', address, '', clock, options),
  };
}
module.exports = { createBookingPublicLimits };
