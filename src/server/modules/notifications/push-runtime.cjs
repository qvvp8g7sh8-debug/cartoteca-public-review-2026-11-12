const { createPushSchedule } = require('./push-events.cjs');
const { subscription } = require('./push-validation.cjs');
const { pushMessage } = require('./push-message.cjs');
const { setImmediate: yieldImmediate } = require('node:timers/promises');
const { createManagedPushDelivery } = require('./push-managed-delivery.cjs');
const { isRequestAdmissionDeferral } = require('../../infrastructure/request-dispatcher.cjs');
function createPushRuntime({
  platform,
  tenantStore,
  origin,
  enabled = false,
  send,
  clock = Date.now,
  yieldTurn = yieldImmediate,
  canRun = () => true,
  monotonic,
  runBackgroundWork = (callback) => callback(),
}) {
  const store = platform.staffPush;
  const ready = Boolean(enabled && store && /^https:\/\//.test(origin));
  store?.setRuntimeAvailable?.(ready);
  const available = () => ready && store.runtimeAvailable?.() !== false;
  const events = ready ? createPushSchedule(platform, tenantStore, store, clock) : null;
  const deliver =
    send ||
    ((sub, payload, options) => require('web-push').sendNotification(sub, payload, options));
  let running = false,
    stopped = true,
    generation = 0,
    scheduling = null,
    nextSchedule = 0,
    error = '';
  const current = (epoch) => !stopped && epoch === generation;
  const active = (epoch) => current(epoch) && canRun();
  const managed = createManagedPushDelivery({
    store,
    clock,
    monotonic,
    current,
    active,
    available,
    manualRunning: () => running,
    plan(epoch) {
      if (scheduling || clock() < nextSchedule) return;
      if (managed.measure(() => store.hasEnabledEvents?.('', 'reminder') !== false))
        beginScheduling(epoch, () => active(epoch) && available(), true);
      else nextSchedule = clock() + 15000;
    },
    runBackgroundWork,
    deliver: (job, active, measure) => deliverJob(job, active, measure, true),
    onError: () => {
      error = 'Не удалось обработать очередь Push-уведомлений.';
    },
  });
  async function schedule(active, managedScan) {
    const runWork = managedScan
      ? async (callback, org = '') => {
          if (!(await managed.waitForBudget(active))) return null;
          return runBackgroundWork(
            () => (active() && available() ? managed.measure(callback) : null),
            org,
            active,
          );
        }
      : (callback) => callback();
    // Durable schema18 planning uses the same measured bank as legacy pages.
    if (events.scheduleBatched) return events.scheduleBatched({ canRun: active, runWork });
    let cursor = '';
    do {
      if (!active()) return false;
      const page = await runWork(() => events.scheduleBatch(cursor, managedScan ? 1 : 10));
      if (!page || !active()) return false;
      cursor = page.cursor;
      if (cursor) await yieldTurn(); // No transaction or borrowed store survives this yield.
    } while (cursor);
    return active();
  }
  function beginScheduling(epoch, active, managedScan = false) {
    if (scheduling) return scheduling;
    const scan = { epoch };
    scan.promise = Promise.resolve()
      .then(() => schedule(active, managedScan))
      .then((completed) => {
        if (completed && epoch === generation && active()) {
          nextSchedule = clock() + 15000;
          error = '';
        }
        return completed;
      })
      .finally(() => {
        if (scheduling === scan) scheduling = null;
      });
    // The timer does not await the scan. Observe its errors without swallowing
    // the public one-shot tick's rejection or consulting a possibly failed lease.
    void scan.promise.catch(() => {
      if (epoch === generation && !stopped) {
        error = 'Не удалось подготовить очередь Push-уведомлений.';
        nextSchedule = clock() + 15000;
      }
    });
    scheduling = scan;
    return scan;
  }
  async function runTick(max) {
    if (!available() || running || managed.active || stopped || !canRun()) return;
    if (store.hasEnabledEvents?.() === false && !store.hasPendingTests?.(clock())) return 0;
    const epoch = generation,
      active = () => !stopped && epoch === generation && canRun();
    let processed = 0,
      allowDrain = true;
    running = true;
    try {
      const reminders = store.hasEnabledEvents?.('', 'reminder') !== false;
      const planningActive = () => active() && available();
      if (reminders) {
        // Explicit calls retain their prepare-then-deliver/await/error contract.
        const scan = beginScheduling(epoch, planningActive);
        await scan.promise;
        if (scan.epoch !== epoch && active()) await beginScheduling(epoch, planningActive).promise;
      }
      for (let i = 0; i < max && active() && available(); i++) {
        const job = store.claim(clock());
        if (!job) break;
        processed++;
        if ((await deliverJob(job, active)).backpressure) allowDrain = false;
      }
      return allowDrain ? processed : 0;
    } finally {
      running = false;
      managed.wake();
    }
  }
  async function deliverJob(job, active, measure = (work) => work(), managedWork = false) {
    let providerStarted = false,
      leaseHandled = false,
      acknowledged = false,
      preparationEntered = false,
      row;
    try {
      if (!active()) return { outcome: 'stale' };
      const prepareAndStart = () => {
        preparationEntered = true;
        if (!active() || !available()) return { outcome: 'stale' };
        const prepareOwned = () => {
          if (!store.valid(job, clock()) || !events.current(job)) {
            leaseHandled = true;
            store.finish(job, 'cancelled');
            return { outcome: 'cancelled' };
          }
          const data = {
            accountId: job.account_id,
            organizationId: job.organization_id,
            url:
              '/#staff-push=' +
              encodeURIComponent(
                JSON.stringify({
                  ...job.decoded.reference,
                  accountId: job.account_id,
                  organizationId: job.organization_id,
                }),
              ),
            event: job.decoded.event,
          };
          const payload = JSON.stringify({
            title: 'Картотека',
            body: pushMessage(job.decoded.event, job.decoded.reference),
            tag: 'staff-push-' + job.event_key.slice(-32),
            data,
          });
          if (!active() || !available()) return { outcome: 'stale' };
          // A binding can change while the event is being checked. Revalidate as
          // close as possible to the external send; an accepted push cannot be recalled.
          const row = store.valid(job, clock());
          if (!row) {
            leaseHandled = true;
            store.finish(job, 'cancelled');
            return { outcome: 'cancelled' };
          }
          return { row, payload };
        };
        const prepared = measure(() =>
          store.deliveryFor ? store.deliveryFor(job, prepareOwned) : prepareOwned(),
        );
        if (prepared.outcome) return prepared;
        const { row, payload } = prepared;
        try {
          // Start inside the admitted synchronous callback, immediately after the
          // fresh binding/ACL checks. Only the actual provider settlement awaits.
          return {
            row,
            pending: measure(() => {
              const target = subscription(row.decoded.subscription);
              const options = {
                timeout: 10000,
                TTL: Math.max(1, Math.min(3600, Math.floor((job.expires_at - clock()) / 1000))),
                urgency: 'normal',
                topic: job.event_key.slice(-32),
                vapidDetails: { subject: origin, ...store.keys() },
              };
              // All arguments exist before the boundary. A synchronous throw
              // from the actual provider still counts as an attempted send.
              providerStarted = true;
              return deliver(target, payload, options);
            }),
          };
        } catch (error) {
          return { row, error };
        }
      };
      const pending = managedWork
        ? runBackgroundWork(prepareAndStart, job.organization_id, active)
        : prepareAndStart();
      const prepared = pending && typeof pending.then === 'function' ? await pending : pending;
      if (!prepared) return { outcome: 'stale' };
      if (prepared.outcome) return prepared;
      row = prepared.row;
      if (Object.hasOwn(prepared, 'error')) throw prepared.error;
      await prepared.pending;
      acknowledged = true;
      // Stop prevents new work, not recording an already known provider ACK.
      // The existing status/lease CAS rejects any rebound/reclaimed job.
      const committed = measure(() => store.finish(job, 'sent'));
      return { outcome: committed === 0 ? 'stale' : 'sent' };
    } catch (error) {
      // Only this dispatcher's proven pre-callback refusal is a known no-send.
      // The finally block still refunds this exact unstarted lease before return.
      if (!preparationEntered && isRequestAdmissionDeferral(error))
        return { outcome: 'admission-deferred' };
      if (error.outcomeUnknown || error.channelPoisoned) {
        leaseHandled = true;
        throw error;
      }
      if (!providerStarted || acknowledged) throw error;
      // Preparation/admission failures are known no-sends. A failed ACK commit
      // is also never classified as a transport failure or explicit resend.
      if (!active()) return { outcome: 'stale' };
      const status = error.statusCode;
      if ([404, 410].includes(status)) {
        measure(() => {
          store.finish(job, 'failed');
          store.expire(row.id, row.decoded.bindingId);
        });
        return { outcome: 'failed' };
      } else if (status === 429 || !status || status >= 500) {
        // Do not accelerate another batch after a provider/backpressure
        // error. Its individual retry deadline remains authoritative too.
        const delay = Math.min(
          3600000,
          Math.max(30000 * 2 ** job.attempts, Number(error.headers?.['retry-after']) * 1000 || 0),
        );
        measure(() => store.finish(job, job.attempts >= 5 ? 'failed' : 'pending', clock() + delay));
        return { outcome: job.attempts >= 5 ? 'failed' : 'retried', backpressure: true };
      } else {
        measure(() => store.finish(job, 'failed'));
        return { outcome: 'failed' };
      }
    } finally {
      if (!providerStarted && !leaseHandled)
        measure(() => store.deferUnstarted?.(job, Math.max(job.next_at || 0, clock() + 1000)));
    }
  }
  function start() {
    if (!ready || !stopped) return;
    const epoch = ++generation;
    stopped = false;
    nextSchedule = 0;
    managed.start(epoch);
  }
  function stop() {
    generation++;
    stopped = true;
    managed.stop();
  }
  return {
    get available() {
      return available();
    },
    start,
    stop,
    tick: async (max = 10) => {
      await runTick(max);
    },
    status: () => ({ running: !stopped, preparing: Boolean(scheduling), error }),
    stats: managed.stats,
  };
}
module.exports = { createPushRuntime };
