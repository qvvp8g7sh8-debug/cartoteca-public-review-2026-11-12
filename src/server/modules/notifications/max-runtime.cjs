const { fail } = require('../../../shared/errors.cjs');
const { randomUUID } = require('node:crypto');
const { createTelegramPacing } = require('./telegram-pacing.cjs');
const { createDeliveryLoops } = require('./delivery-loops.cjs');
const { createMaxRuntimeLease } = require('./max-runtime-lease.cjs');

function createMaxRuntime({
  inbox = null,
  events = null,
  bot = null,
  identity = null,
  clock = Date.now,
  monotonicClock,
  pacing = createTelegramPacing({ clock }),
  staffDelivery = null,
  canRun = () => true,
  runBackgroundWork = (callback) => callback(),
}) {
  const owner = randomUUID();
  const lease = createMaxRuntimeLease({
    inbox,
    botId: identity?.botId,
    owner,
    clock,
    monotonicClock,
  });
  const deliveryLoops = createDeliveryLoops();
  let timer,
    controller,
    busy = false,
    running = false,
    lastError = '',
    generation = 0;
  const ready = () => Boolean(inbox && events && bot && identity);
  function authenticate(header) {
    if (!ready()) throw fail(503, 'Приём MAX ещё не подключён.');
    events.authenticate(header);
  }
  function accept(header, event) {
    authenticate(header);
    const normalized = events.normalize(event);
    if (!normalized) return { accepted: true, ignored: true };
    const result = inbox.accept(identity.botId, normalized, clock());
    return { accepted: true, repeated: result.repeated };
  }
  async function tick(signal) {
    if (!ready() || busy || !canRun()) return;
    busy = true;
    try {
      const proof = lease.ensure();
      if (!proof) return;
      const active = () => !signal?.aborted && canRun() && proof();
      await deliveryLoops.start('inbox', () => drainInbox(signal, active, proof));
      await deliveryLoops.start('staff', () => drainStaff(signal, active, proof));
    } finally {
      busy = false;
    }
  }
  async function drainInbox(signal, active, proof, managed = false) {
    const verify = () => active() && proof.verify() && active();
    const runWork = (callback, requireAuthority = true) => {
      const work = () => ((requireAuthority ? verify() : active()) ? callback() : null);
      return managed ? runBackgroundWork(work, '', active) : work();
    };
    for (let i = 0; i < 40 && active(); i++) {
      const claim = runWork(() => {
        if (inbox.hasPendingWork?.(identity.botId, clock()) === false) return null;
        // A head is not authority: another process may revoke the lease between
        // this hint and the original claim. Verify only after positive work.
        if (!verify()) return null;
        const authority = proof.authority();
        return authority ? inbox.claim(identity.botId, clock(), authority) : null;
      }, false);
      const row = claim && typeof claim.then === 'function' ? await claim : claim;
      if (!row) break;
      if (!active()) break;
      let completed = false;
      try {
        const process = runWork(() => {
          if (row.decoded.result) return row.decoded.result;
          const result = events.process(row.decoded.event);
          // Durable outcome before the API answer. Reclaim must not repeat domain writes.
          return inbox.saveResult(row, result) ? result : null;
        });
        const result = process && typeof process.then === 'function' ? await process : process;
        if (!result) continue;
        if (result.callbackId) {
          if (
            !(await pacing.acquire(
              identity.botId + ':' + row.decoded.event.callback.user.user_id,
              signal,
              1000,
            ))
          ) {
            inbox.defer(row, clock() + 1000);
            continue;
          }
          if (!active()) break;
          const answer = runWork(() =>
            active()
              ? {
                  pending: bot.answer(result.callbackId, result.notification, signal),
                }
              : null,
          );
          const answering = answer && typeof answer.then === 'function' ? await answer : answer;
          if (!answering) break;
          await answering.pending;
          if (result.messageId && bot.clearButtons) {
            try {
              if (verify())
                await bot.clearButtons(result.messageId, signal, result.contactUrl || '');
            } catch {
              /* The saved confirmation remains authoritative; editing is best effort. */
            }
          }
        }
        completed = true;
        // The saved outcome and known reply ACK survive stop; the lease CAS
        // prevents this completion from overwriting a reclaimed inbox attempt.
        inbox.finish(row, 'done');
        lastError = '';
      } catch (error) {
        if (completed) throw error;
        if (signal?.aborted) break;
        if (error.status === 429) pacing.pause(error.retryAfter);
        const permanent = [400, 401, 403, 404, 409, 410].includes(error.status);
        const delay =
          error.status === 429
            ? Math.min(3600, Math.max(1, error.retryAfter || 30)) * 1000
            : Math.min(300000, 5000 * 2 ** Math.min(6, row.attempt - 1));
        inbox.finish(row, permanent || row.attempt >= 10 ? 'failed' : 'pending', clock() + delay);
        lastError = 'Не удалось обработать событие MAX; результат записи сохранён.';
      }
    }
  }
  async function drainStaff(signal, active, proof, managed = false) {
    if (staffDelivery && active())
      await (managed && staffDelivery.tickManaged ? staffDelivery.tickManaged : staffDelivery.tick)(
        signal,
        active,
        5,
        () => active() && proof.verify() && active(),
      );
  }
  function managedTick() {
    if (!ready() || !running || !canRun()) return;
    const epoch = generation,
      signal = controller.signal;
    const lifetime = () => running && epoch === generation && !signal.aborted && canRun();
    const failed = () => {
      if (epoch === generation && running && !signal.aborted)
        lastError = 'Обработка MAX временно недоступна.';
    };
    deliveryLoops.start(
      'lease',
      async () => {
        const proof = await runBackgroundWork(
          () => (lifetime() ? lease.ensure() : null),
          '',
          lifetime,
        );
        if (!proof || !lifetime()) return;
        const active = () => lifetime() && proof();
        deliveryLoops.start('inbox', () => drainInbox(signal, active, proof, true), failed);
        deliveryLoops.start('staff', () => drainStaff(signal, active, proof, true), failed);
      },
      failed,
    );
  }
  function start() {
    if (!ready() || running) return;
    generation++;
    running = true;
    controller = new AbortController();
    const drain = () => {
      try {
        managedTick();
      } catch {
        lastError = 'Обработка MAX временно недоступна.';
      }
    };
    drain();
    timer = setInterval(drain, 500);
    timer.unref?.();
  }
  function stop() {
    generation++;
    running = false;
    clearInterval(timer);
    controller?.abort();
    staffDelivery?.close?.();
    if (ready()) lease.release();
  }
  const status = () => ({ configured: ready(), running, error: lastError });
  return { authenticate, accept, tick, start, stop, status };
}
module.exports = { createMaxRuntime };
