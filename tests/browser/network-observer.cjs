// Diagnostic evidence only: the runner retains its original strict failure arrays and criteria.
async function observeNetwork(page, { base, now = () => performance.now() }) {
  const events = [], started = now(), ids = new WeakMap();
  let scenario = null, sequence = 0;
  const targets = new Set(['/api/online-booking/health', '/api/online-booking/requests/summary']);
  const baseOrigin = new URL(base).origin;
  function safeUrl(value) {
    try {
      const url = new URL(value, base);
      return { origin: url.origin, pathname: url.pathname };
    } catch {
      return null;
    }
  }
  const safeText = (value) => String(value || '').replace(/https?:\/\/[^\s"'<>]+/g, (value) => {
    const url = safeUrl(value);
    return url ? url.origin + url.pathname : '[invalid URL]';
  });
  const record = (type, details) => events.push({
    type, elapsedMs: Math.max(0, Math.round(now() - started)), scenario,
    page: safeUrl(page.url()), ...details,
  });
  const target = (request) => targets.has(safeUrl(request.url())?.pathname);
  const requestInfo = (request) => ({ id: ids.get(request), method: request.method(), url: safeUrl(request.url()) });
  page.on('pageerror', (error) => record('pageerror', {
    error: { name: safeText(error.name), message: safeText(error.message), stack: safeText(error.stack) },
  }));
  page.on('request', (request) => {
    if (!target(request)) return;
    ids.set(request, ++sequence);
    record('request', requestInfo(request));
  });
  page.on('response', (response) => {
    const request = response.request();
    if (target(request)) record('response', { ...requestInfo(request), status: response.status() });
  });
  page.on('requestfinished', (request) => {
    const url = safeUrl(request.url());
    if (url?.origin === baseOrigin && url.pathname === '/app.js') rebindLifecycle();
    if (target(request)) record('requestfinished', requestInfo(request));
  });
  page.on('requestfailed', (request) => {
    if (target(request)) record('requestfailed', {
      ...requestInfo(request), failure: safeText(request.failure()?.errorText),
    });
  });
  await page.exposeBinding('__cartotecaNetworkObservation', ({ frame }, event) => {
    if (event.type === 'beforeunload' || event.type === 'pagehide')
      record(event.type, { document: safeUrl(event.url), frame: safeUrl(frame.url()) });
  });
  function installLifecycleObserver() {
    const callbacks = (window.__cartotecaNetworkLifecycle ||= Object.create(null));
    for (const type of ['beforeunload', 'pagehide']) {
      const callback = (callbacks[type] ||= () => {
        const deliver = window.__cartotecaNetworkObservation;
        if (typeof deliver !== 'function') return;
        try {
          void Promise.resolve(deliver({ type, url: window.location.href })).catch(() => {});
        } catch {} // Observation delivery must not introduce a page error during teardown.
      });
      window.removeEventListener(type, callback);
      window.addEventListener(type, callback);
    }
  }
  await page.addInitScript(installLifecycleObserver);
  function rebindLifecycle() {
    if (page.isClosed()) return;
    try {
      void Promise.resolve(page.evaluate(installLifecycleObserver)).catch(() => {});
    } catch {} // A page may close between isClosed() and evaluate().
  }
  // document.write may erase Window listeners without a reliable WebKit DOM-ready event.
  // The same-origin main bundle finishing supplies a second Node-side attachment signal.
  page.on('domcontentloaded', rebindLifecycle);
  return { events, setScenario(value) { scenario = value; } };
}
module.exports = { observeNetwork };
