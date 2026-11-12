const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../src/client/core/assistant-host.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
class Target {
  constructor() { this.events = new Map(); }
  addEventListener(type, callback) {
    if (!this.events.has(type)) this.events.set(type, new Set());
    this.events.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.events.get(type)?.delete(callback); }
  count(type) { return this.events.get(type)?.size || 0; }
  dispatch(type) { for (const callback of [...(this.events.get(type) || [])]) callback(); }
}
function fixture(t) {
  let next = 0;
  const frames = new Map(), idle = new Map(), timers = new Map(), imports = [], installed = [], mounted = [];
  const document = Object.assign(new Target(), {
    hidden: false,
    querySelector: () => ({ content: 'synthetic-build' }),
  });
  const window = Object.assign(new Target(), {
    requestAnimationFrame(fn) { frames.set(++next, fn); return next; },
    cancelAnimationFrame: id => frames.delete(id),
    requestIdleCallback(fn) { idle.set(++next, fn); return next; },
    cancelIdleCallback: id => idle.delete(id),
  });
  const factory = vm.runInNewContext(source + '\ncreateAssistantHost', {
    document, window,
    setTimeout(fn) { timers.set(++next, fn); return next; },
    clearTimeout: id => timers.delete(id),
  });
  const state = {
    account: { id: 'synthetic-owner', organizationId: 'org', role: 'owner' },
    multiUser: true, sessionReady: true, assistantGeneration: 0,
    assistantReady: false, assistantScope: null, assistantBundleId: 'synthetic-bundle',
  };
  const api = factory(state, {
    toast() {},
    mountVoiceAssistant() { mounted.push(state.assistantScope.policyVersion); },
    destroyVoiceAssistant() {},
  }, module => installed.push(module), async url => {
    imports.push(url);
    return { bundleId: 'synthetic-bundle' };
  });
  const scope = version => ({ enabled: true, organizationId: 'org', policyVersion: version });
  function take(queue) {
    const next = queue.entries().next().value;
    if (!next) return false;
    queue.delete(next[0]);
    next[1]();
    return true;
  }
  function paint() { for (let i = 0; i < 4 && take(frames); i++); }
  async function drain() {
    paint();
    for (let i = 0; i < 4 && take(idle); i++) await flush();
    await flush();
  }
  api.bindAssistantLifecycle();
  t.after(() => api.resetAssistant());
  return { api, state, scope, document, window, frames, idle, timers, imports, installed, mounted, paint, drain,
    queued: () => frames.size + idle.size + timers.size,
    visible() { document.hidden = false; document.dispatch('visibilitychange'); },
    hidden() { document.hidden = true; document.dispatch('visibilitychange'); },
  };
}

test('repeated hidden grant/revoke disposes obsolete visibility listeners and installs exactly one current generation', async t => {
  const f = fixture(t);
  f.hidden();
  for (let i = 1; i <= 20; i++) {
    f.api.applyAssistantScope(f.scope(i));
    assert.ok(f.document.count('visibilitychange') <= 1, 'at most one owner waits for visible');
    f.api.applyAssistantScope({ enabled: false });
    assert.equal(f.document.count('visibilitychange'), 0, 'revoked work must be detached');
  }
  f.api.applyAssistantScope(f.scope(21));
  assert.equal(f.document.count('visibilitychange'), 1);
  assert.equal(f.imports.length, 0);
  f.visible();
  await f.drain();
  assert.equal(f.imports.length, 1);
  assert.equal(f.installed.length, 1);
  assert.deepEqual(f.mounted, [21]);
  assert.equal(f.document.count('visibilitychange'), 0);
  assert.equal(f.queued(), 0);
});

for (const phase of ['paint', 'idle']) {
  test('a tab hidden during queued ' + phase + ' work performs no import until it is visible again', async t => {
    const f = fixture(t);
    f.api.applyAssistantScope(f.scope(1));
    if (phase === 'idle') f.paint();
    f.hidden();
    await f.drain();
    assert.equal(f.imports.length, 0, 'idle timeout must not start a hidden bundle');
    assert.ok(f.document.count('visibilitychange') <= 1);
    f.visible();
    await f.drain();
    assert.equal(f.imports.length, 1);
    assert.equal(f.installed.length, 1);
    assert.deepEqual(f.mounted, [1]);
    assert.equal(f.queued(), 0);
  });

  test('reset releases queued ' + phase + ' callbacks, and forcibly delivered stale callbacks remain inert', async t => {
    const f = fixture(t);
    f.api.applyAssistantScope(f.scope(1));
    if (phase === 'idle') f.paint();
    const stale = [...f.frames.values(), ...f.idle.values(), ...f.timers.values()];
    assert.ok(stale.length > 0);
    f.api.resetAssistant();
    assert.equal(f.queued(), 0, 'generation fences alone do not cancel queued work');
    assert.equal(f.document.count('visibilitychange'), 0);
    for (const callback of stale) callback();
    await flush();
    assert.equal(f.imports.length, 0);
    assert.equal(f.installed.length, 0);
    assert.equal(f.queued(), 0, 'stale callbacks cannot enqueue replacement work');
    assert.equal(f.state.assistantReady, false);
  });
}

for (const initialHidden of [false, true])
  test('pagehide cancels deferred host work; initiallyHidden=' + initialHidden, async t => {
    const f = fixture(t);
    if (initialHidden) f.hidden();
    f.api.applyAssistantScope(f.scope(1));
    f.window.dispatch('pagehide');
    assert.equal(f.queued(), 0);
    assert.equal(f.document.count('visibilitychange'), 0);
    f.visible();
    await f.drain();
    assert.equal(f.imports.length, 0);
    assert.equal(f.state.assistantScope, null);
  });

test('an installed bundle remains cached across valid remounts without microphone or extra imports', async t => {
  const f = fixture(t);
  f.api.applyAssistantScope(f.scope(1));
  await f.drain();
  for (let i = 0; i < 20; i++) f.api.mountAssistant();
  assert.equal(f.imports.length, 1);
  assert.equal(f.installed.length, 1);
  assert.equal(f.queued(), 0);
  f.api.resetAssistant();
  f.api.applyAssistantScope(f.scope(2));
  await f.drain();
  assert.equal(f.imports.length, 1);
  assert.equal(f.installed.length, 1);
  assert.equal(f.mounted.at(-1), 2);
});