const { performance } = require('node:perf_hooks');
const { fail } = require('../../shared/errors.cjs');
// These reservations estimate transient work. They neither cap RSS nor replace
// the process/container ceilings; one FIFO shares capacity across both owners.
function createNativeMemoryWorkBudget({
  version,
  maxBytes,
  queryBytes,
  queryProbeBytes = null,
  commandBytes,
  maxPending = 32,
  waitMs = 5000,
  estimatedWorkingSet,
  rssHardCapClaim,
  now = () => performance.now(),
} = {}) {
  if (
    version !== 1 ||
    estimatedWorkingSet !== true ||
    rssHardCapClaim !== false ||
    ![maxBytes, queryBytes, commandBytes].every((v) => Number.isSafeInteger(v) && v > 0) ||
    maxBytes > 4 * 1024 ** 3 ||
    queryBytes > maxBytes ||
    commandBytes > maxBytes ||
    (queryProbeBytes !== null &&
      (!Number.isSafeInteger(queryProbeBytes) ||
        queryProbeBytes < 1 ||
        queryProbeBytes > queryBytes)) ||
    !Number.isInteger(maxPending) ||
    maxPending < 1 ||
    maxPending > 256 ||
    !Number.isInteger(waitMs) ||
    waitMs < 1 ||
    waitMs > 5000 ||
    typeof now !== 'function'
  )
    throw Error('Invalid native memory work budget.');
  const queue = [],
    active = new Set(),
    weights = {
      query: queryBytes,
      command: commandBytes,
      'command-exclusive': maxBytes,
      ...(queryProbeBytes === null ? {} : { 'query-probe': queryProbeBytes }),
    };
  let usedBytes = 0,
    peakBytes = 0,
    pendingBytes = 0,
    closed = false;
  const totals = { admitted: 0, released: 0, refused: 0, timedOut: 0, cancelled: 0 };
  function error(code) {
    return Object.assign(
      fail(code === 'NATIVE_CANCELLED' ? 499 : 503, 'Сервер временно занят. Повторите запрос.'),
      { code, outcomeUnknown: false, retryAfter: 1 },
    );
  }
  function cleanup(entry) {
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.cancel);
  }
  function remove(entry, code) {
    const index = queue.indexOf(entry);
    if (index < 0) return;
    queue.splice(index, 1);
    pendingBytes -= entry.bytes;
    cleanup(entry);
    totals[
      code === 'NATIVE_CANCELLED'
        ? 'cancelled'
        : code === 'NATIVE_MEMORY_WORK_TIMEOUT'
          ? 'timedOut'
          : 'refused'
    ]++;
    entry.reject(error(code));
  }
  function pump() {
    while (!closed && queue.length) {
      const entry = queue[0];
      if (entry.signal?.aborted) {
        remove(entry, 'NATIVE_CANCELLED');
        continue;
      }
      if (now() >= entry.deadline) {
        remove(entry, 'NATIVE_MEMORY_WORK_TIMEOUT');
        continue;
      }
      // A smaller follower cannot pass a waiting command at the head.
      if (usedBytes + entry.bytes > maxBytes) return;
      queue.shift();
      pendingBytes -= entry.bytes;
      cleanup(entry);
      usedBytes += entry.bytes;
      peakBytes = Math.max(peakBytes, usedBytes);
      totals.admitted++;
      active.add(entry);
      entry.resolve(
        Object.freeze({
          reduceTo(bytes) {
            if (!active.has(entry)) return;
            if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > entry.bytes)
              throw Error('Invalid native retained work bytes.');
            usedBytes -= entry.bytes - bytes;
            entry.bytes = bytes;
            pump();
          },
          release() {
            if (!active.delete(entry)) return;
            usedBytes -= entry.bytes;
            totals.released++;
            pump();
          },
        }),
      );
    }
  }
  function acquire(kind, { signal, timeoutMs = waitMs } = {}) {
    if (
      !Object.hasOwn(weights, kind) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 120000
    )
      return Promise.reject(Error('Invalid native memory work admission.'));
    if (signal?.aborted) {
      totals.cancelled++;
      return Promise.reject(error('NATIVE_CANCELLED'));
    }
    if (closed || queue.length >= maxPending) {
      totals.refused++;
      return Promise.reject(
        error(closed ? 'NATIVE_MEMORY_WORK_CLOSED' : 'NATIVE_MEMORY_WORK_CAPACITY'),
      );
    }
    return new Promise((resolve, reject) => {
      const duration = Math.min(waitMs, timeoutMs);
      const entry = { bytes: weights[kind], signal, resolve, reject, deadline: now() + duration };
      entry.cancel = () => {
        remove(entry, 'NATIVE_CANCELLED');
        pump();
      };
      entry.timer = setTimeout(() => {
        remove(entry, 'NATIVE_MEMORY_WORK_TIMEOUT');
        pump();
      }, duration);
      entry.timer.unref?.();
      signal?.addEventListener('abort', entry.cancel, { once: true });
      queue.push(entry);
      pendingBytes += entry.bytes;
      pump();
    });
  }
  return {
    acquire,
    supports: (kind) => Object.hasOwn(weights, kind),
    get waitMs() {
      return waitMs;
    },
    close() {
      closed = true;
      for (const entry of [...queue]) remove(entry, 'NATIVE_MEMORY_WORK_CLOSED');
      // Active leases belong to actual work/replies, never to shutdown timing.
    },
    stats: () => ({
      maxBytes,
      usedBytes,
      peakBytes,
      active: active.size,
      pending: queue.length,
      pendingBytes,
      ...totals,
      closed,
      estimatedWorkingSet: true,
      rssHardCapClaim: false,
    }),
  };
}
module.exports = { createNativeMemoryWorkBudget };
