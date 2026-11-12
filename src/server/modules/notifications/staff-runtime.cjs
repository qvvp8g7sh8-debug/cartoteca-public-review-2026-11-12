const { staffBookingMessage, staffNotificationTarget } = require('./staff-booking-message.cjs');
const { resolveStaffAppointment } = require('./staff-appointment-events.cjs');
const { createStaffEventReplay } = require('./staff-event-replay.cjs');
const { channelEnabled } = require('./staff-event-preferences.cjs');
const { createQueueIdleProbe } = require('./queue-idle-probe.cjs');
function createStaffTelegramRuntime({
  platform,
  tenantStore,
  bot,
  pacing,
  clock = Date.now,
  origin = '',
  runBackgroundWork = (callback) => callback(),
}) {
  const store = platform.staffNotifications;
  const idle = createQueueIdleProbe({ clock, subscribe: store?.subscribePending });
  const replay = createStaffEventReplay({ platform, tenantStore, store, clock });
  const resolve = (job) => resolveStaffAppointment(platform, tenantStore, job);
  function message(job, record) {
    return staffBookingMessage(platform, job, record);
  }
  function markup(job) {
    if (!origin || !origin.startsWith('https://')) return null;
    const target = staffNotificationTarget(job, origin);
    return { inline_keyboard: [[{ text: target.text, url: target.url }]] };
  }
  async function handleStart(command, chatId, reply) {
    const secret = command.match(/^\/start(?:@\w+)?\s+staff_([A-Za-z0-9_-]{43})$/)?.[1];
    if (!secret) return false;
    let text;
    try {
      const row = store.consume(secret, chatId, clock());
      text = `${platform.organization(row.organization_id).name || 'Организация'}\n\nЛичные уведомления сотрудника подключены. Здесь появятся новые заявки и ответы клиентов на предложенное время. Телефоны и история клиентов в сообщения не включаются. Отключить сообщения: /stop`;
    } catch (error) {
      text = error.status
        ? error.message
        : 'Не удалось подключиться. Создайте новую ссылку в своём аккаунте картотеки.';
    }
    await reply(chatId, text);
    return true;
  }
  async function tick(signal, canSend, max = 5, managed = false) {
    const active = () => !signal?.aborted && canSend() && channelEnabled(platform, 'telegram');
    const runWork = (callback, org = '') =>
      managed ? runBackgroundWork(() => (active() ? callback() : null), org, active) : callback();
    if (!store || !bot || signal?.aborted || !canSend()) return;
    if (managed) await replay.batched(signal, canSend, runBackgroundWork);
    else replay(signal, canSend);
    if (signal?.aborted || !canSend()) return;
    if (managed && !idle.ready()) return;
    let probe = managed ? idle.capture() : null;
    if (store.hasPendingWork?.(clock()) === false) {
      if (managed) idle.empty(store.nextPendingAt?.(clock()), probe);
      return;
    }
    if (!channelEnabled(platform, 'telegram')) {
      if (managed) idle.empty(undefined, probe);
      return;
    }
    for (let i = 0; i < max; i++) {
      if (signal?.aborted || !canSend() || !channelEnabled(platform, 'telegram')) return;
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
        if (signal?.aborted || !canSend() || !channelEnabled(platform, 'telegram')) return;
        const prepare = runWork(() => {
          const check = () => {
            const record = store.valid(job, clock(), resolve);
            if (!record) {
              leaseHandled = true;
              store.finish(job, 'cancelled');
              return null;
            }
            return { text: message(job, record), buttons: markup(job) };
          };
          const prepared = store.deliveryFor ? store.deliveryFor(job, check) : check();
          if (!prepared) return null;
          providerStarted = true;
          return { pending: bot.send(job.decoded.chatId, prepared.text, prepared.buttons, signal) };
        }, job.organization_id);
        const prepared = prepare && typeof prepare.then === 'function' ? await prepare : prepare;
        if (!prepared) continue;
        await prepared.pending;
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
        if (error.status === 403 || error.providerCode === 400) {
          store.finish(job, 'failed');
          store.stopChat(job.decoded.chatId);
          platform.telegram?.stopChat(job.decoded.chatId);
        } else if (error.status === 429) {
          pacing.pause(error.retryAfter);
          store.finish(
            job,
            'pending',
            clock() + Math.max(1, Number(error.retryAfter) || 30) * 1000,
            true,
          );
          return;
        } else
          store.finish(
            job,
            job.attempts >= 5 ? 'failed' : 'pending',
            clock() + Math.min(3600, 30 * 2 ** job.attempts) * 1000,
          );
      } finally {
        try {
          // Managed admission may stop before a POST. Refund only this exact
          // still-sending lease; cancelled or reclaimed rows cannot be revived.
          if (managed && !providerStarted && !leaseHandled)
            store.finish(job, 'pending', clock() + 1000, true);
        } finally {
          if (acquired) pacing.releaseDelivery?.(job.decoded.chatId);
        }
      }
    }
  }
  return {
    handleStart,
    tick,
    tickManaged: (signal, canSend, max) => tick(signal, canSend, max, true),
    status: () => replay.status(),
    close: idle.close,
  };
}
module.exports = { createStaffTelegramRuntime };
