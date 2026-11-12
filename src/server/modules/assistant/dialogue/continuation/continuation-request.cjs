const { fail } = require('../../../../../shared/errors.cjs');
const {
  cancelled,
  assertSignal,
  assertTransport,
  waitForAbort,
} = require('../../buffered-request.cjs');
function createContinuationRequest({ hash, expiresAt, remove }) {
  const controller = new AbortController(),
    waiters = new Set();
  const record = {
    hash,
    expiresAt,
    pending: true,
    outbound: false,
    error: null,
    usage: null,
    promise: null,
  };
  function cancel(error = cancelled()) {
    if (!record.pending) return;
    record.pending = false;
    record.error = error;
    controller.abort(error);
    if (!record.outbound) remove(record);
  }
  function check() {
    assertSignal(controller.signal);
  }
  function start(work) {
    record.promise = Promise.resolve().then(async () => {
      try {
        check();
        const result = await work();
        check();
        record.pending = false;
        remove(record);
        return result;
      } catch (error) {
        record.pending = false;
        if (record.outbound) record.error ||= error;
        else remove(record);
        throw record.error || error;
      }
    });
    // Every waiter may disconnect before the shared operation has settled.
    record.promise.catch(() => {});
  }
  async function wait(c) {
    assertTransport(c);
    if (record.error) throw record.error;
    if (waiters.size >= 16)
      throw fail(429, 'Слишком много ожидающих уточнение запросов. Дождитесь ответа.');
    const token = {};
    waiters.add(token);
    try {
      const result = await waitForAbort(record.promise, c.transportAbortSignal);
      assertTransport(c);
      return result;
    } finally {
      waiters.delete(token);
      if (record.pending && !waiters.size) cancel();
    }
  }
  return Object.assign(record, {
    cancel,
    check,
    start,
    wait,
    context(c) {
      return { ...c, transportAbortSignal: controller.signal };
    },
  });
}
module.exports = { createContinuationRequest };
