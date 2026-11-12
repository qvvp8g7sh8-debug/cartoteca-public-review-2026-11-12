const { isRequestAdmissionDeferral } = require('../../infrastructure/request-dispatcher.cjs');
const { createPushDeliveryAdmission, limits, add } = require('./push-delivery-admission.cjs');
function createManagedPushDelivery({
  store,
  clock,
  monotonic,
  current,
  active,
  available,
  manualRunning,
  plan,
  deliver,
  onError,
  runBackgroundWork = (callback) => callback(),
}) {
  const admission = createPushDeliveryAdmission({ monotonic });
  const counts = {
    turns: 0,
    probes: 0,
    claims: 0,
    started: 0,
    sent: 0,
    cancelled: 0,
    retried: 0,
    failed: 0,
    stale: 0,
    errors: 0,
    admissionDeferrals: 0,
  };
  const lag = { count: 0, totalMs: 0, maxMs: 0 };
  let timer = null,
    timerAt = Infinity,
    pumping = false,
    epoch = 0,
    cooldownUntil = 0,
    observedHeadDueLagMs = null,
    observedHeadAt = null,
    nextMaintenance = 0;
  const count = (key) => {
    counts[key] = add(counts[key]);
  };
  function wake(nextEpoch, delay = 0) {
    if (!current(nextEpoch)) return;
    const at = clock() + Math.max(0, delay);
    if (timer && timerAt <= at) return;
    clearTimeout(timer);
    timerAt = at;
    timer = setTimeout(
      () => {
        timer = null;
        timerAt = Infinity;
        pump(nextEpoch);
      },
      Math.max(0, delay),
    );
    timer.unref();
  }
  function failure(nextEpoch) {
    count('errors');
    if (!current(nextEpoch)) return;
    cooldownUntil = Math.max(cooldownUntil, clock() + 15000);
    onError();
  }
  async function pump(nextEpoch) {
    if (!current(nextEpoch) || pumping) return;
    if (!active(nextEpoch) || !available() || manualRunning()) return wake(nextEpoch, 1000);
    pumping = true;
    let callbackEntered = true;
    count('turns');
    try {
      if (clock() < cooldownUntil) return wake(nextEpoch, cooldownUntil - clock());
      for (let starts = 0; starts < limits.starts && admission.active < limits.active; starts++) {
        if (!active(nextEpoch) || !available()) break;
        const wait = admission.delay();
        if (wait) {
          admission.yield();
          return wake(nextEpoch, wait);
        }
        callbackEntered = false;
        const pending = runBackgroundWork(
          () => {
            callbackEntered = true;
            // Ownership may have changed while the common foreground dispatcher
            // held this callback. A cancelled permit must never acquire a lease.
            if (!active(nextEpoch) || !available() || manualRunning()) return null;
            plan(nextEpoch);
            if (clock() >= nextMaintenance) {
              admission.measure(() => store.maintainManaged?.(clock()));
              nextMaintenance = clock() + 1000;
            }
            const blocked = admission.exclusions();
            count('probes');
            let head, job;
            if (typeof store.claimManagedWithHead === 'function') {
              ({ head, job } = admission.measure(() =>
                store.claimManagedWithHead(clock(), blocked),
              ));
            } else {
              head = admission.measure(() => store.peekManaged(clock(), blocked));
              if (head && active(nextEpoch) && available())
                job = admission.measure(() => store.claimManaged(clock(), blocked));
            }
            observedHeadAt = clock();
            observedHeadDueLagMs = head ? Math.max(0, observedHeadAt - head.next_at) : null;
            // PG3's scoped selection and CAS already supply this observational
            // head. Other profiles retain the original global probe/claim path.
            if (!job) return null;
            count('claims');
            const age = Math.max(0, clock() - job.next_at);
            lag.count = add(lag.count);
            lag.totalMs = add(lag.totalMs, age);
            lag.maxMs = Math.max(lag.maxMs, age);
            // Hold inside the same callback as the claim: an awaited dispatcher
            // result must not expose a lease without its real local device slot.
            const release = admission.hold(job);
            count('started');
            return { job, release };
          },
          '',
          () => active(nextEpoch),
        );
        const claimed = pending && typeof pending.then === 'function' ? await pending : pending;
        if (!claimed) return wake(nextEpoch, 1000);
        const { job, release } = claimed;
        // No batch wait: a slow recipient owns only its actual live slot. Stop
        // and restart never release that slot before the provider has settled.
        void Promise.resolve()
          .then(() => deliver(job, () => active(nextEpoch), admission.measure))
          .then((result) => {
            if (['sent', 'cancelled', 'retried', 'failed', 'stale'].includes(result.outcome))
              count(result.outcome);
            if (result.outcome === 'admission-deferred') count('admissionDeferrals');
            if (result.backpressure && current(nextEpoch))
              cooldownUntil = Math.max(cooldownUntil, clock() + 15000);
          })
          .catch(() => failure(nextEpoch))
          .finally(() => {
            release();
            wake(epoch, Math.max(1, cooldownUntil - clock(), admission.delay()));
          });
      }
      if (admission.active < limits.active)
        wake(nextEpoch, Math.max(1, admission.delay(), cooldownUntil - clock()));
    } catch (error) {
      if (!callbackEntered && isRequestAdmissionDeferral(error)) {
        count('admissionDeferrals');
        wake(nextEpoch, Math.max(1000, admission.delay()));
      } else {
        failure(nextEpoch);
        wake(nextEpoch, 15000);
      }
    } finally {
      pumping = false;
    }
  }
  return {
    start(nextEpoch) {
      epoch = nextEpoch;
      nextMaintenance = 0;
      wake(epoch);
    },
    stop() {
      clearTimeout(timer);
      timer = null;
      timerAt = Infinity;
    },
    wake: () => wake(epoch),
    get active() {
      return admission.active;
    },
    measure: admission.measure,
    async waitForBudget(isActive) {
      while (isActive() && admission.delay()) {
        admission.yield();
        await new Promise((resolve) => {
          setTimeout(resolve, Math.min(100, admission.delay()));
        });
      }
      return isActive();
    },
    stats: () => ({
      ...admission.stats(),
      ...counts,
      claimedNextAtLag: { ...lag },
      observedHeadDueLagMs,
      observedHeadObservationAgeMs:
        observedHeadAt === null ? null : Math.max(0, clock() - observedHeadAt),
    }),
  };
}
module.exports = { createManagedPushDelivery };
