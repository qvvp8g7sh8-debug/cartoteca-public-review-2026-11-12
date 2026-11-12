const { fail } = require('../../../shared/errors.cjs');
function cancelled() {
  return Object.assign(fail(502, 'Ответ помощника прерван. Начните новую команду.'), {
    code: 'ASSISTANT_REQUEST_ABORTED',
  });
}
function signalError(signal) {
  return signal?.reason instanceof Error && signal.reason.status ? signal.reason : cancelled();
}
function assertSignal(signal) {
  if (signal?.aborted) throw signalError(signal);
}
function assertTransport(c) {
  assertSignal(c.transportAbortSignal);
}
function disposeBody(response) {
  try {
    Promise.resolve(response?.body?.cancel?.()).catch(() => {});
  } catch {}
}
// A stubborn provider may settle after cancellation; its late body is discarded separately.
function waitForAbort(promise, signal, { onAbort, onLate } = {}) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    let finished = false;
    const cleanup = () => signal.removeEventListener('abort', aborted);
    const late = (value) => {
      try {
        Promise.resolve(onLate?.(value)).catch(() => {});
      } catch {}
    };
    const aborted = () => {
      if (finished) return;
      finished = true;
      cleanup();
      try {
        onAbort?.();
      } catch {}
      reject(signalError(signal));
    };
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    Promise.resolve(promise).then(
      (value) => {
        if (finished) return late(value);
        finished = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(error);
      },
    );
  });
}
async function bufferedRequest(c, bytes, handle) {
  const controller = new AbortController();
  const abort = () => controller.abort(cancelled());
  const requestClosed = () => {
    if (!c.req?.complete) abort();
  };
  const responseClosed = () => {
    if (!c.res?.writableFinished) abort();
  };
  const owned = { ...c, transportAbortSignal: controller.signal };
  c.req?.on?.('aborted', abort);
  c.req?.on?.('close', requestClosed);
  c.res?.on?.('close', responseClosed);
  if (c.req?.aborted || (c.req?.destroyed && !c.req?.complete) || c.res?.destroyed) abort();
  try {
    assertTransport(owned);
    const body = await waitForAbort(c.readBody(c.req, bytes), controller.signal);
    assertTransport(owned);
    const reply = await handle(owned, body);
    assertTransport(owned);
    if (!c.res?.destroyed && !c.res?.writableEnded) return c.json(c.res, 200, reply);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    c.req?.removeListener?.('aborted', abort);
    c.req?.removeListener?.('close', requestClosed);
    c.res?.removeListener?.('close', responseClosed);
  }
}
module.exports = {
  cancelled,
  signalError,
  assertSignal,
  assertTransport,
  disposeBody,
  waitForAbort,
  bufferedRequest,
};
