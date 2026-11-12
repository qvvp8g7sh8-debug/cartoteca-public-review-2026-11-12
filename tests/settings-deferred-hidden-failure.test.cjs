const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../src/client/core/deferred-settings.js'), 'utf8');
const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }
  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
  dispatch(name) { for (const listener of [...(this.listeners.get(name) || [])]) listener(); }
  count(name) { return this.listeners.get(name)?.size || 0; }
}
function fixture(t) {
  let next = 0, release = 'synthetic-release-one', headStatus = 200, delayHead = false;
  const frames = new Map(), idle = new Map(), timers = new Map();
  const loads = [], heads = [], installed = [], notices = [];
  const state = { account: { id: 'synthetic-owner', organizationId: 'synthetic-org' },
    settingsReady: false, settingsBundleId: 'synthetic-bundle-one' };
  const document = Object.assign(new Target(), {
    hidden: false, querySelector: () => ({ content: release }),
  });
  const window = Object.assign(new Target(), {
    requestAnimationFrame(callback) { frames.set(++next, callback); return next; },
    cancelAnimationFrame(id) { frames.delete(id); },
    requestIdleCallback(callback) { idle.set(++next, callback); return next; },
    cancelIdleCallback(id) { idle.delete(id); },
  });
  const factory = vm.runInNewContext(source + '\ncreateDeferredSettings', {
    document, window, AbortController,
    setTimeout(callback, delay) { timers.set(++next, { callback, delay }); return next; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options) => {
      const delivery = deferred(), row = { url, options, ...delivery };
      heads.push(row);
      if (!delayHead) return { status: headStatus };
      const aborted = () => delivery.reject(Error('Synthetic diagnostic abort'));
      options.signal.addEventListener('abort', aborted, { once: true });
      if (options.signal.aborted) aborted();
      try { return await delivery.promise; }
      finally { options.signal.removeEventListener('abort', aborted); }
    },
  });
  const api = factory(state, { toast: message => notices.push(message) },
    module => installed.push(module), url => {
      const value = deferred(); loads.push({ url, ...value }); return value.promise;
    });
  const take = queue => {
    const value = queue.entries().next().value;
    assert.ok(value, 'Expected queued browser callback');
    queue.delete(value[0]); value[1]();
  };
  const hide = () => { document.hidden = true; document.dispatch('visibilitychange'); };
  const leave = () => window.dispatch('pagehide');
  t.after(async () => {
    leave();
    for (const load of loads) load.resolve({ bundleId: state.settingsBundleId });
    for (const head of heads) head.resolve({ status: headStatus });
    await flush();
  });
  return { api, state, document, window, loads, heads, installed, notices, timers, hide, leave,
    setHeadStatus(status) { headStatus = status; },
    deferHead() { delayHead = true; },
    show() { document.hidden = false; document.dispatch('visibilitychange'); },
    async drainQueuedAutoload() { take(frames); take(frames); take(idle); await flush(); },
    setRelease(value) { release = value; },
    async startAutoload() {
      api.scheduleSettingsLoad(); take(frames); take(frames); take(idle); await flush();
      assert.equal(loads.length, 1); assert.equal(heads.length, 0); assert.equal(notices.length, 0);
    },
    expireImport() {
      const entry = [...timers].find(([, row]) => row.delay === 15000);
      assert.ok(entry, 'Expected the active import waiter deadline');
      timers.delete(entry[0]); entry[1].callback();
    },
  };
}

for (const ending of ['hidden', 'pagehide']) {
  test('passive settings import rejected after ' + ending + ' starts no diagnostic HEAD or stale toast', async t => {
    const f = fixture(t); await f.startAutoload();
    if (ending === 'hidden') f.hide(); else f.leave();
    f.loads[0].reject(Error('Synthetic late transport failure')); await flush();
    assert.equal(f.installed.length, 0); assert.equal(f.state.settingsReady, false);
    assert.equal(f.heads.length, 0, 'An abandoned passive load must not start a new offscreen diagnostic request');
    assert.equal(f.notices.length, 0, 'An abandoned passive load must not show an obsolete error toast');
    assert.equal(f.loads.length, 1, 'Failure handling must not launch a hidden replacement import');
  });
}

for (const changed of ['account', 'logout', 'bundle', 'release']) {
  test('passive settings failure from an obsolete ' + changed + ' context cannot diagnose or notify the new context', async t => {
    const f = fixture(t); await f.startAutoload();
    if (changed === 'account') f.state.account = { id: 'other-synthetic-owner', organizationId: 'other-synthetic-org' };
    if (changed === 'logout') f.state.account = null;
    if (changed === 'bundle') f.state.settingsBundleId = 'synthetic-bundle-two';
    if (changed === 'release') f.setRelease('synthetic-release-two');
    f.loads[0].reject(Error('Synthetic obsolete import failure')); await flush();
    assert.equal(f.heads.length, 0, 'A stale load failure cannot begin diagnosis in a replacement scope');
    assert.equal(f.notices.length, 0, 'No stale-session or stale-release toast may escape its load context');
    assert.equal(f.installed.length, 0); assert.equal(f.state.settingsReady, false);
  });
}

test('current visible passive failures retain ordinary diagnosis and actionable messages', async t => {
  for (const [status, expected] of [[200, /повторить загрузку/], [401, /Сессия завершилась/], [409, /Версия приложения обновилась/]]) {
    await t.test('diagnostic HTTP ' + status, async sub => {
      const f = fixture(sub); f.setHeadStatus(status); await f.startAutoload();
      f.loads[0].reject(Error('Synthetic current import failure')); await flush();
      assert.equal(f.heads.length, 1); assert.equal(f.heads[0].options.method, 'HEAD');
      assert.equal(f.heads[0].options.cache, 'no-store');
      assert.equal(f.heads[0].options.signal.aborted, false);
      assert.equal(f.notices.length, 1); assert.match(f.notices[0], expected);
      assert.equal(f.installed.length, 0); assert.equal(f.state.settingsReady, false);
    });
  }
});

test('a current visible timeout remains retryable and its late old success cannot install over the accepted retry', async t => {
  const f = fixture(t); await f.startAutoload(); f.expireImport(); await flush();
  assert.equal(f.heads.length, 1); assert.equal(f.notices.length, 1);
  const retry = f.api.ensureSettings();
  assert.equal(f.loads.length, 2);
  f.loads[0].resolve({ bundleId: 'synthetic-bundle-one' }); await flush();
  assert.equal(f.installed.length, 0, 'Expired import task may not install after its retry begins');
  f.loads[1].resolve({ bundleId: 'synthetic-bundle-one' }); await retry; await flush();
  assert.equal(f.installed.length, 1); assert.equal(f.state.settingsReady, true);
  assert.equal(f.heads.length, 1); assert.equal(f.notices.length, 1);
});


for (const ending of ['hidden', 'pagehide']) {
  test('pending passive diagnostic is aborted and ownership is cleaned on ' + ending, async t => {
    const f = fixture(t); f.deferHead(); await f.startAutoload();
    f.loads[0].reject(Error('Synthetic current transport failure')); await flush();
    assert.equal(f.heads.length, 1); assert.equal(f.heads[0].options.signal.aborted, false);
    assert.equal(f.window.count('pagehide'), 2, 'One factory owner and one temporary passive-load owner');
    if (ending === 'hidden') f.hide(); else f.leave();
    await flush();
    assert.equal(f.heads[0].options.signal.aborted, true, 'The owned diagnostic transport must be aborted');
    assert.equal(f.notices.length, 0); assert.equal(f.installed.length, 0);
    assert.equal(f.window.count('pagehide'), 1, 'The temporary pending-load pagehide owner must be removed');
    assert.equal(f.document.count('visibilitychange'), ending === 'hidden' ? 1 : 0,
      'Only one queued visible-resume owner may remain after hidden; departed pages own no queued callbacks');
    assert.equal(f.timers.size, 0, 'Import and diagnostic deadlines must not be retained');
    assert.equal(f.loads.length, 1, 'No offscreen retry may begin');
    if (ending === 'hidden') f.show(); else f.window.dispatch('pageshow');
    assert.equal(f.loads.length, 1, 'Resume still waits for visible paints and idle scheduling');
    await f.drainQueuedAutoload();
    assert.equal(f.loads.length, 2, 'One fresh visible autoload resumes after an abandoned passive attempt');
    f.loads[1].resolve({ bundleId: 'synthetic-bundle-one' }); await flush();
    assert.equal(f.installed.length, 1); assert.equal(f.state.settingsReady, true);
    assert.equal(f.document.count('visibilitychange'), 0); assert.equal(f.window.count('pagehide'), 1);
  });
}

test('a diagnostic response cannot notify a replacement account after its own await', async t => {
  const f = fixture(t); f.deferHead(); await f.startAutoload();
  f.loads[0].reject(Error('Synthetic current transport failure')); await flush();
  assert.equal(f.heads.length, 1);
  f.state.account = { id: 'replacement-synthetic-owner', organizationId: 'replacement-synthetic-org' };
  f.heads[0].resolve({ status: 401 }); await flush();
  assert.equal(f.notices.length, 0, 'A late401 must not falsely describe the replacement session');
  assert.equal(f.installed.length, 0); assert.equal(f.loads.length, 1);
  assert.equal(f.window.count('pagehide'), 1); assert.equal(f.document.count('visibilitychange'), 0);
  assert.equal(f.timers.size, 0);
});

test('an explicit current consumer joining passive load retains the actionable diagnosis', async t => {
  const f = fixture(t); f.setHeadStatus(409); await f.startAutoload();
  const joined = f.api.ensureSettings();
  const rejected = assert.rejects(joined, error => error.reloadRequired === true && /Версия приложения обновилась/.test(error.message));
  f.loads[0].reject(Error('Synthetic shared transport failure')); await rejected; await flush();
  assert.equal(f.loads.length, 1, 'Joining navigation must not start a second native import');
  assert.equal(f.heads.length, 1); assert.equal(f.notices.length, 1);
  assert.equal(f.installed.length, 0); assert.equal(f.window.count('pagehide'), 1);
});

test('explicit ensureSettings while hidden keeps manual error diagnosis and never becomes an automatic toast', async t => {
  const f = fixture(t); f.hide(); f.setHeadStatus(401);
  const pending = f.api.ensureSettings();
  const rejected = assert.rejects(pending, error => error.reloadRequired === true && /Сессия завершилась/.test(error.message));
  f.loads[0].reject(Error('Synthetic explicit transport failure')); await rejected; await flush();
  assert.equal(f.heads.length, 1); assert.equal(f.notices.length, 0);
  assert.equal(f.installed.length, 0); assert.equal(f.state.settingsReady, false);
  assert.equal(f.window.count('pagehide'), 1); assert.equal(f.document.count('visibilitychange'), 0);
});

test('pagehide followed by pageshow cannot revive the old passive failure notification', async t => {
  const f = fixture(t); await f.startAutoload();
  f.leave(); f.window.dispatch('pageshow');
  f.loads[0].reject(Error('Synthetic pre-pagehide import failure')); await flush();
  assert.equal(f.heads.length, 0); assert.equal(f.notices.length, 0); assert.equal(f.loads.length, 1);
  await f.drainQueuedAutoload(); assert.equal(f.loads.length, 2);
  f.loads[1].resolve({ bundleId: 'synthetic-bundle-one' }); await flush();
  assert.equal(f.installed.length, 1); assert.equal(f.state.settingsReady, true);
});
