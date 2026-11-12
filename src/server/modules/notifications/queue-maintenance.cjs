const { performance } = require('node:perf_hooks');
const { setImmediate: yieldTurn } = require('node:timers/promises');
const { validate } = require('../../infrastructure/notification-maintenance-schema.cjs');
const { createQueueMaintenanceStore } = require('./queue-maintenance-store.cjs');
const { cleanBusy } = require('./queue-org134.cjs');
const { createNotificationDiagnostics } = require('./notification-diagnostics140.cjs');
function createQueueMaintenance(
  c,
  {
    enabled = false,
    clock = Date.now,
    monotonic = () => performance.now(),
    rowLimit = 128,
    sliceMs = 5,
    intervalMs = 1000,
  } = {},
) {
  if (typeof enabled !== 'boolean') throw Error('Invalid notification maintenance flag');
  validate(c.db, { required: enabled });
  if (
    !Number.isSafeInteger(rowLimit) ||
    rowLimit < 1 ||
    rowLimit > 128 ||
    !Number.isFinite(sliceMs) ||
    sliceMs <= 0 ||
    sliceMs > 5 ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 10
  )
    throw Error('Invalid notification maintenance budget');
  const store = enabled
    ? c.organizationQueueTransaction
      ? require('./organization-queue-maintenance134.cjs').createOrganizationQueueMaintenanceStore(
          c,
        )
      : createQueueMaintenanceStore(c)
    : null;
  const totals = {
    calls: 0,
    slices: 0,
    examined: 0,
    changed: 0,
    elapsedMs: 0,
    maxSliceMs: 0,
    lagMs: 0,
    maxLagMs: 0,
    lastRunAt: 0,
    recoveryCalls: 0,
    recoveryExamined: 0,
    recoveryChanged: 0,
    recoveryElapsedMs: 0,
    errors: 0,
    busyDeferrals: 0,
  };
  const diagnostics = createNotificationDiagnostics();
  let lastFailure = null;
  let cursor = 0,
    busy = null,
    timer = null,
    generation = 0,
    running = false;
  const allowed = (channel) => c.notificationChannels?.enabled(channel) !== false;
  function tick({ canRun = () => false, signal, runWork = (callback) => callback() } = {}) {
    if (!enabled || typeof canRun !== 'function')
      return Promise.resolve({ examined: 0, changed: 0 });
    if (typeof runWork !== 'function')
      return Promise.reject(TypeError('Invalid maintenance admission'));
    if (busy) return busy;
    const epoch = generation;
    const owned = () => epoch === generation && !signal?.aborted && canRun();
    let phaseState = 'tick',
      callbackEntered = false;
    busy = (async () => {
      if (!owned()) return { examined: 0, changed: 0 };
      const started = monotonic();
      let examined = 0,
        changed = 0,
        lagMs = 0,
        visits = 0;
      totals.calls++;
      totals.lastRunAt = clock();
      while (
        visits < store.phases.length &&
        examined < rowLimit &&
        owned() &&
        (visits === 0 || monotonic() - started < sliceMs)
      ) {
        const phase = store.phases[cursor];
        cursor = (cursor + 1) % store.phases.length;
        visits++;
        let scope = null;
        callbackEntered = false;
        let result;
        try {
          phaseState = 'discovery';
          if (store.organizationScoped) {
            scope = await runWork(
              () => {
                if (!owned() || !allowed(phase.channel)) return null;
                if (phase.nextEntity) return phase.nextEntity(clock());
                const organizationId = phase.nextOrganization(clock());
                return organizationId ? { organizationId } : null;
              },
              '',
              owned,
            );
            if (!scope || !owned()) continue;
          }
          phaseState = 'admission';
          const pending = runWork(
            () => {
              phaseState = 'probe';
              // Admit an actual bounded probe/writer start outside a transaction.
              if (!owned() || !allowed(phase.channel) || (!scope && !phase.hasWork(clock())))
                return null;
              const run = () => {
                // Callback entry is the hard boundary, including guard failures.
                callbackEntered = true;
                phaseState = 'callback';
                if (!owned() || !allowed(phase.channel)) return null;
                const at = monotonic(),
                  outcome = phase.run(clock(), rowLimit - examined, scope?.organizationId || scope);
                totals.maxSliceMs = Math.max(totals.maxSliceMs, monotonic() - at);
                totals.slices++;
                phaseState = 'settlement';
                return outcome;
              };
              phaseState = 'admission';
              if (scope)
                return scope.organizationId
                  ? c.organizationQueueTransaction(run, {
                      queueDomain: phase.queueDomain,
                      organizationId: scope.organizationId,
                    })
                  : c.entityQueueTransaction(run, scope);
              if (c.asyncQueueTransaction)
                return c.asyncQueueTransaction(run, { queueDomain: phase.queueDomain });
              if (c.queueTransaction) return c.queueTransaction(run, phase.queueDomain);
              return c.asyncTransaction ? c.asyncTransaction(run) : c.transaction(run);
            },
            scope?.organizationId || '',
            owned,
          );
          result = pending && typeof pending.then === 'function' ? await pending : pending;
        } catch (error) {
          // Only known failed admission is retried on a later bounded tick. The
          // discovery cursor is a round-robin hint; no row/lease was mutated.
          if (
            !callbackEntered &&
            error &&
            cleanBusy(error) &&
            error.scopedQueueCallbackStarted !== true &&
            c.db.isTransaction === false
          ) {
            totals.busyDeferrals++;
            continue;
          }
          throw error;
        }
        if (!result) continue;
        examined += result.examined;
        changed += result.changed;
        lagMs = Math.max(lagMs, result.lagMs);
        phaseState = 'yield';
        await yieldTurn();
      }
      totals.examined += examined;
      totals.changed += changed;
      totals.lagMs = lagMs;
      totals.maxLagMs = Math.max(totals.maxLagMs, lagMs);
      totals.elapsedMs += Math.max(0, monotonic() - started);
      return { examined, changed };
    })()
      .catch((error) => {
        totals.errors++;
        diagnostics.record('planning', error);
        const failure = diagnostics.snapshot().last;
        lastFailure = {
          phase: phaseState,
          code: failure.code,
          status: failure.status,
          callbackEntered,
          retryableBeforeBegin: failure.retryableBeforeBegin,
          transactionOpen:
            typeof error?.transactionOpen === 'boolean' ? error.transactionOpen : null,
          outcomeUnknown: failure.outcomeUnknown,
          channelPoisoned: failure.channelPoisoned,
        };
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
    if (timer) clearTimeout(timer);
    timer = null;
  }
  function start(canRun, runWork = (callback) => callback()) {
    if (!enabled) return;
    if (typeof canRun !== 'function')
      throw Error('Notification maintenance requires ownership guard');
    if (typeof runWork !== 'function')
      throw Error('Notification maintenance requires work admission');
    if (running) return;
    running = true;
    const epoch = ++generation;
    const schedule = () => {
      if (!running || epoch !== generation) return;
      timer = setTimeout(async () => {
        timer = null;
        try {
          await tick({ canRun, runWork });
        } catch {
          /* Aggregated; no payloads or provider errors in metrics. */
        }
        schedule();
      }, intervalMs);
      timer.unref?.();
    };
    schedule();
  }
  function recover(callback) {
    if (!enabled) return;
    const at = monotonic(),
      result = callback();
    totals.recoveryCalls++;
    totals.recoveryExamined += result.examined;
    totals.recoveryChanged += result.changed;
    totals.recoveryElapsedMs += Math.max(0, monotonic() - at);
  }
  return {
    enabled,
    tick,
    start,
    stop,
    recoverClient: (now, channels, org) =>
      recover(() => store.recoverClient(now, channels, 8, org)),
    recoverStaffMax: (now, org) => recover(() => store.recoverStaffMax(now, 8, org)),
    stats: () => ({
      enabled,
      running,
      busy: Boolean(busy),
      rowLimit,
      sliceMs,
      intervalMs,
      ...totals,
      lastFailure: lastFailure ? { ...lastFailure } : null,
    }),
  };
}
module.exports = { createQueueMaintenance };
