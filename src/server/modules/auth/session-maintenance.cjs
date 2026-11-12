// Expiry remains an authentication predicate; physical deletion is bounded housekeeping.
function createSessionMaintenance(
  c,
  { clock = Date.now, rowLimit = 128, intervalMs = 60000 } = {},
) {
  if (
    !Number.isSafeInteger(rowLimit) ||
    rowLimit < 1 ||
    rowLimit > 128 ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1000
  )
    throw Error('Invalid session maintenance budget');
  const page = c.db.prepare(
    'SELECT token_hash,expires_at FROM platform_sessions WHERE token_hash>? ORDER BY token_hash LIMIT ?',
  );
  const remove = c.db.prepare(
    'DELETE FROM platform_sessions WHERE token_hash IN (SELECT value FROM json_each(?)) AND expires_at<=?',
  );
  const totals = { calls: 0, examined: 0, expired: 0, changed: 0, errors: 0 };
  let cursor = '',
    busy = null,
    running = false,
    generation = 0,
    timer = null,
    suspended = false;
  function tick({ canRun = () => false, runWork = (callback) => callback() } = {}) {
    if (typeof canRun !== 'function' || typeof runWork !== 'function')
      return Promise.reject(TypeError('Session maintenance requires ownership and admission'));
    if (busy) return busy;
    const epoch = generation;
    const owned = () => !suspended && epoch === generation && canRun();
    busy = (async () => {
      if (!owned()) return { examined: 0, changed: 0 };
      const rows = await runWork(
        () => {
          if (!owned()) return null;
          let selected = page.all(cursor, rowLimit);
          if (!selected.length && cursor) selected = page.all('', rowLimit);
          return selected;
        },
        '',
        owned,
      );
      if (!rows || !owned()) return { examined: 0, changed: 0 };
      const selectedAt = clock();
      const expired = rows
        .filter((row) => row.expires_at <= selectedAt)
        .map((row) => row.token_hash);
      let changed = 0;
      if (expired.length) {
        const work = () => (owned() ? remove.run(JSON.stringify(expired), clock()).changes : 0);
        changed = await runWork(
          () => {
            if (!owned()) return 0;
            return c.asyncTransaction
              ? c.asyncTransaction(work, { cancelled: () => !owned() })
              : c.transaction(work);
          },
          '',
          owned,
        );
      }
      if (!owned()) return { examined: rows.length, changed: changed || 0 };
      cursor = rows.length === rowLimit ? rows.at(-1).token_hash : '';
      totals.calls++;
      totals.examined += rows.length;
      totals.expired += expired.length;
      totals.changed += changed || 0;
      return { examined: rows.length, changed: changed || 0 };
    })()
      .catch((error) => {
        totals.errors++;
        // An unknown COMMIT is never replayed by this background lifetime.
        if (error.outcomeUnknown || error.channelPoisoned) {
          suspended = true;
          stop();
        }
        throw error;
      })
      .finally(() => {
        busy = null;
      });
    return busy;
  }
  function stop() {
    running = false;
    generation++;
    clearTimeout(timer);
    timer = null;
  }
  function start(canRun, runWork = (callback) => callback()) {
    if (typeof canRun !== 'function' || typeof runWork !== 'function')
      throw TypeError('Session maintenance requires ownership and admission');
    if (running || suspended) return;
    running = true;
    const epoch = ++generation;
    const schedule = () => {
      if (!running || suspended || generation !== epoch) return;
      timer = setTimeout(async () => {
        timer = null;
        try {
          await tick({ canRun, runWork });
        } catch {
          /* Counters only; no authority payload. */
        }
        schedule();
      }, intervalMs);
      timer.unref?.();
    };
    schedule();
  }
  return {
    tick,
    start,
    stop,
    stats: () => ({ running, suspended, busy: Boolean(busy), rowLimit, intervalMs, ...totals }),
  };
}
module.exports = { createSessionMaintenance };
