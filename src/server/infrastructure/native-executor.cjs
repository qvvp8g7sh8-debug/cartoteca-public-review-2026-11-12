const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { fail } = require('../../shared/errors.cjs');
const { createReadWorkUpgrade } = require('./native-read-admission145.cjs');
const {
  createMemoryMailbox,
  readMemorySample,
  normalizeNativeMemoryReport,
} = require('./native-memory-observation.cjs');
const { ArrayBuffer, SharedArrayBuffer, Int32Array, Atomics, structuredClone, AbortController } =
  globalThis;
const MiB = 1024 * 1024;
const SMALL_REPLY166 = 64 * 1024;
const diagnosticRoutes = [
  'bootstrap',
  'directory',
  'patient',
  'calendar',
  'operation',
  'timeZone',
  'schedules',
  'workspace',
  'availability',
  'serviceGroups',
];
const routeCounters = [
  'count',
  'errors',
  'rpcCalls',
  'operationSqlCalls',
  'authMs',
  'projectionMs',
  'serializeMs',
  'totalMs',
];
const poolCounters = [
  'hits',
  'misses',
  'opens',
  'openErrors',
  'evictions',
  'closes',
  'closeErrors',
  'openMs',
  'closeMs',
  'connections',
];
function queryDiagnostics(value) {
  const exact = (row, keys) =>
    row &&
    typeof row === 'object' &&
    !Array.isArray(row) &&
    Object.keys(row).length === keys.length &&
    keys.every((key) => Object.hasOwn(row, key));
  const counters = (row, keys, integerKeys) =>
    exact(row, keys) &&
    keys.every(
      (key) =>
        Number.isFinite(row[key]) &&
        row[key] >= 0 &&
        row[key] <= Number.MAX_SAFE_INTEGER &&
        (!integerKeys.includes(key) || Number.isSafeInteger(row[key])),
    );
  const viewKeys = ['hits', 'misses', 'invalidated', 'rejected', 'entries'];
  const sqlKeys = ['hits', 'misses', 'rejected', 'entries'];
  const withDirectory = value?.version === 3;
  const withViews = value?.version === 2 || withDirectory;
  const withSnapshots180 =
    withDirectory && Object.hasOwn(value.readViews || {}, 'directorySnapshots180');
  const withDirectory196 = withSnapshots180 && Object.hasOwn(value.readViews || {}, 'directory196');
  const directoryKeys196 = [
    'hits',
    'misses',
    'peeks',
    'patches',
    'bootstraps',
    'fallback',
    'entries',
  ];
  const snapshotKeys180 = [
    'hits',
    'misses',
    'rejected',
    'expired',
    'evicted',
    'entries',
    'rows',
    'maxEntries',
    'maxRows',
  ];
  const validSnapshots180 = (row) =>
    counters(row, snapshotKeys180, snapshotKeys180) &&
    row.maxEntries >= 1 &&
    row.maxEntries <= 128 &&
    row.maxRows >= 1 &&
    row.maxRows <= 150000 &&
    row.entries <= row.maxEntries &&
    row.rows <= row.maxRows &&
    (row.entries !== 0 || row.rows === 0);
  if (
    !exact(
      value,
      withViews ? ['version', 'routes', 'pool', 'readViews'] : ['version', 'routes', 'pool'],
    ) ||
    ![1, 2, 3].includes(value.version) ||
    (withViews &&
      (!exact(value.readViews, [
        ...viewKeys,
        'sqlResults',
        ...(withDirectory ? ['directoryResponses165'] : []),
        ...(withSnapshots180 ? ['directorySnapshots180'] : []),
        ...(withDirectory196 ? ['directory196'] : []),
      ]) ||
        !counters(
          Object.fromEntries(viewKeys.map((key) => [key, value.readViews[key]])),
          viewKeys,
          viewKeys,
        ) ||
        !counters(value.readViews.sqlResults, sqlKeys, sqlKeys) ||
        (withDirectory && !counters(value.readViews.directoryResponses165, viewKeys, viewKeys)) ||
        (withSnapshots180 && !validSnapshots180(value.readViews.directorySnapshots180)) ||
        (withDirectory196 &&
          !counters(value.readViews.directory196, directoryKeys196, directoryKeys196)))) ||
    !exact(value.routes, diagnosticRoutes) ||
    !diagnosticRoutes.every((key) =>
      counters(value.routes[key], routeCounters, [
        'count',
        'errors',
        'rpcCalls',
        'operationSqlCalls',
      ]),
    ) ||
    !counters(
      value.pool,
      poolCounters,
      poolCounters.filter((key) => !['openMs', 'closeMs'].includes(key)),
    ) ||
    Buffer.byteLength(JSON.stringify(value)) > 8192
  )
    return null;
  return structuredClone(value);
}
function small(value, budget = { bytes: 0, count: 0 }, depth = 0) {
  if (++budget.count > 256 || depth > 6) throw TypeError('Invalid native executor metadata');
  if (value == null || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value === 'string') budget.bytes += Buffer.byteLength(value);
  else if (Array.isArray(value) && value.length <= 64)
    value.forEach((x) => small(x, budget, depth + 1));
  else if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value);
    if (keys.length > 64) throw TypeError('Invalid native executor metadata');
    for (const key of keys) {
      budget.bytes += Buffer.byteLength(key);
      small(value[key], budget, depth + 1);
    }
  } else throw TypeError('Invalid native executor metadata');
  if (budget.bytes > 32768) throw TypeError('Invalid native executor metadata');
}
function rejected(code, unknown = false) {
  return Object.assign(
    fail(code === 'NATIVE_CANCELLED' ? 499 : 503, 'Сервер временно занят. Повторите запрос.'),
    {
      code,
      retryAfter: 1,
      outcomeUnknown: unknown,
    },
  );
}
function createNativeExecutor({
  filename,
  workerData = {},
  memoryProcess = null,
  workBudget = null,
  boundedRead = null,
  strictAffinity = false,
  concurrency = 1,
  maxPending = 32,
  maxPendingBytes = 64 * MiB,
  maxRequestBytes = 50 * MiB,
  maxResponseBytes = 64 * MiB,
  maxRetainedBytes = 128 * MiB,
  timeoutMs = 20000,
  startupMs = 15000,
  cancelGraceMs = 0,
  resourceLimits = {
    maxOldGenerationSizeMb: 256,
    maxYoungGenerationSizeMb: 32,
    stackSizeMb: 4,
  },
  workerFactory = (file, options) => new Worker(file, options),
  now = () => performance.now(),
} = {}) {
  if (boundedRead !== null && typeof boundedRead !== 'function')
    throw Error('Invalid bounded read classifier.');
  if (typeof strictAffinity !== 'boolean') throw Error('Invalid native affinity policy.');
  if (
    typeof filename !== 'string' ||
    !path.isAbsolute(filename) ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 6 ||
    !Number.isInteger(maxPending) ||
    maxPending < 1 ||
    maxPending > 256 ||
    ![maxPendingBytes, maxRequestBytes, maxResponseBytes, maxRetainedBytes].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    maxRequestBytes > maxPendingBytes ||
    maxResponseBytes > maxRetainedBytes ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000 ||
    !Number.isSafeInteger(startupMs) ||
    startupMs < 1 ||
    startupMs > 60000 ||
    !Number.isSafeInteger(cancelGraceMs) ||
    cancelGraceMs < 0 ||
    cancelGraceMs > 250
  )
    throw Error('Invalid native executor configuration');
  if (
    workBudget !== null &&
    (typeof workBudget.acquire !== 'function' ||
      !Number.isSafeInteger(workBudget.waitMs) ||
      workBudget.waitMs < 1 ||
      workBudget.waitMs > 5000)
  )
    throw Error('Invalid native work admission.');
  // The initial warm pool also consumes this rolling start-attempt budget.
  // Existing pools keep four attempts; the explicit larger pool can start once.
  const restartAttemptLimit = Math.max(4, concurrency);
  small(workerData);
  workerData = structuredClone(workerData);
  const readyWaiters = new Set();
  const queue = [],
    workers = new Set(),
    exits = new Set(),
    replyWaiters166 = [];
  let sequence = 0,
    nextOwner184 = 0,
    closed = false,
    inputBytes = 0,
    retainedBytes = 0,
    reservedBytes = 0,
    restarting = [],
    warmRequested = false,
    recoveryTimer = null,
    recoveryAt = 0;
  const totals = {
    admitted: 0,
    started: 0,
    completed: 0,
    refused: 0,
    cancelled: 0,
    timedOut: 0,
    failures: 0,
    spawned: 0,
    workerExits: 0,
    queryProbeStarted: 0,
    queryUpgradeRequested: 0,
    queryUpgradeGranted: 0,
    queryUpgradeRefused: 0,
  };
  const upgradeReadWork = createReadWorkUpgrade({
    workBudget,
    now,
    interrupted,
    cancel,
    stopWorker,
    record: (name) => totals[name]++,
    getItem: (slot, message) => slot.items.get(message.id),
    ownsItem: (slot, item) => slot.items.get(item.id) === item,
    beforeUpgrade: beforeReadUpgrade166,
  });
  const watcher = setInterval(() => {
    for (const item of [...queue]) if (interrupted(item)) cancel(item);
    for (const slot of workers)
      for (const item of [...slot.items.values()]) if (interrupted(item)) cancel(item);
    pump();
  }, 25);
  watcher.unref?.();
  function interrupted(item) {
    if (item.cancelError) return true;
    try {
      if (item.signal?.aborted || item.cancelled?.())
        item.cancelError = rejected('NATIVE_CANCELLED', item.mutating && item.started);
    } catch {
      item.cancelError = rejected('NATIVE_CANCELLED', item.mutating && item.started);
    }
    if (!item.cancelError && now() >= item.deadline)
      item.cancelError = rejected('NATIVE_TIMEOUT', item.mutating && item.started);
    if (!item.cancelError && !item.started && workBudget && now() >= item.workDeadline)
      item.cancelError = rejected('NATIVE_MEMORY_WORK_TIMEOUT');
    return Boolean(item.cancelError);
  }
  function clean(item) {
    item.signal?.removeEventListener('abort', item.onAbort);
    inputBytes -= item.bytes;
    item.payload = null;
  }
  function releaseWork(item) {
    if (!item.workDone || !item.workLease) return;
    if (item.replyReleased) {
      item.workLease.release();
      item.workLease = null;
    } else if (Number.isSafeInteger(item.replyBytes)) {
      item.workLease.reduceTo?.(item.replyBytes);
    }
  }
  function releaseUnstartedWork(item) {
    item.workAbort?.abort();
    item.workDone = item.replyReleased = true;
    releaseWork(item);
  }
  function settledWork(item, slot) {
    if (slot.stopping && !slot.exited) slot.workUntilExit.add(item);
    else item.workDone = true;
    releaseWork(item);
  }
  function deferWork(item) {
    const abort = item.workAbort;
    item.workAbort = null;
    item.workPending = false;
    abort?.abort();
    item.workLease?.release();
    item.workLease = null;
  }
  function acquireWork(item) {
    const abort = new AbortController();
    item.workAbort = abort;
    item.workPending = true;
    workBudget
      .acquire(item.workKind, {
        signal: abort.signal,
        timeoutMs: Math.max(1, Math.ceil(Math.min(item.deadline, item.workDeadline) - now())),
      })
      .then(
        (lease) => {
          if (item.workAbort !== abort) return lease.release();
          item.workLease = lease;
          item.workPending = false;
          if (!queue.includes(item)) {
            item.workDone = item.replyReleased = true;
            releaseWork(item);
          } else pump();
        },
        (error) => {
          if (item.workAbort !== abort) return;
          item.workPending = false;
          const index = queue.indexOf(item);
          if (index < 0) return;
          queue.splice(index, 1);
          clean(item);
          item.workDone = item.replyReleased = true;
          releaseWork(item);
          totals.refused++;
          item.reject(error);
          pump();
        },
      );
  }
  function queryProtocol166(slot, item) {
    return Boolean(slot.queryFeatures166 && item.kind === 'query' && !item.mutating);
  }
  function canStart166(slot, item) {
    if (!slot.ready || slot.stopping || slot.exited) return false;
    if (!slot.items.size) return true;
    return (
      queryProtocol166(slot, item) &&
      item.workKind === 'query-probe' &&
      !slot.exclusivePending166 &&
      slot.items.size < slot.queryFeatures166.capacity &&
      [...slot.items.values()].every(
        (active) => queryProtocol166(slot, active) && active.workKind === 'query-probe',
      )
    );
  }
  function beforeReadUpgrade166(slot, item, begin) {
    if (!queryProtocol166(slot, item)) return true;
    // The aggregate budget is not an isolate memory proof. This physical worker
    // can own two bounded probes OR one heavy read, never both at once.
    if (slot.exclusivePending166 && slot.exclusivePending166 !== item) {
      const pending = slot.exclusivePending166;
      // Both still own bounded probes. Prefer the older job even when its
      // sibling's request frame reached the parent first; never replay either.
      if (pending.id < item.id) {
        refuseProbeUpgrade166(slot, item);
        return false;
      }
      refuseProbeUpgrade166(slot, pending);
      if (slot.stopping) return false;
    }
    slot.exclusivePending166 = item;
    if (slot.items.size === 1) return true;
    item.resumeUpgrade166 = begin;
    return false;
  }
  function refuseProbeUpgrade166(slot, item) {
    item.resumeUpgrade166 = null;
    item.upgradePending = false;
    totals.queryUpgradeRefused++;
    try {
      slot.worker.postMessage({
        id: item.id,
        memoryError: { code: 'NATIVE_MEMORY_WORK_CAPACITY' },
      });
    } catch {
      stopWorker(slot);
    }
  }
  function resumeReadUpgrade166(slot) {
    const item = slot.exclusivePending166;
    if (
      !item ||
      slot.items.size !== 1 ||
      slot.items.get(item.id) !== item ||
      !item.resumeUpgrade166 ||
      slot.stopping ||
      slot.exited
    )
      return;
    const begin = item.resumeUpgrade166;
    item.resumeUpgrade166 = null;
    begin();
  }
  function initialReply166(slot, item) {
    return queryProtocol166(slot, item)
      ? Math.min(SMALL_REPLY166, maxResponseBytes)
      : maxResponseBytes;
  }
  function removeReplyWait166(item) {
    const at = replyWaiters166.indexOf(item);
    if (at >= 0) replyWaiters166.splice(at, 1);
    item.replyPending166 = false;
  }
  function pumpReplies166() {
    // Settled workers retain their actual body under the unchanged work lease.
    // Give existing reply upgrades priority over new speculative small credits.
    while (replyWaiters166.length) {
      const item = replyWaiters166[0],
        slot = item.slot;
      if (!slot || slot.stopping || slot.exited || slot.items.get(item.id) !== item) {
        removeReplyWait166(item);
        continue;
      }
      if (interrupted(item)) {
        removeReplyWait166(item);
        cancel(item);
        continue;
      }
      const extra = item.replyRequested166 - item.replyCredit166;
      if (retainedBytes + reservedBytes + extra > maxRetainedBytes) return;
      replyWaiters166.shift();
      item.replyPending166 = false;
      reservedBytes += extra;
      item.replyCredit166 = item.replyRequested166;
      try {
        slot.worker.postMessage({
          id: item.id,
          replyGranted166: item.replyCredit166,
        });
      } catch {
        stopWorker(slot);
      }
    }
  }
  function requestReply166(slot, item, message) {
    if (
      !queryProtocol166(slot, item) ||
      item.upgradePending ||
      item.replyPending166 ||
      item.replyRequested166 !== undefined ||
      Object.keys(message).length !== 2 ||
      !Number.isSafeInteger(message.replyBytes166) ||
      message.replyBytes166 <= item.replyCredit166 ||
      message.replyBytes166 > maxResponseBytes
    )
      return stopWorker(slot);
    if (interrupted(item)) return cancel(item);
    item.replyRequested166 = message.replyBytes166;
    item.replyPending166 = true;
    replyWaiters166.push(item);
    pumpReplies166();
  }
  function cancel(item) {
    if (!item.countedCancel) {
      totals[
        item.cancelError?.code === 'NATIVE_MEMORY_WORK_TIMEOUT'
          ? 'refused'
          : item.cancelError?.code === 'NATIVE_TIMEOUT'
            ? 'timedOut'
            : 'cancelled'
      ]++;
      item.countedCancel = true;
    }
    Atomics.store(item.cancel, 0, 1);
    if (!item.started) {
      const index = queue.indexOf(item);
      if (index < 0) return;
      queue.splice(index, 1);
      clean(item);
      releaseUnstartedWork(item);
      item.reject(item.cancelError);
    } else if (!item.mutating) {
      const slot = item.slot;
      if (slot.stopping || slot.exited) return;
      if (queryProtocol166(slot, item) && !item.cancelSignalled166) {
        item.cancelSignalled166 = true;
        item.upgradeAbort?.abort();
        removeReplyWait166(item);
        try {
          slot.worker.postMessage({ id: item.id, cancel166: true });
        } catch {
          return stopWorker(slot);
        }
      }
      if (
        closed ||
        !cancelGraceMs ||
        item.cancelError?.code === 'NATIVE_TIMEOUT' ||
        now() >= item.deadline
      )
        stopWorker(slot);
      else if (!item.cancelTimer) {
        // Never release a still-owned physical job just because its HTTP died.
        item.cancelTimer = setTimeout(
          () => {
            item.cancelTimer = null;
            if (slot.items.get(item.id) === item) stopWorker(slot);
          },
          Math.min(cancelGraceMs, Math.max(0, item.deadline - now())),
        );
        item.cancelTimer.unref?.();
      }
    }
    // Legacy mutations keep their single owner and unknown-write settlement.
  }
  function clearCancellation(slot, selected) {
    for (const item of selected ? [selected] : slot.items.values()) {
      clearTimeout(item.cancelTimer);
      item.cancelTimer = null;
    }
  }
  function stopWorker(slot) {
    clearCancellation(slot);
    if (slot.stopping || slot.exited) return;
    slot.stopping = true;
    slot.ready = false;
    for (const item of slot.items.values()) {
      item.upgradeAbort?.abort();
      item.resumeUpgrade166 = null;
      removeReplyWait166(item);
    }
    if (queue[0] && ![...workers].some((entry) => canStart166(entry, queue[0])))
      deferWork(queue[0]);
    try {
      void slot.worker.terminate().catch(() => {});
    } catch {}
  }
  function finish(slot, error, result, selected) {
    const item = selected || slot.items.values().next().value;
    if (!item || slot.items.get(item.id) !== item) return;
    item.upgradeAbort?.abort();
    removeReplyWait166(item);
    clearCancellation(slot, item);
    slot.items.delete(item.id);
    item.resumeUpgrade166 = null;
    if (slot.exclusivePending166 === item) slot.exclusivePending166 = null;
    reservedBytes -= item.replyCredit166;
    if (item.cancelError || error?.status === 499) {
      slot.cancelled166.add(item.id);
      if (slot.cancelled166.size > 128)
        slot.cancelled166.delete(slot.cancelled166.values().next().value);
    }
    clean(item);
    if (item.cancelError) error = item.cancelError;
    item.replyReleased = Boolean(error);
    item.replyBytes = error ? 0 : result.body.byteLength;
    settledWork(item, slot);
    if (error) {
      totals.failures++;
      item.reject(error);
    } else {
      const bytes = result.body.byteLength;
      retainedBytes += bytes;
      let released = false;
      totals.completed++;
      item.resolve({
        ...result,
        body: Buffer.from(result.body),
        release() {
          if (released) return;
          released = true;
          retainedBytes -= bytes;
          item.replyReleased = true;
          releaseWork(item);
          pumpReplies166();
          pump();
        },
      });
    }
    pumpReplies166();
    resumeReadUpgrade166(slot);
    if (closed) stopWorker(slot);
    else if (!slot.settlingExit166) pump();
  }
  function memoryReport(slot) {
    if (!memoryProcess) return null;
    try {
      const main = readMemorySample(slot.memoryMailbox);
      if (!main) return null;
      return normalizeNativeMemoryReport(
        {
          pid: main.pid,
          main,
          database: readMemorySample(slot.databaseMailbox),
        },
        { allowWorkerMain: true },
      );
    } catch {
      // A malformed private diagnostic is unknown. READY still rejects it;
      // public stats must not throw or publish the untrusted sample.
      return null;
    }
  }
  function receive(slot, message) {
    if (slot.exited) return;
    if (!message || typeof message !== 'object') return stopWorker(slot);
    if (memoryProcess && message.startupFailed) {
      const error = rejected(
        message.code === 'NATIVE_MEMORY_BUDGET_MISMATCH' ? message.code : 'NATIVE_STARTUP_FAILED',
      );
      for (const waiter of readyWaiters) waiter.reject(error);
      readyWaiters.clear();
      return stopWorker(slot);
    }
    if (message.ready === true && !slot.ready && !slot.items.size && !slot.stopping) {
      if (memoryProcess) {
        const report = memoryReport(slot);
        if (
          message.memoryBudget?.identity !== memoryProcess.identity ||
          message.memoryBudget?.version !== 1 ||
          report?.main.heapSizeLimitBytes !== memoryProcess.heapCeilingMiB * MiB ||
          message.memoryBudget.heapSizeLimitBytes !== report.main.heapSizeLimitBytes ||
          (workerData.config?.storageBackend === 'postgres' &&
            report.database?.heapSizeLimitBytes !== report.main.heapSizeLimitBytes)
        ) {
          for (const waiter of readyWaiters)
            waiter.reject(rejected('NATIVE_MEMORY_BUDGET_MISMATCH'));
          readyWaiters.clear();
          return stopWorker(slot);
        }
      }
      if (Object.hasOwn(message, 'queryFeatures166')) {
        const feature = message.queryFeatures166;
        if (
          !feature ||
          Object.keys(feature).length !== 3 ||
          feature.version !== 1 ||
          ![1, 2].includes(feature.capacity) ||
          feature.replyCredit !== true
        )
          return stopWorker(slot);
        slot.queryFeatures166 = { ...feature };
      }
      clearTimeout(slot.startTimer);
      slot.ready = true;
      if (
        workers.size === concurrency &&
        [...workers].every((entry) => entry.ready && !entry.stopping)
      ) {
        for (const waiter of readyWaiters) waiter.resolve();
        readyWaiters.clear();
      }
      pump();
      return;
    }
    const item = slot.items.get(message.id);
    if (!item) {
      if (slot.queryFeatures166 && slot.cancelled166.has(message.id)) return;
      return stopWorker(slot);
    }
    if (Object.hasOwn(message, 'replyBytes166')) return requestReply166(slot, item, message);
    if (Object.hasOwn(message, 'memoryClass')) {
      upgradeReadWork(slot, message);
      return;
    }
    if ((item.upgradePending || item.replyPending166) && !message.error) return stopWorker(slot);
    slot.queryDiagnostics = queryDiagnostics(message.queryDiagnostics);
    if (message.error) {
      const data = message.error,
        status =
          Number.isInteger(data.status) && data.status >= 400 && data.status < 500
            ? data.status
            : 503;
      const error = Object.assign(
        fail(
          status,
          status < 500 && typeof data.message === 'string'
            ? data.message.slice(0, 512)
            : 'Не удалось выполнить запрос.',
        ),
        {
          code:
            typeof data.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(data.code)
              ? data.code
              : 'NATIVE_EXECUTION_FAILED',
          outcomeUnknown: item.mutating,
        },
      );
      finish(slot, error, undefined, item);
      return;
    }
    const result = message.result;
    try {
      if (
        !result ||
        !Number.isInteger(result.status) ||
        result.status < 100 ||
        result.status > 599 ||
        !(result.body instanceof ArrayBuffer) ||
        result.body.byteLength > maxResponseBytes ||
        result.body.byteLength > item.replyCredit166
      )
        throw Error();
      small(result.headers || {});
      finish(
        slot,
        null,
        {
          status: result.status,
          headers: result.headers || {},
          body: result.body,
        },
        item,
      );
    } catch {
      stopWorker(slot);
    }
  }
  function scheduleRecovery(milliseconds) {
    if (closed) return;
    const delay = Math.max(1, Math.ceil(milliseconds));
    const at = now() + delay;
    if (recoveryTimer && recoveryAt <= at) return;
    clearTimeout(recoveryTimer);
    recoveryAt = at;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      recoveryAt = 0;
      pump();
    }, delay);
    recoveryTimer.unref?.();
  }
  function spawn() {
    if (recoveryTimer) return false;
    restarting = restarting.filter((at) => at > now() - 30000);
    if (restarting.length >= restartAttemptLimit) {
      // One owned timer resumes exactly when the oldest attempt leaves the
      // rolling budget. A quiet warm pool recovers without a new HTTP request.
      scheduleRecovery(restarting[0] + 30000 - now());
      return false;
    }
    restarting.push(now());
    let worker;
    const memoryMailbox = memoryProcess ? createMemoryMailbox() : null;
    const databaseMailbox = memoryProcess ? createMemoryMailbox() : null;
    try {
      worker = workerFactory(filename, {
        workerData: memoryProcess
          ? {
              ...workerData,
              nativeMemoryMailbox: memoryMailbox,
              nativeDatabaseMemoryMailbox: databaseMailbox,
            }
          : workerData,
        resourceLimits,
      });
    } catch {
      scheduleRecovery(100);
      return false;
    }
    const used = new Set([...workers].map((entry) => entry.index));
    let index = 0;
    while (used.has(index)) index++;
    const slot = {
      worker,
      index,
      memoryMailbox,
      databaseMailbox,
      ready: false,
      stopping: false,
      items: new Map(),
      cancelled166: new Set(),
      queryFeatures166: null,
      exited: false,
      workUntilExit: new Set(),
    };
    workers.add(slot);
    totals.spawned++;
    let resolveExit;
    const exit = new Promise((resolve) => {
      resolveExit = resolve;
    });
    exits.add(exit);
    slot.startTimer = setTimeout(() => {
      // Startup failure must surface even if native initialization cannot yet
      // acknowledge termination. Keep the physical slot until its actual exit.
      slot.startupError = rejected('NATIVE_STARTUP_TIMEOUT');
      for (const waiter of readyWaiters) waiter.reject(slot.startupError);
      readyWaiters.clear();
      stopWorker(slot);
    }, startupMs);
    slot.startTimer.unref?.();
    worker.on('message', (message) => receive(slot, message));
    worker.on('error', () => stopWorker(slot));
    worker.once('exit', () => {
      slot.exited = true;
      for (const item of slot.workUntilExit) {
        item.workDone = true;
        releaseWork(item);
      }
      slot.workUntilExit.clear();
      clearTimeout(slot.startTimer);
      clearCancellation(slot);
      workers.delete(slot);
      totals.workerExits++;
      if (!closed && (warmRequested || queue.length || readyWaiters.size)) scheduleRecovery(100);
      slot.settlingExit166 = true;
      for (const item of [...slot.items.values()])
        finish(slot, rejected('NATIVE_WORKER_EXIT', item.mutating), undefined, item);
      slot.settlingExit166 = false;
      exits.delete(exit);
      resolveExit();
      if (!closed) pump();
    });
    return true;
  }
  function ownedSelection184() {
    // The existing global queue remains bounded. Only its first job per owner
    // is eligible: a busy owner never makes unrelated owners wait behind it.
    const heads = new Map(),
      available = new Map();
    for (const item of queue) if (!heads.has(item.affinity)) heads.set(item.affinity, item);
    for (const [owner, item] of heads) {
      const slot = [...workers].find((entry) => entry.index === owner && canStart166(entry, item));
      if (slot) available.set(owner, { item, slot });
      // Never retain an unstarted lease or shared-FIFO waiter behind a busy or
      // missing physical owner. Existing cancellation/release logic owns it.
      else deferWork(item);
    }
    // There is still at most one outstanding unstarted work acquisition. Give
    // its lease/waiter priority; changing worker fairness never bypasses the
    // shared work-budget FIFO or queues speculative reservations for all owners.
    for (const item of queue)
      if (item.workLease || item.workPending) return available.get(item.affinity) || null;
    for (let offset = 0; offset < concurrency; offset++) {
      const selected = available.get((nextOwner184 + offset) % concurrency);
      if (selected) return selected;
    }
    return null;
  }
  function pump() {
    if (closed) return;
    while (workers.size < concurrency && (warmRequested || queue.length || readyWaiters.size))
      if (!spawn()) break;
    pumpReplies166();
    while (queue.length) {
      let item = queue[0],
        slot;
      if (strictAffinity) {
        const selected = ownedSelection184();
        if (!selected) break;
        ({ item, slot } = selected);
      }
      if (interrupted(item)) {
        cancel(item);
        continue;
      }
      if (!strictAffinity) {
        const available = [...workers].filter((entry) => canStart166(entry, item));
        if (available.length) {
          const load = Math.min(...available.map((entry) => entry.items.size));
          const balanced = available.filter((entry) => entry.items.size === load);
          slot = balanced.find((entry) => entry.index === item.affinity) || balanced[0];
        }
      }
      if (!slot || replyWaiters166.length) {
        deferWork(item);
        break;
      }
      const credit = initialReply166(slot, item);
      // Leave headroom for one maximal result to acquire its exact delta even
      // when every active query is waiting to upgrade an initial small credit.
      const headroom = queryProtocol166(slot, item) ? maxResponseBytes : credit;
      if (retainedBytes + reservedBytes + headroom > maxRetainedBytes) {
        deferWork(item);
        break;
      }
      // Shared FIFO/work weights are unchanged; a reply credit is not a memory grant.
      if (workBudget && !item.workLease) {
        if (!item.workPending) acquireWork(item);
        break;
      }
      if (strictAffinity) {
        const index = queue.indexOf(item);
        if (index < 0) {
          deferWork(item);
          continue;
        }
        queue.splice(index, 1);
      } else queue.shift();
      slot.items.set(item.id, item);
      item.slot = slot;
      item.started = true;
      item.replyCredit166 = credit;
      reservedBytes += credit;
      totals.started++;
      if (item.workKind === 'query-probe') totals.queryProbeStarted++;
      try {
        slot.worker.postMessage(
          {
            id: item.id,
            kind: item.kind,
            metadata: item.metadata,
            payload: item.payload,
            cancel: item.cancel.buffer,
            ...(item.workKind === 'query-probe' ? { memoryClass: 'query-probe' } : {}),
            ...(queryProtocol166(slot, item)
              ? { replyCredit166: credit, maxReplyBytes166: maxResponseBytes }
              : {}),
          },
          [item.payload],
        );
        item.payload = null;
        if (strictAffinity) nextOwner184 = (item.affinity + 1) % concurrency;
      } catch {
        stopWorker(slot);
      }
    }
    if (
      workers.size < concurrency &&
      restarting.length >= restartAttemptLimit &&
      readyWaiters.size
    ) {
      for (const waiter of readyWaiters) waiter.reject(rejected('NATIVE_START_CAPACITY'));
      readyWaiters.clear();
    }
    if (!workers.size && queue.length && restarting.length >= restartAttemptLimit) {
      for (const item of queue.splice(0)) {
        clean(item);
        releaseUnstartedWork(item);
        item.reject(rejected('NATIVE_START_CAPACITY'));
      }
    }
  }
  function run(
    { kind, metadata = {}, payload = new ArrayBuffer(0) } = {},
    { signal, cancelled, mutating = false, affinityKey = '' } = {},
  ) {
    try {
      if (
        typeof kind !== 'string' ||
        !/^[a-z][a-z0-9-]{0,31}$/.test(kind) ||
        typeof mutating !== 'boolean'
      )
        throw TypeError('Invalid native operation');
      small(metadata);
      if (typeof affinityKey !== 'string' || affinityKey.length > 512)
        throw TypeError('Invalid native routing hint');
      let affinity = 2166136261;
      for (let i = 0; i < affinityKey.length; i++)
        affinity = Math.imul(affinity ^ affinityKey.charCodeAt(i), 16777619) >>> 0;
      affinity = affinityKey ? affinity % concurrency : null;
      if (strictAffinity && (kind !== 'query' || mutating || affinity === null))
        throw TypeError('Owned native queries require a routing hint.');
      metadata = structuredClone(metadata);
      const bytes = Buffer.isBuffer(payload)
        ? payload.byteLength
        : payload instanceof ArrayBuffer
          ? payload.byteLength
          : -1;
      if (bytes < 0 || bytes > maxRequestBytes) throw rejected('NATIVE_REQUEST_CAPACITY');
      if (closed || queue.length >= maxPending || inputBytes + bytes > maxPendingBytes) {
        totals.refused++;
        throw rejected('NATIVE_REQUEST_CAPACITY');
      }
      // ArrayBuffer callers transfer ownership without copying. A possibly pooled
      // Buffer is copied once, so unrelated slab bytes can never be detached/sent.
      const owned = Buffer.isBuffer(payload)
        ? Uint8Array.from(payload).buffer
        : structuredClone(payload, { transfer: [payload] });
      return new Promise((resolve, reject) => {
        const item = {
          id: ++sequence,
          kind,
          metadata,
          payload: owned,
          bytes,
          signal,
          cancelled,
          mutating,
          workKind:
            !mutating &&
            kind === 'query' &&
            workBudget?.supports?.('query-probe') &&
            boundedRead?.(metadata) === true
              ? 'query-probe'
              : 'query',
          resolve,
          reject,
          affinity,
          started: false,
          cancel: new Int32Array(new SharedArrayBuffer(4)),
          deadline: now() + timeoutMs,
          workDeadline: workBudget ? now() + Math.min(timeoutMs, workBudget.waitMs) : null,
        };
        inputBytes += bytes;
        totals.admitted++;
        item.onAbort = () => {
          interrupted(item);
          cancel(item);
          pump();
        };
        queue.push(item);
        signal?.addEventListener('abort', item.onAbort, { once: true });
        if (interrupted(item)) cancel(item);
        pump();
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }
  async function close({ force = false } = {}) {
    closed = true;
    warmRequested = false;
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
    recoveryAt = 0;
    clearInterval(watcher);
    for (const waiter of readyWaiters) waiter.reject(rejected('NATIVE_CANCELLED'));
    readyWaiters.clear();
    for (const item of [...queue]) {
      item.cancelError = rejected('NATIVE_CANCELLED');
      cancel(item);
    }
    for (const slot of workers) {
      for (const item of slot.items.values()) {
        item.cancelError = rejected('NATIVE_CANCELLED', item.mutating);
        Atomics.store(item.cancel, 0, 1);
      }
      if (![...slot.items.values()].some((item) => item.mutating) || force) stopWorker(slot);
    }
    await Promise.all([...exits]);
  }
  function ready() {
    if (closed) return Promise.reject(rejected('NATIVE_CANCELLED'));
    warmRequested = true;
    const failed = [...workers].find((slot) => slot.startupError);
    if (failed) return Promise.reject(failed.startupError);
    if (workers.size === concurrency && [...workers].every((slot) => slot.ready && !slot.stopping))
      return Promise.resolve();
    return new Promise((resolve, reject) => {
      readyWaiters.add({ resolve, reject });
      pump();
    });
  }
  return {
    run,
    close,
    ready,
    stats: () => ({
      ...totals,
      pending: queue.length,
      active: [...workers].reduce((sum, slot) => sum + slot.items.size, 0),
      workers: workers.size,
      readyWorkers: [...workers].filter((slot) => slot.ready && !slot.stopping).length,
      queryDiagnostics: [...workers].map((slot) => ({
        index: slot.index,
        snapshot: slot.queryDiagnostics ? structuredClone(slot.queryDiagnostics) : null,
      })),
      ...(memoryProcess
        ? {
            memory: [...workers].map((slot) => ({
              index: slot.index,
              report: memoryReport(slot),
            })),
          }
        : {}),
      ...(workBudget ? { workPending: queue.filter((item) => item.workPending).length } : {}),
      inputBytes,
      retainedBytes,
      reservedBytes,
      closed,
      recovery: {
        warmRequested,
        scheduled: Boolean(recoveryTimer),
        retryInMs: recoveryTimer ? Math.max(0, Math.ceil(recoveryAt - now())) : 0,
      },
      limits: {
        concurrency,
        maxPending,
        maxPendingBytes,
        maxRequestBytes,
        maxResponseBytes,
        maxRetainedBytes,
        timeoutMs,
        cancelGraceMs,
      },
    }),
  };
}
module.exports = { createNativeExecutor };
