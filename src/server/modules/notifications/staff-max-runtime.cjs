const { staffBookingMessage, staffNotificationTarget } = require('./staff-booking-message.cjs');
const { resolveStaffAppointment } = require('./staff-appointment-events.cjs');
const { createStaffEventReplay } = require('./staff-event-replay.cjs');
const { maxId } = require('./max-adapter.cjs');
const { channelEnabled } = require('./staff-event-preferences.cjs');
const { createQueueIdleProbe } = require('./queue-idle-probe.cjs');
function createStaffMaxRuntime({
  platform,
  tenantStore,
  store = null,
  bot = null,
  identity = null,
  pacing,
  clock = Date.now,
  origin = '',
  runBackgroundWork = (callback) => callback(),
}) {
  const currentBotId = identity ? maxId(identity.botId) : '';
  const idle = createQueueIdleProbe({ clock, subscribe: store?.subscribePending });
  const replay = createStaffEventReplay({ platform, tenantStore, store, clock, channel: 'max' });
  const resolve = (job) => resolveStaffAppointment(platform, tenantStore, job);
  async function tick(signal, canSend, max = 5, verifyOwnership = canSend, managed = false) {
    const lifetime = () => !signal?.aborted && canSend();
    const active = () => lifetime() && channelEnabled(platform, 'max');
    const authorized = () =>
      lifetime() && verifyOwnership() && channelEnabled(platform, 'max') && lifetime();
    const runWork = (callback, org = '') => {
      const work = () => (authorized() ? callback() : null);
      return managed ? runBackgroundWork(work, org, lifetime) : work();
    };
    if (!store || !bot || !identity || signal?.aborted || !canSend()) return;
    if (managed) await replay.batched(signal, canSend, (callback, org) => runWork(callback, org));
    else replay(signal, authorized);
    if (signal?.aborted || !canSend()) return;
    if (managed && !idle.ready()) return;
    let probe = managed ? idle.capture() : null;
    if (store.hasPendingWork?.(clock()) === false) {
      if (managed) idle.empty(store.nextPendingAt?.(clock()), probe);
      return;
    }
    if (!channelEnabled(platform, 'max')) {
      if (managed) idle.empty(undefined, probe);
      return;
    }
    for (let i = 0; i < max; i++) {
      if (signal?.aborted || !canSend() || !channelEnabled(platform, 'max')) return;
      const claim = runWork(() =>
        managed && store.claimManaged ? store.claimManaged(clock()) : store.claim(clock()),
      );
      const job = claim && typeof claim.then === 'function' ? await claim : claim;
      if (!job) {
        if (managed && !signal?.aborted && canSend())
          idle.empty(store.nextPendingAt?.(clock()), probe);
        return;
      }
      if (managed) probe = idle.active(probe);
      const [botId, userId] = job.decoded.chatId.split(':');
      if (botId !== currentBotId) {
        store.finish(job, 'cancelled');
        continue;
      }
      let acquired = false,
        providerStarted = false,
        leaseHandled = false,
        acknowledged = false;
      try {
        const validate = runWork(() => {
          const check = () => {
            if (store.valid(job, clock(), resolve)) return true;
            leaseHandled = true;
            store.finish(job, 'cancelled');
            return false;
          };
          return store.deliveryFor ? store.deliveryFor(job, check) : check();
        }, job.organization_id);
        if (!(validate && typeof validate.then === 'function' ? await validate : validate))
          continue;
        if (
          !(await (pacing.acquireDelivery || pacing.acquire).call(
            pacing,
            job.decoded.chatId,
            signal,
            1000,
          ))
        ) {
          leaseHandled = true;
          store.finish(
            job,
            'pending',
            clock() + Math.max(1000, pacing.remaining(job.decoded.chatId)),
            true,
          );
          return;
        }
        acquired = true;
        if (signal?.aborted || !canSend() || !channelEnabled(platform, 'max')) {
          leaseHandled = true;
          store.finish(job, 'pending', clock() + 1000, true);
          return;
        }
        const prepare = runWork(() => {
          const check = () => {
            const record = store.valid(job, clock(), resolve);
            if (!record) {
              leaseHandled = true;
              store.finish(job, 'cancelled');
              return null;
            }
            if (!authorized()) return null;
            return {
              recipient: { botId, userId },
              text: staffBookingMessage(platform, job, record, 'max', origin),
              ...(origin.startsWith('https://')
                ? { link: staffNotificationTarget(job, origin) }
                : {}),
              signal,
            };
          };
          const payload = store.deliveryFor ? store.deliveryFor(job, check) : check();
          if (!payload) return null;
          providerStarted = true;
          return { pending: bot.send(payload) };
        }, job.organization_id);
        const prepared = prepare && typeof prepare.then === 'function' ? await prepare : prepare;
        if (!prepared) continue;
        await prepared.pending;
        // An interrupted POST is not replayed: expired sending leases become uncertain.
        acknowledged = true;
        // Exact lease/status CAS also records a known ACK after stop.
        store.finish(job, 'sent');
      } catch (error) {
        if (error.outcomeUnknown || error.channelPoisoned) {
          leaseHandled = true;
          throw error;
        }
        if (acknowledged) throw error;
        if (managed && !providerStarted) {
          if (signal?.aborted) return;
          throw error;
        }
        if (signal?.aborted) return;
        if (error.status === 429) {
          pacing.pause(error.retryAfter);
          store.finish(
            job,
            'pending',
            clock() + Math.max(1, Number(error.retryAfter) || 30) * 1000,
            true,
          );
          return;
        }
        if (error.deliveryUncertain) store.finish(job, 'uncertain');
        else if ([400, 401, 403, 404].includes(error.status)) store.finish(job, 'failed');
        else
          store.finish(
            job,
            job.attempts >= 5 ? 'failed' : 'pending',
            clock() + Math.min(3600, 30 * 2 ** job.attempts) * 1000,
          );
      } finally {
        try {
          // A queued check is not a POST. Only the original still-sending lease
          // may be refunded; an attempted send keeps its uncertain policy.
          if (!providerStarted && !leaseHandled) store.finish(job, 'pending', clock() + 1000, true);
        } finally {
          if (acquired) pacing.releaseDelivery?.(job.decoded.chatId);
        }
      }
    }
  }
  return {
    tick,
    tickManaged: (signal, canSend, max, verifyOwnership) =>
      tick(signal, canSend, max, verifyOwnership, true),
    status: () => replay.status(),
    close: idle.close,
  };
}
module.exports = { createStaffMaxRuntime };
