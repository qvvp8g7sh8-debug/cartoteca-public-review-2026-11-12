const { performance } = require('node:perf_hooks');
const { setTimeout: sleep, setImmediate: yieldToIO } = require('node:timers/promises');
const { fail } = require('../../shared/errors.cjs');

const unavailable = () => {
  const error = fail(503, 'База временно занята. Повторите запрос.');
  error.retryAfter = 1;
  return error;
};
// Await only BEFORE BEGIN succeeds. Callback/COMMIT are synchronous and never retried.
// A bounded per-connection FIFO prevents hundreds of bodies/timers accumulating on contention.
function createAsyncWriteLock(
  db,
  {
    timeoutMs = 5000,
    maxPending = 64,
    maxBytes = 16 * 1024 * 1024,
    acquire = () => db.exec('BEGIN IMMEDIATE'),
  } = {},
) {
  const queue = [];
  let active = false,
    closed = false,
    bytes = 0,
    completedInSlice = 0,
    sliceStarted = performance.now();
  const totals = {
    admitted: 0,
    refused: 0,
    busyAttempts: 0,
    timedOut: 0,
    cancelled: 0,
    peakPending: 0,
    yields: 0,
  };
  function assertWaiting(item) {
    if (closed || !db.isOpen) throw unavailable();
    if (item.options.cancelled?.()) {
      totals.cancelled++;
      throw fail(499, 'Запрос отменён.');
    }
    if (performance.now() >= item.deadline) {
      totals.timedOut++;
      throw unavailable();
    }
  }
  async function execute(item) {
    for (;;) {
      assertWaiting(item);
      if (db.isTransaction) throw Error('Async writer cannot nest inside a transaction');
      const previous = db.prepare('PRAGMA busy_timeout').get().timeout;
      let acquired = false;
      try {
        db.exec('PRAGMA busy_timeout=0');
        acquire(item.options);
        acquired = true;
      } catch (error) {
        if (error.code !== 'ERR_SQLITE_ERROR' || ![5, 6].includes(error.errcode & 255)) throw error;
        totals.busyAttempts++;
      } finally {
        db.exec('PRAGMA busy_timeout=' + previous);
      }
      if (!acquired) {
        await sleep(
          Math.min(
            5 + Math.floor(Math.random() * 21),
            Math.max(1, item.deadline - performance.now()),
          ),
        );
        continue;
      }
      try {
        assertWaiting(item);
        const result = item.callback();
        if (result && typeof result.then === 'function')
          throw Error('Asynchronous transaction callback is not allowed');
        const started = performance.now();
        db.exec('COMMIT');
        // Diagnostics must not turn a successfully committed write into an error.
        try {
          item.options.committed?.(performance.now() - started);
        } catch {}
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    }
  }
  async function pump() {
    if (active) return;
    active = true;
    try {
      while (queue.length) {
        const item = queue[0];
        try {
          item.resolve(await execute(item));
        } catch (error) {
          item.reject(error);
        }
        queue.shift();
        bytes -= item.bytes;
        // A resolved Promise only yields to microtasks. Bound a synchronous SQL
        // drain, including callers that enqueue their next write from .then().
        // Never yield while a transaction or its committed hook is running.
        completedInSlice++;
        if (completedInSlice >= 8 || performance.now() - sliceStarted >= 8) {
          totals.yields++;
          await yieldToIO();
          completedInSlice = 0;
          sliceStarted = performance.now();
        }
      }
    } finally {
      active = false;
    }
  }
  function transaction(callback, options = {}) {
    const weight = options.bytes ?? 0;
    if (
      closed ||
      !Number.isSafeInteger(weight) ||
      weight < 0 ||
      weight > maxBytes ||
      queue.length >= maxPending ||
      bytes + weight > maxBytes
    ) {
      totals.refused++;
      return Promise.reject(unavailable());
    }
    return new Promise((resolve, reject) => {
      queue.push({
        callback,
        options,
        bytes: weight,
        deadline: performance.now() + timeoutMs,
        resolve,
        reject,
      });
      bytes += weight;
      totals.admitted++;
      totals.peakPending = Math.max(totals.peakPending, queue.length);
      void pump();
    });
  }
  return {
    transaction,
    close: () => {
      closed = true;
    },
    stats: () => ({ ...totals, pending: queue.length, bytes }),
  };
}
module.exports = { createAsyncWriteLock };
