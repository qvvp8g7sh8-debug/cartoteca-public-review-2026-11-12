const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../src/client/core/deferred-settings.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  dispatch(type) { for (const fn of [...(this.listeners.get(type) || [])]) fn(); }
  count(type) { return this.listeners.get(type)?.size || 0; }
}
function fixture(t) {
  let next = 0;
  const frames = new Map(), idle = new Map(), timers = new Map(), imports = [], installed = [], notices = [];
  const document = Object.assign(new Target(), { hidden: false,
    querySelector: () => ({ content: 'synthetic-release' }) });
  const window = Object.assign(new Target(), {
    requestAnimationFrame(fn) { frames.set(++next, fn); return next; },
    cancelAnimationFrame(id) { frames.delete(id); },
    requestIdleCallback(fn) { idle.set(++next, fn); return next; },
    cancelIdleCallback(id) { idle.delete(id); },
  });
  const state = { account: { id: 'synthetic-account' }, settingsReady: false, settingsBundleId: 'synthetic-bundle' };
  const factory = vm.runInNewContext(source + '\ncreateDeferredSettings', {
    document, window, AbortController,
    setTimeout(fn, delay) { timers.set(++next, { fn, delay }); return next; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async () => ({ status: 200 }),
  });
  const api = factory(state, { toast: (message) => notices.push(message) }, (module) => installed.push(module),
    (url) => { let resolve; const promise = new Promise((done) => { resolve = done; });
      imports.push({ url, resolve }); return promise; });
  const take = (queue) => {
    const row = queue.entries().next().value;
    if (!row) return false;
    queue.delete(row[0]); row[1](); return true;
  };
  const paint = () => { take(frames); take(frames); };
  const snapshot = () => [...frames.values(), ...idle.values(), ...[...timers.values()].map((row) => row.fn)];
  const queued = () => frames.size + idle.size + timers.size;
  const complete = () => { for (const row of imports) row.resolve({ bundleId: state.settingsBundleId }); };
  t.after(async () => { window.dispatch('pagehide'); complete(); await flush(); });
  return { api, state, document, window, frames, idle, timers, imports, installed, notices, paint,
    queued, snapshot, complete,
    hide() { document.hidden = true; document.dispatch('visibilitychange'); },
    show() { document.hidden = false; document.dispatch('visibilitychange'); },
    async drain() { paint(); for (let i = 0; i < 4 && take(idle); i++) await flush(); await flush(); },
    fallback() { const row = [...timers].find(([, value]) => value.delay === 1500);
      assert.ok(row); timers.delete(row[0]); row[1].fn(); },
  };
}

test('hidden settings autoload has one visibility owner and starts once after visible paints', async (t) => {
  const f = fixture(t);
  f.hide();
  for (let i = 0; i < 20; i++) f.api.scheduleSettingsLoad();
  assert.equal(f.imports.length, 0);
  assert.equal(f.queued(), 0);
  assert.equal(f.document.count('visibilitychange'), 1);
  f.show();
  await f.drain();
  assert.equal(f.imports.length, 1);
  f.complete(); await flush();
  assert.equal(f.installed.length, 1);
  assert.equal(f.document.count('visibilitychange'), 0);
  assert.equal(f.queued(), 0);
});

for (const phase of ['paint', 'fallback', 'idle']) {
  test(`settings autoload hidden during queued ${phase} cancels jobs until a fresh visible schedule`, async (t) => {
    const f = fixture(t);
    f.api.scheduleSettingsLoad();
    if (phase === 'idle') f.paint();
    if (phase === 'fallback') f.fallback();
    const obsolete = f.snapshot();
    assert.ok(obsolete.length > 0);
    f.hide();
    assert.equal(f.queued(), 0, 'Queued browser work must be disposed when hidden');
    for (const fn of obsolete) fn();
    await flush();
    assert.equal(f.imports.length, 0, 'Forcibly delivered obsolete work must not import hidden settings');
    assert.equal(f.queued(), 0);
    assert.equal(f.document.count('visibilitychange'), 1);
    f.show();
    await f.drain();
    assert.equal(f.imports.length, 1);
    f.complete(); await flush();
    assert.equal(f.installed.length, 1);
    assert.equal(f.queued(), 0);
  });
}

test('settings pagehide disposes queued callbacks; pageshow resumes exactly one current autoload', async (t) => {
  const f = fixture(t);
  f.api.scheduleSettingsLoad();
  f.paint();
  const obsolete = f.snapshot();
  f.window.dispatch('pagehide');
  assert.equal(f.queued(), 0);
  assert.equal(f.document.count('visibilitychange'), 0);
  for (const fn of obsolete) fn();
  await flush();
  assert.equal(f.imports.length, 0);
  f.window.dispatch('pageshow'); f.window.dispatch('pageshow');
  await f.drain();
  assert.equal(f.imports.length, 1);
  f.complete(); await flush();
  assert.equal(f.installed.length, 1);
  assert.equal(f.queued(), 0);
});

test('stale visible-phase callbacks cannot steal a newly scheduled paint or create duplicate imports', async (t) => {
  const f = fixture(t);
  f.api.scheduleSettingsLoad();
  f.paint();
  const stale = f.snapshot();
  f.hide(); f.show();
  for (const fn of stale) fn();
  await flush();
  assert.equal(f.imports.length, 0, 'Old idle callback cannot bypass fresh visible paints');
  await f.drain();
  assert.equal(f.imports.length, 1);
  f.complete(); await flush();
  assert.equal(f.installed.length, 1);
  assert.equal(f.queued(), 0);
});

test('repeated settings hide/show transitions retain bounded work and a single visibility callback', async (t) => {
  const f = fixture(t);
  f.api.scheduleSettingsLoad();
  for (let i = 0; i < 20; i++) {
    f.hide();
    assert.equal(f.queued(), 0);
    assert.equal(f.document.count('visibilitychange'), 1);
    f.show();
    f.api.scheduleSettingsLoad();
    assert.ok(f.queued() <= 3);
    assert.equal(f.imports.length, 0);
  }
  await f.drain();
  assert.equal(f.imports.length, 1);
  f.complete(); await flush();
  assert.equal(f.document.count('visibilitychange'), 0);
  assert.equal(f.queued(), 0);
});

test('explicit ensureSettings keeps its existing API while hidden; deferred scheduling adds no second import', async (t) => {
  const f = fixture(t);
  f.hide();
  const pending = f.api.ensureSettings();
  assert.equal(f.imports.length, 1);
  f.api.scheduleSettingsLoad();
  f.complete();
  await pending;
  f.show();
  await f.drain();
  assert.equal(f.installed.length, 1);
  assert.equal(f.imports.length, 1);
  assert.equal(f.queued(), 0);
});
