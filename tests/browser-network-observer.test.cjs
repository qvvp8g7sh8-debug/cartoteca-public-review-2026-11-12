const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { observeNetwork } = require('./browser/network-observer.cjs');
class Page extends EventEmitter {
  constructor() {
    super();this.closed = false;this.evaluateCalls = 0;this.listeners = new Map();
    this.window = {
      location: { href: this.url() }, document: {},
      addEventListener: (type, callback) => {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(callback);
      },
      removeEventListener: (type, callback) => this.listeners.get(type)?.delete(callback),
    };
    this.world = vm.createContext({ window: this.window, Promise });
  }
  url() { return 'http://synthetic.test/?session=PRIVATE'; }
  isClosed() { return this.closed; }
  async exposeBinding(name, callback) {
    this.binding = callback;
    this.window[name] = (event) => callback({ frame: { url: () => this.url() } }, event);
  }
  async addInitScript(callback) { this.init = callback; }
  async evaluate(callback) {
    this.evaluateCalls++;
    return vm.runInContext('(' + callback.toString() + ')()', this.world);
  }
  dispatch(type) { for (const callback of this.listeners.get(type) || []) callback(); }
}
const request = (pathname, failure = null) => ({
  url: () => 'http://synthetic.test' + pathname,
  method: () => 'GET', failure: () => failure,
});
test('diagnostics retain genuine page errors, server failures and canceled requests without changing strict failures', async () => {
  const page = new Page(), errors = [], badResponses = [], external = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => { if (response.status() >= 500) badResponses.push(response.url()); });
  let time = 100;
  const observer = await observeNetwork(page, { base: 'http://synthetic.test', now: () => time });
  observer.setScenario('settings');time = 125;
  const error = new TypeError('Failure at http://user:password@synthetic.test/app.js?token=PRIVATE');
  error.stack = 'TypeError: Failure\n at http://synthetic.test/app.js?secret=PRIVATE:1:2';
  page.emit('pageerror', error);
  const req = request('/api/online-booking/health?token=PRIVATE', { errorText: 'Load canceled' });
  page.emit('request', req);
  page.emit('response', { request: () => req, url: req.url, status: () => 500 });
  page.emit('requestfailed', req);
  assert.deepEqual(errors, [error.message]);
  assert.deepEqual(badResponses, [req.url()]);
  assert.equal(!errors.length && !badResponses.length && !external.length, false);
  const detail = observer.events.find((event) => event.type === 'pageerror');
  assert.equal(detail.error.name, 'TypeError');assert.equal(detail.scenario, 'settings');assert.equal(detail.elapsedMs, 25);
  assert.match(detail.error.stack, /TypeError: Failure/);
  assert.equal(observer.events.find((event) => event.type === 'response').status, 500);
  assert.equal(observer.events.find((event) => event.type === 'requestfailed').failure, 'Load canceled');
  assert.ok(!JSON.stringify(observer.events).includes('PRIVATE'));
  assert.ok(!JSON.stringify(observer.events).includes('password'));
});
test('request correlation survives functional scenario changes and lifecycle evidence excludes URL query data', async () => {
  const page = new Page();
  const observer = await observeNetwork(page, { base: 'http://synthetic.test' });
  observer.setScenario('login');
  const req = request('/api/online-booking/requests/summary?secret=PRIVATE');
  page.emit('request', req);
  observer.setScenario('public-booking-real-backend');
  page.emit('response', { request: () => req, status: () => 200 });
  page.emit('requestfinished', req);
  await page.binding({ frame: { url: page.url } }, { type: 'pagehide', url: page.url() });
  assert.deepEqual(observer.events.slice(0, 3).map((event) => event.id), [1, 1, 1]);
  assert.equal(observer.events[0].scenario, 'login');
  assert.equal(observer.events[2].scenario, 'public-booking-real-backend');
  assert.equal(observer.events[3].type, 'pagehide');
  assert.deepEqual(observer.events[3].document, { origin: 'http://synthetic.test', pathname: '/' });
  assert.equal(typeof page.init, 'function');
  assert.ok(!JSON.stringify(observer.events).includes('PRIVATE'));
});

test('fake DOM-ready delivery restores cleared lifecycle listeners without duplicates or teardown errors', async () => {
  const page = new Page();
  const observer = await observeNetwork(page, { base: 'http://synthetic.test' });
  await page.evaluate(page.init);
  const document = page.window.document;
  const original = page.window.__cartotecaNetworkLifecycle.beforeunload;
  page.dispatch('beforeunload');
  assert.equal(observer.events.filter((event) => event.type === 'beforeunload').length, 1);
  page.listeners.clear(); // document.open/write removed listeners, keeping the same Window/document.
  page.emit('domcontentloaded');await Promise.resolve();
  assert.equal(page.window.document, document);
  assert.equal(page.window.__cartotecaNetworkLifecycle.beforeunload, original);
  assert.equal(page.listeners.get('beforeunload').size, 1);
  assert.equal(page.listeners.get('pagehide').size, 1);
  page.emit('domcontentloaded');await Promise.resolve();
  assert.equal(page.listeners.get('beforeunload').size, 1);
  page.dispatch('pagehide');
  assert.equal(observer.events.filter((event) => event.type === 'pagehide').length, 1);
  page.window.__cartotecaNetworkObservation = () => undefined;
  assert.doesNotThrow(() => page.dispatch('beforeunload'));
  page.window.__cartotecaNetworkObservation = () => Promise.reject(Error('Observation context closed'));
  assert.doesNotThrow(() => page.dispatch('pagehide'));await Promise.resolve();
  page.window.__cartotecaNetworkObservation = () => { throw Error('Observation binding removed'); };
  assert.doesNotThrow(() => page.dispatch('beforeunload'));
  const calls = page.evaluateCalls;
  page.closed = true;page.emit('domcontentloaded');await Promise.resolve();
  assert.equal(page.evaluateCalls, calls, 'Closed pages must not be evaluated');
});

test('same-origin app.js completion restores erased listeners without adding target requests or duplicate callbacks', async () => {
  const page = new Page();
  const observer = await observeNetwork(page, { base: 'http://synthetic.test' });
  await page.evaluate(page.init);
  const callbacks = { ...page.window.__cartotecaNetworkLifecycle };
  page.listeners.clear();
  page.emit('requestfinished', request('/app.js?v=PRIVATE'));await Promise.resolve();
  assert.equal(page.window.__cartotecaNetworkLifecycle.beforeunload, callbacks.beforeunload);
  assert.equal(page.window.__cartotecaNetworkLifecycle.pagehide, callbacks.pagehide);
  assert.equal(page.listeners.get('beforeunload').size, 1);
  assert.equal(page.listeners.get('pagehide').size, 1);
  assert.equal(observer.events.length, 0, 'The main script is not a target API request');
  page.emit('requestfinished', request('/app.js?v=PRIVATE'));await Promise.resolve();
  assert.equal(page.listeners.get('beforeunload').size, 1);
  page.dispatch('beforeunload');page.dispatch('pagehide');
  assert.equal(observer.events.filter((event) => event.type === 'beforeunload').length, 1);
  assert.equal(observer.events.filter((event) => event.type === 'pagehide').length, 1);
  const calls = page.evaluateCalls;
  page.emit('requestfinished', { url: () => 'http://foreign.test/app.js' });await Promise.resolve();
  assert.equal(page.evaluateCalls, calls, 'A foreign script cannot trigger reattachment');
});
