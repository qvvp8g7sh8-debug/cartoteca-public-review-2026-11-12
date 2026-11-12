const { performance } = require('node:perf_hooks');
const { setImmediate, clearImmediate } = require('node:timers');
const { fail } = require('../../shared/errors.cjs');

const priorities = ['interactive', 'normal', 'background'];
const turns = [
  'interactive',
  'interactive',
  'interactive',
  'interactive',
  'normal',
  'normal',
  'background',
];
const unscoped = Object.freeze({});
const admissionErrors = new WeakSet();
function unavailable(reason) {
  const error = fail(503, 'Сервер временно занят. Повторите запрос.');
  error.retryAfter = 1;
  error.code = 'REQUEST_ADMISSION_' + reason;
  admissionErrors.add(error);
  return error;
}
function isRequestAdmissionDeferral(error) {
  return (
    admissionErrors.has(error) &&
    error.status === 503 &&
    error.outcomeUnknown !== true &&
    !error.channelPoisoned
  );
}
function lane() {
  const scopes = new Map(),
    order = [];
  let pending = 0;
  return {
    get pending() {
      return pending;
    },
    push(item) {
      let queue = scopes.get(item.scopeKey);
      if (!queue) {
        queue = [];
        scopes.set(item.scopeKey, queue);
        order.push(item.scopeKey);
      }
      queue.push(item);
      pending++;
    },
    shift() {
      const scopeKey = order.shift(),
        queue = scopes.get(scopeKey),
        item = queue.shift();
      if (queue.length) order.push(scopeKey);
      else scopes.delete(scopeKey);
      pending--;
      return item;
    },
  };
}

// Bound synchronous starts, never their asynchronous lifetimes. Trusted scope
// keys are supplied only after authentication; headers are not scheduling rights.
function createRequestDispatcher({
  maxPending = 256,
  maxPendingPerScope = Math.min(32, maxPending),
  // Tiny custom queues retain their original admission capacity. Production's
  // default queues reserve half the pending slots for interactive operations.
  interactiveReserve = maxPending < 8 ? 0 : Math.floor(maxPending / 2),
  scopeInteractiveReserve = maxPendingPerScope < 8 ? 0 : Math.floor(maxPendingPerScope / 2),
  // Background may not occupy the whole non-interactive queue: every HTTP
  // request first needs normal admission before its authenticated priority.
  maxBackgroundPending = maxPending < 8
    ? maxPending - interactiveReserve
    : Math.max(1, Math.floor((maxPending - interactiveReserve) / 2)),
  maxBackgroundPendingPerScope = maxPendingPerScope < 8
    ? maxPendingPerScope - scopeInteractiveReserve
    : Math.max(1, Math.floor((maxPendingPerScope - scopeInteractiveReserve) / 2)),
  timeoutMs = 5000,
  now = () => performance.now(),
  schedule = setImmediate,
  cancelScheduled = clearImmediate,
} = {}) {
  if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 4096)
    throw Error('Invalid request admission limit');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw Error('Invalid request admission timeout');
  for (const [value, limit] of [
    [maxPendingPerScope, maxPending],
    [interactiveReserve, maxPending - 1],
    [scopeInteractiveReserve, maxPendingPerScope - 1],
    [maxBackgroundPending, maxPending - interactiveReserve],
    [maxBackgroundPendingPerScope, maxPendingPerScope - scopeInteractiveReserve],
  ])
    if (!Number.isSafeInteger(value) || value < 0 || value > limit)
      throw Error('Invalid scoped request admission limit');
  if (!maxPendingPerScope) throw Error('Invalid scoped request admission limit');
  const lanes = Object.fromEntries(priorities.map((key) => [key, lane()])),
    scopes = new Map();
  const perPriority = Object.fromEntries(
    priorities.map((key) => [key, { admitted: 0, started: 0, refused: 0 }]),
  );
  let scheduled = null,
    closed = false,
    pending = 0,
    nonInteractive = 0,
    background = 0,
    turn = 0,
    scopeRefused = 0;
  const totals = {
    admitted: 0,
    started: 0,
    refused: 0,
    cancelled: 0,
    timedOut: 0,
    peakPending: 0,
    yields: 0,
  };
  function ensureScheduled() {
    if (scheduled !== null || closed || !pending) return;
    scheduled = schedule(drain);
  }
  function take() {
    let priority;
    for (let i = 0; i < turns.length; i++) {
      priority = turns[turn];
      turn = (turn + 1) % turns.length;
      if (lanes[priority].pending) break;
    }
    const item = lanes[priority].shift();
    pending--;
    if (priority !== 'interactive') nonInteractive--;
    if (priority === 'background') background--;
    if (item.scopeKey !== unscoped) {
      const scope = scopes.get(item.scopeKey);
      scope.pending--;
      if (priority !== 'interactive') scope.nonInteractive--;
      if (priority === 'background') scope.background--;
      if (!scope.pending) scopes.delete(item.scopeKey);
    }
    return item;
  }
  function drain() {
    scheduled = null;
    const sliceStarted = now();
    let processed = 0;
    while (!closed && pending) {
      const item = take();
      try {
        if (item.cancelled?.()) {
          totals.cancelled++;
          throw fail(499, 'Запрос отменён.');
        }
        if (now() >= item.deadline) {
          totals.timedOut++;
          throw unavailable('EXPIRED');
        }
        totals.started++;
        perPriority[item.priority].started++;
        // A promise, provider wait or queued SQL does not retain a permit.
        // Native synchronous work cannot be preempted; only its next unit yields.
        item.resolve(item.callback());
      } catch (error) {
        item.reject(error);
      }
      processed++;
      if (processed >= 8 || now() - sliceStarted >= 8) break;
    }
    if (!closed && pending) {
      totals.yields++;
      ensureScheduled();
    }
  }
  function run(callback, { cancelled, priority = 'normal', scopeKey = null } = {}) {
    if (typeof callback !== 'function')
      return Promise.reject(TypeError('Expected request callback'));
    if (
      !priorities.includes(priority) ||
      (scopeKey !== null && (typeof scopeKey !== 'string' || !scopeKey || scopeKey.length > 256))
    )
      return Promise.reject(TypeError('Invalid request scheduling scope'));
    const key = scopeKey === null ? unscoped : scopeKey;
    const scope = scopes.get(key);
    const scopedFull =
      key !== unscoped &&
      ((scope?.pending || 0) >= maxPendingPerScope ||
        (priority !== 'interactive' &&
          (scope?.nonInteractive || 0) >= maxPendingPerScope - scopeInteractiveReserve) ||
        (priority === 'background' && (scope?.background || 0) >= maxBackgroundPendingPerScope));
    if (
      closed ||
      pending >= maxPending ||
      scopedFull ||
      (priority !== 'interactive' && nonInteractive >= maxPending - interactiveReserve) ||
      (priority === 'background' && background >= maxBackgroundPending)
    ) {
      totals.refused++;
      perPriority[priority].refused++;
      if (scopedFull) scopeRefused++;
      return Promise.reject(unavailable(closed ? 'CLOSED' : 'CAPACITY'));
    }
    return new Promise((resolve, reject) => {
      lanes[priority].push({
        callback,
        cancelled,
        priority,
        scopeKey: key,
        deadline: now() + timeoutMs,
        resolve,
        reject,
      });
      pending++;
      if (priority !== 'interactive') nonInteractive++;
      if (priority === 'background') background++;
      if (key !== unscoped) {
        const held = scope || { pending: 0, nonInteractive: 0, background: 0 };
        held.pending++;
        if (priority !== 'interactive') held.nonInteractive++;
        if (priority === 'background') held.background++;
        scopes.set(key, held);
      }
      totals.admitted++;
      perPriority[priority].admitted++;
      totals.peakPending = Math.max(totals.peakPending, pending);
      ensureScheduled();
    });
  }
  function close() {
    if (closed) return;
    closed = true;
    if (scheduled !== null) cancelScheduled(scheduled);
    scheduled = null;
    while (pending) take().reject(unavailable('CLOSED'));
  }
  return {
    run,
    close,
    stats: () => ({ ...totals, pending, closed }),
    workStats: () => ({
      priorities: Object.fromEntries(
        priorities.map((key) => [key, { ...perPriority[key], pending: lanes[key].pending }]),
      ),
      scopes: scopes.size,
      scopeRefused,
      maxPending,
      maxPendingPerScope,
      interactiveReserve,
      scopeInteractiveReserve,
      maxBackgroundPending,
      maxBackgroundPendingPerScope,
    }),
  };
}

module.exports = { createRequestDispatcher, isRequestAdmissionDeferral };
