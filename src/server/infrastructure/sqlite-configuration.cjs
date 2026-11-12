const { fail } = require('../../shared/errors.cjs');
const { Int32Array, SharedArrayBuffer, Atomics } = globalThis;
const waitArray = new Int32Array(new SharedArrayBuffer(4));

// PRAGMA journal_mode can return SQLITE_BUSY immediately despite busy_timeout.
// Retry only connection configuration, never a transaction or a clinical write.
function configureSqlite(
  db,
  { timeout = 5000, now = Date.now, pause = (ms) => Atomics.wait(waitArray, 0, 0, ms) } = {},
) {
  const deadline = now() + timeout;
  for (;;) {
    try {
      db.exec('PRAGMA busy_timeout=' + Math.max(0, deadline - now()) + ';');
      const mode = db.prepare('PRAGMA journal_mode').get().journal_mode;
      if (String(mode).toLowerCase() !== 'wal') db.exec('PRAGMA journal_mode=WAL;');
      db.exec('PRAGMA synchronous=FULL;');
      db.exec('PRAGMA busy_timeout=5000;');
      return;
    } catch (error) {
      if (error.code !== 'ERR_SQLITE_ERROR' || ![5, 6].includes(error.errcode & 255)) throw error;
      const remaining = deadline - now();
      if (remaining <= 0) {
        const unavailable = fail(503, 'База временно занята. Повторите запрос.');
        unavailable.retryAfter = 1;
        throw unavailable;
      }
      pause(Math.min(25, remaining));
    }
  }
}
module.exports = { configureSqlite };
