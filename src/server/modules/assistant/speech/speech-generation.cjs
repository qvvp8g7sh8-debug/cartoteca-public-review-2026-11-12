const { fail } = require('../../../../shared/errors.cjs');
const { assertSignal, signalError, waitForAbort } = require('../buffered-request.cjs');
// One paid generic generation is independent of the first HTTP response. Only
// the original response receives progressive chunks; followers await validated EOF.
function createSpeechGeneration({ timeoutMs, run, complete, failed }) {
  const controller = new AbortController(),
    waiters = new Set();
  let primary,
    promise,
    timer,
    pending = true,
    outbound = false;
  const stop = (error) => {
    if (pending && !controller.signal.aborted) controller.abort(error);
  };
  function detach(waiter, error) {
    if (!waiters.delete(waiter)) return;
    if (primary === waiter) primary = null;
    waiter.output.signal.removeEventListener('abort', waiter.aborted);
    if (error && !waiter.controller.signal.aborted) waiter.controller.abort(error);
    if (pending && !waiters.size) stop(error || fail(499, 'Озвучивание остановлено.'));
  }
  function check() {
    assertSignal(controller.signal);
    for (const waiter of [...waiters]) {
      try {
        waiter.output.check();
      } catch (error) {
        detach(waiter, error);
      }
    }
    assertSignal(controller.signal);
    if (!waiters.size) throw fail(499, 'Озвучивание остановлено.');
  }
  const output = {
    signal: controller.signal,
    check,
    wait(value, options) {
      assertSignal(controller.signal);
      return waitForAbort(value, controller.signal, options);
    },
    async write(bytes) {
      // The primary output authorizes immediately before its actual bytes.
      // Recheck every remaining waiter after its asynchronous write completes.
      assertSignal(controller.signal);
      const target = primary;
      if (target && waiters.has(target)) {
        try {
          await waitForAbort(target.output.write(bytes), controller.signal);
        } catch (error) {
          // A closed, revoked or stalled first response must not deny a live follower.
          detach(target, error);
        }
      }
      check();
    },
  };
  return {
    attach(clientOutput, progressive = false) {
      assertSignal(controller.signal);
      clientOutput.check();
      if (waiters.size >= 16)
        throw fail(429, 'Слишком много ожидающих озвучивание запросов. Повторите позже.');
      const waiter = { output: clientOutput, controller: new AbortController() };
      waiter.aborted = () => detach(waiter, signalError(clientOutput.signal));
      waiters.add(waiter);
      if (progressive) primary = waiter;
      clientOutput.signal.addEventListener('abort', waiter.aborted, { once: true });
      if (clientOutput.signal.aborted) waiter.aborted();
      return {
        async wait() {
          try {
            const result = await waitForAbort(promise, waiter.controller.signal);
            clientOutput.check();
            return result;
          } finally {
            detach(waiter);
          }
        },
        dispose() {
          detach(waiter);
        },
      };
    },
    start() {
      if (promise) return;
      timer = setTimeout(() => stop(fail(502, 'Истекло время озвучивания.')), timeoutMs);
      promise = Promise.resolve().then(async () => {
        try {
          check();
          const result = await run(output, () => {
            check();
            outbound = true;
          });
          check();
          const completed = complete(result);
          if (completed && typeof completed.then === 'function') await completed;
          pending = false;
          return result;
        } catch (error) {
          pending = false;
          const rejected = failed(error, outbound);
          if (rejected && typeof rejected.then === 'function') await rejected;
          throw error;
        } finally {
          clearTimeout(timer);
        }
      });
      // A final waiter may leave before a stubborn upstream settles.
      promise.catch(() => {});
    },
  };
}
module.exports = { createSpeechGeneration };
