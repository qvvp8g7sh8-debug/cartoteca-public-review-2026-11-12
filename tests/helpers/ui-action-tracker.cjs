const { performance } = require('node:perf_hooks');

const bodyMethods = new Set(['json', 'text', 'arrayBuffer', 'blob', 'formData', 'bytes']);
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// Test-only observer. Never captures bodies, headers, query strings or error text.
function createUiActionTracker({ window, fetch: transport, networkMs = 20000, uiMs = 5000 }) {
  const active = new Set();
  let sequence = 0, observing = null, closing = false;
  const pathname = (input) => new URL(typeof input === 'string' ? input : input.url, window.location.href).pathname;
  function complete(record) {
    if (!active.delete(record)) return;
    record.unlink();
    record.done.resolve();
  }
  function observe(record, phase) {
    const operation = record.operation;
    if (!operation || operation.finished) return;
    operation.times[phase] = Math.round(performance.now() - operation.started);
    if (phase === 'body') operation.waitForUi();
  }
  function fail(record, phase) {
    record.operation?.fail(phase);
    complete(record);
  }
  function wrapResponse(response, record) {
    return new Proxy(response, {
      get(target, name) {
        const value = Reflect.get(target, name, target);
        if (bodyMethods.has(name) && typeof value === 'function') return (...args) => {
          record.bodyStarted = true;
          return Promise.resolve().then(() => value.apply(target, args)).then((result) => {
            observe(record, 'body');
            complete(record);
            return result;
          }, (error) => { fail(record, 'body'); throw error; });
        };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  function trackedFetch(input, options = {}) {
    if (closing) return Promise.reject(new DOMException('Test fixture closed', 'AbortError'));
    const controller = new AbortController(), upstream = options.signal || input?.signal;
    const abort = () => controller.abort();
    upstream?.addEventListener('abort', abort, { once: true });
    if (upstream?.aborted) abort();
    const record = { id: ++sequence, method: String(options.method || input?.method || 'GET').toUpperCase(),
      path: pathname(input), controller, done: deferred(), bodyStarted: false,
      unlink: () => upstream?.removeEventListener('abort', abort) };
    active.add(record);
    if (observing && observing.method === record.method && observing.path === record.path) {
      if (observing.record) observing.fail('ambiguous-request');
      else {
        record.operation = observing;
        observing.record = record;
        observe(record, 'request');
      }
    }
    return Promise.resolve().then(() => transport(input, { ...options, signal: controller.signal })).then((response) => {
      record.response = response;
      observe(record, 'response');
      if (record.operation && response.status !== record.operation.status) record.operation.fail('status');
      if (closing && !record.bodyStarted) {
        // The caller may still consume it; cancellation completes before DOM disposal.
        Promise.resolve(response.body?.cancel()).then(() => complete(record), () => complete(record));
      }
      return wrapResponse(response, record);
    }, (error) => { fail(record, controller.signal.aborted ? 'abort' : 'transport'); throw error; });
  }
  function action({ method, path, trigger, ready, status = 200 }) {
    if (closing || observing) throw Error('UI action tracker is closed or already observing an action');
    let resolve, reject, timer, observer;
    const result = new Promise((done, failed) => { resolve = done; reject = failed; });
    const operation = { method: method.toUpperCase(), path: pathname(path), status,
      started: performance.now(), times: {}, finished: false, record: null };
    const finish = (error) => {
      if (operation.finished) return;
      operation.finished = true;
      clearTimeout(timer);
      observer?.disconnect();
      if (observing === operation) observing = null;
      if (error) reject(error);
      else resolve({ requestId: operation.record.id, timingsMs: { ...operation.times } });
    };
    operation.fail = (phase) => {
      const error = new Error('UI action failed at ' + phase);
      error.code = 'UI_ACTION_' + phase.replaceAll('-', '_').toUpperCase();
      error.diagnostic = { phase, method: operation.method, requestId: operation.record?.id ?? null,
        elapsedMs: Math.round(performance.now() - operation.started), timingsMs: { ...operation.times } };
      finish(error);
    };
    operation.waitForUi = () => {
      clearTimeout(timer);
      const check = () => {
        if (operation.finished) return;
        try {
          if (ready()) { operation.times.ui = Math.round(performance.now() - operation.started); finish(); }
        } catch { operation.fail('ui-condition'); }
      };
      observer = new window.MutationObserver(check);
      observer.observe(window.document, { subtree: true, childList: true, attributes: true, characterData: true });
      timer = setTimeout(() => operation.fail('ui-timeout'), uiMs);
      // The application receives and processes the body before checking its UI.
      queueMicrotask(check);
    };
    observing = operation;
    timer = setTimeout(() => operation.fail(operation.record ? 'network-timeout' : 'request-timeout'), networkMs);
    try { Promise.resolve(trigger()).catch(() => operation.fail('trigger')); }
    catch { operation.fail('trigger'); }
    return result;
  }
  async function close({ timeoutMs = 5000 } = {}) {
    closing = true;
    observing?.fail('abort');
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error('UI request cleanup timed out; pending=' + active.size)), timeoutMs);
    });
    try {
      for (const record of active) {
        record.controller.abort();
        if (record.response && !record.bodyStarted)
          Promise.resolve(record.response.body?.cancel()).then(() => complete(record), () => complete(record));
      }
      await Promise.race([Promise.all([...active].map((record) => record.done.promise)), timeout]);
      // Drain continuations/handled rejection callbacks while the DOM still exists.
      await tick();
      await tick();
    } finally { clearTimeout(timer); }
  }
  return { fetch: trackedFetch, action, close, pending: () => active.size };
}
module.exports = { createUiActionTracker };
