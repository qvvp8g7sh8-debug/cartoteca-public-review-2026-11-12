const { compoundMutation } = require('../cabinet/compound-mutation133.cjs');
const { notificationMessage } = require('./notification-message.cjs');
const { lifecycleKinds } = require('./client-appointment-events.cjs');
const { createDeliveryLoops } = require('./delivery-loops.cjs');
const { createQueueIdleProbe } = require('./queue-idle-probe.cjs');

function createNotificationWorker({
  platform,
  tenantStore,
  store,
  policy,
  providers,
  clock,
  runBackgroundWork = (callback) => callback(),
}) {
  let busy = false,
    checking = false;
  const loops = createDeliveryLoops();
  const idle = Object.fromEntries(
    ['telegram', 'max'].map((channel) => [
      channel,
      createQueueIdleProbe({ clock, subscribe: store.subscribePending }),
    ]),
  );
  const locked = (job, work) => {
    const storage = tenantStore(job.organization_id);
    const callback = () => storage.transaction(() => work());
    if (store.inTransaction?.() === true) return callback();
    return platform.withCompoundMutation
      ? compoundMutation(platform, storage, job.organization_id, 'confirmation', callback)
      : store.transaction(callback);
  };
  const deliveryLocked = (job, work) =>
    store.deliveryFor
      ? store.deliveryFor(job, () =>
          tenantStore(job.organization_id).transaction(work, store.deliveryReadMode),
        )
      : store.deliveryTransaction
        ? store.deliveryTransaction(() =>
            tenantStore(job.organization_id).transaction(work, store.deliveryReadMode),
          )
        : locked(job, work);
  async function drain(channel, max, signal, canRun, managed, probe) {
    const active = () => !signal?.aborted && canRun();
    const runWork = (callback, org = '') =>
      managed ? runBackgroundWork(() => (active() ? callback() : null), org, active) : callback();
    for (let index = 0; index < max && !signal?.aborted && canRun(); index++) {
      let nextDue;
      const claim = runWork(() => {
        const ready = [channel];
        if (
          !policy.readyChannels().includes(channel) ||
          (store.hasNotificationRecipients && !store.hasNotificationRecipients(ready))
        )
          return null;
        const job =
          managed && store.claimManaged
            ? store.claimManaged(clock(), ready)
            : store.claim(clock(), ready);
        if (!job && managed) nextDue = store.nextPendingAt?.(clock());
        return job;
      });
      const job = claim && typeof claim.then === 'function' ? await claim : claim;
      if (!job) {
        if (managed && active()) idle[channel].empty(nextDue, probe);
        break;
      }
      if (managed) probe = idle[channel].active(probe);
      const provider = providers[job.decoded.channel];
      const unavailable = () => {
        const status = provider?.status?.();
        return status && (!status.configured || !status.connected);
      };

      const validation = runWork(() => {
        const check = () => {
          if (provider && policy.valid(job)) return true;
          store.transition(job, 'reserved', 'cancelled');
          return false;
        };
        return store.deliveryFor ? deliveryLocked(job, check) : check();
      }, job.organization_id);
      if (!(validation && typeof validation.then === 'function' ? await validation : validation))
        continue;
      let providerStarted = false,
        sendingCommitted = false,
        leaseHandled = false,
        acquired = false,
        acknowledged = false;
      try {
        if (!(await provider.acquire(job.decoded.recipient, signal))) {
          leaseHandled = true;
          store.transition(job, 'reserved', 'pending', clock() + 1000);
          continue;
        }
        acquired = true;
        const prepare = runWork(() => {
          const payload = deliveryLocked(job, () => {
            if (unavailable()) {
              store.transition(job, 'reserved', 'pending', clock());
              return null;
            }
            const current = policy.valid(job);
            if (!current || job.lease_until <= clock()) {
              store.transition(job, 'reserved', 'cancelled');
              return null;
            }
            if (signal?.aborted || !canRun()) {
              store.transition(job, 'reserved', 'pending', clock() + 1000);
              return null;
            }
            const link = platform.telegram.link(job.organization_id, job.patient_id);
            const text = notificationMessage(
              job.decoded.channel,
              platform.telegram.messageIdentity(job.organization_id, current.a.staffId),
              current.a,
              current.settings,
              {
                confirmed: job.decoded.kind === 'booking-confirmed',
                kind: job.decoded.kind,
                previous: job.decoded.previous,
                showServices:
                  current.settings.showServices &&
                  (job.decoded.channel === 'telegram'
                    ? link?.servicesConsent === true
                    : link?.servicesConsent !== false),
              },
            );
            const publicPhone = String(
              platform.organization(job.organization_id).phone || '',
            ).replace(/\D/g, '');
            const contactNumber =
              publicPhone.length === 11 && publicPhone.startsWith('8')
                ? '7' + publicPhone.slice(1)
                : publicPhone;
            const prepared = {
              contactUrl: /^[1-9]\d{6,14}$/.test(contactNumber)
                ? 'https://wa.me/' + contactNumber
                : '',
              recipient: job.decoded.recipient,
              text,
              confirmationToken:
                job.decoded.kind === 'booking-confirmed' ||
                lifecycleKinds.includes(job.decoded.kind)
                  ? ''
                  : job.decoded.callback,
              signal,
            };
            if (!store.transition(job, 'reserved', 'sending')) return null;
            return prepared;
          });
          if (!payload) return null;
          // A returned payload proves the sending transition committed. No
          // clinical or identity reads remain after this ownership boundary.
          sendingCommitted = true;
          if (signal?.aborted || !canRun() || unavailable()) {
            leaseHandled = true;
            store.transition(job, 'sending', 'pending', clock() + 1000);
            return null;
          }
          providerStarted = true;
          return { pending: provider.send(payload) };
        }, job.organization_id);
        const prepared = prepare && typeof prepare.then === 'function' ? await prepare : prepare;
        if (!prepared) continue;
        const acknowledgement = await prepared.pending;
        acknowledged = true;
        const messageId =
          job.decoded.channel === 'telegram'
            ? acknowledgement?.message_id
            : acknowledgement?.message?.body?.mid ||
              acknowledgement?.message?.mid ||
              acknowledgement?.mid;
        store.transition(
          job,
          'sending',
          'sent',
          0,
          clock(),
          typeof messageId === 'string' || Number.isSafeInteger(messageId)
            ? { messageId: String(messageId) }
            : {},
        );
      } catch (error) {
        if (error.outcomeUnknown || error.channelPoisoned || acknowledged || leaseHandled)
          throw error;
        if (!providerStarted)
          store.transition(
            job,
            sendingCommitted ? 'sending' : 'reserved',
            'pending',
            clock() + 30000,
          );
        else if (error.deliveryUncertain === false && error.status === 429) {
          provider.pause?.(error.retryAfter);
          store.transition(
            job,
            'sending',
            'pending',
            clock() + Math.min(3600, Math.max(1, error.retryAfter || 30)) * 1000,
          );
        } else
          store.transition(
            job,
            'sending',
            error.deliveryUncertain === false ? 'failed' : 'uncertain',
          );
        continue;
      } finally {
        if (acquired) provider.release?.(job.decoded.recipient);
      }
    }
  }
  async function run(managed, signal, canRun) {
    if (busy || checking || (!managed && loops.any()) || signal?.aborted || !canRun()) return;
    if (!managed) busy = true;
    try {
      const free = ['telegram', 'max'].filter(
        (channel) => !loops.running(channel) && (!managed || idle[channel].ready()),
      );
      if (!free.length) return;
      const probes = Object.fromEntries(free.map((channel) => [channel, idle[channel].capture()]));
      const inspect = () => {
        if (signal?.aborted || !canRun()) return [];
        if (store.hasPendingWork?.(clock(), free) === false) {
          if (managed) {
            const nextDue = store.nextPendingAt?.(clock());
            for (const channel of free) idle[channel].empty(nextDue, probes[channel]);
          }
          return [];
        }
        const ready = policy.readyChannels();
        if (managed)
          for (const channel of free)
            if (!ready.includes(channel)) idle[channel].empty(undefined, probes[channel]);
        return ready;
      };
      // This discovery callback cannot overlap another discovery tick, but it
      // releases ownership before waiting on either channel's provider.
      let ready;
      checking = true;
      try {
        ready = managed ? await runBackgroundWork(inspect, '', canRun) : inspect();
      } finally {
        checking = false;
      }
      if (signal?.aborted || !canRun()) return;
      const channels = ['telegram', 'max'].filter((channel) => ready?.includes(channel));
      if (!channels.length) return;
      // At most two sends run concurrently. A channel remains sequential, so
      // recipient ordering and provider pacing retain their existing contract.
      // Divide the bounded claim budget so one busy channel cannot consume it all.
      const max = Math.floor(40 / channels.length);
      const results = await Promise.allSettled(
        channels
          .filter((channel) => free.includes(channel) && !loops.running(channel))
          .map((channel) =>
            loops.start(channel, () =>
              drain(channel, max, signal, canRun, managed, probes[channel]),
            ),
          ),
      );
      // Do not release busy while a sibling still owns a lease or external send,
      // even when another lane fails outside the individual delivery catch.
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    } finally {
      if (!managed) busy = false;
    }
  }
  return {
    tick: (signal, canRun = () => true) => run(false, signal, canRun),
    tickManaged: (signal, canRun = () => true) => run(true, signal, canRun),
    locked,
    close: () => Object.values(idle).forEach((probe) => probe.close()),
  };
}
module.exports = { createNotificationWorker };
