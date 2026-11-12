const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/client/modules/assistant-trigger.js'), 'utf8');
function fixture(prepareScope = null) {
  let now = 0, serial = 0, primes = 0;
  const timers = new Map(), opened = [];
  class Surface {
    constructor(parentNode = null) {
      this.parentNode = parentNode;
      this.handlers = new Map();
      this.attrs = new Map();
      this.isConnected = true;
      this.hidden = this.disabled = false;
      const classes = new Set();
      this.classList = { add: (x) => classes.add(x), remove: (x) => classes.delete(x), contains: (x) => classes.has(x) };
    }
    addEventListener(type, fn, options = false) {
      const rows = this.handlers.get(type) || [];
      const capture = typeof options === 'boolean' ? options : options.capture === true;
      if (!rows.some((r) => r.fn === fn && r.capture === capture)) rows.push({ fn, capture });
      this.handlers.set(type, rows);
    }
    removeEventListener(type, fn, options = false) {
      const capture = typeof options === 'boolean' ? options : options.capture === true;
      this.handlers.set(type, (this.handlers.get(type) || []).filter((r) => r.fn !== fn || r.capture !== capture));
    }
    contains(node) { for (let p = node; p; p = p.parentNode) if (p === this) return true; return false; }
    closest() { for (let p = this; p; p = p.parentNode) if (p.hidden) return p; return null; }
    getAttribute(key) { return this.attrs.get(key) ?? null; }
    setAttribute(key, value) { this.attrs.set(key, value); }
    removeAttribute(key) { this.attrs.delete(key); }
    setPointerCapture(id) { this.captured = id; }
    hasPointerCapture(id) { return this.captured === id; }
    releasePointerCapture() { this.captured = null; }
  }
  const window = new Surface(), document = new Surface(window), body = new Surface(document), button = new Surface(body);
  document.body = body;
  document.querySelector = () => button;
  window.setTimeout = (fn, delay) => { const id = ++serial; timers.set(id, { fn, at: now + delay }); return id; };
  window.clearTimeout = (id) => timers.delete(id);
  window.MutationObserver = class { observe() {} disconnect() {} };
  const state = { currentView: 'calendar', assistantReady: true, assistantGeneration: 1, account: { id: 'synthetic', organizationId: 'synthetic-org', role: 'owner' }, assistantScope: { enabled: true, organizationId: 'synthetic-org', policyVersion: 1 } };
  const api = vm.runInNewContext(source + '\ncreateAssistantTrigger', { window, document, Math })(state);
  api.mountAssistantTrigger((options) => opened.push(options), () => { primes++; }, prepareScope);
  function dispatch(target, type, extra = {}) {
    const event = { type, target, pointerId: 1, isPrimary: true, isTrusted: true, button: 0, clientX: 0, clientY: 0, detail: 1, ...extra, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
    const chain = [];
    for (let p = target; p; p = p.parentNode) chain.push(p);
    for (const capture of [true, false]) for (const node of capture ? [...chain].reverse() : chain)
      for (const row of [...(node.handlers.get(type) || [])]) if (!event.stopped && row.capture === capture) row.fn(event);
    return event;
  }
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      timers.delete(next[0]); now = next[1].at; next[1].fn();
      await Promise.resolve();
    }
    now = end;
  }
  async function hold(id) {
    dispatch(button, 'pointerdown', { pointerId: id });
    await advance(599);
    const before = opened.length;
    await advance(1);
    assert.equal(opened.length, before + 1, 'hold opens exactly at600ms');
    dispatch(button, 'pointerup', { pointerId: id });
    assert.equal(dispatch(button, 'click', { pointerId: id }).prevented, true);
  }
  return { window, document, button, state, api, opened, dispatch, advance, hold, primes: () => primes };
}

test('a touch hold starts one scope read early and vibrates once when confirmed', async () => {
  const controller = new AbortController();
  let requests = 0;
  const f = fixture(() => {
    requests++;
    return { controller };
  });
  const pulses = [];
  f.window.navigator = { vibrate: (duration) => (pulses.push(duration), true) };
  f.dispatch(f.button, 'pointerdown', { pointerType: 'touch' });
  await f.advance(250);
  assert.equal(requests, 1);
  assert.equal(f.opened.length, 0);
  assert.deepEqual(pulses, []);
  await f.advance(350);
  assert.equal(f.opened[0].preparedScope.controller, controller);
  f.dispatch(f.button, 'pointerup', { pointerType: 'touch' });
  assert.equal(controller.signal.aborted, false);
  assert.deepEqual(pulses, [18]);
});

test('release before the hold threshold aborts the pending scope read', async () => {
  const controller = new AbortController();
  const f = fixture(() => ({ controller }));
  f.window.navigator = { vibrate: () => assert.fail('a cancelled hold must not vibrate') };
  f.dispatch(f.button, 'pointerdown', { pointerType: 'touch' });
  await f.advance(300);
  f.dispatch(f.button, 'pointerup', { pointerType: 'touch' });
  await f.advance(300);
  assert.equal(controller.signal.aborted, true);
  assert.equal(f.opened.length, 0);
});

test('three completed holds open once each while fresh quick taps remain manual and cold', async () => {
  const f = fixture();
  for (const id of [11, 12, 13]) await f.hold(id);
  assert.equal(f.opened.length, 3);
  const primes = f.primes();
  f.dispatch(f.button, 'pointerdown', { pointerId: 14 });
  await f.advance(100);
  f.dispatch(f.button, 'pointerup', { pointerId: 14 });
  assert.equal(f.dispatch(f.button, 'click', { pointerId: 14 }).prevented, false);
  assert.equal(f.primes(), primes);
  assert.equal(f.opened.length, 3);
});

for (const stage of [100, 600]) for (const kind of ['lostcapture', 'blur', 'hidden', 'pointercancel']) {
  test(`${kind} at${stage}ms without a trailing release permits a fresh primary hold`, async () => {
    const f = fixture();
    f.dispatch(f.button, 'pointerdown', { pointerId: 11 });
    await f.advance(stage);
    if (kind === 'lostcapture') f.dispatch(f.button, 'lostpointercapture', { pointerId: 11 });
    if (kind === 'blur') f.dispatch(f.window, 'blur');
    if (kind === 'hidden') { f.document.hidden = true; f.dispatch(f.document, 'visibilitychange'); f.document.hidden = false; f.dispatch(f.document, 'visibilitychange'); }
    if (kind === 'pointercancel') f.dispatch(f.button, 'pointercancel', { pointerId: 11 });
    assert.equal(f.dispatch(f.button, 'click', { pointerId: 11 }).prevented, true, 'cancelled/held click cannot open manual form');
    const count = f.opened.length;
    await f.advance(1000);
    assert.equal(f.opened.length, count, 'cancelled gesture cannot fire a late timer');
    await f.hold(12);
    await f.hold(13);
    assert.equal(f.opened.length, count + 2);
  });
}

test('a second simultaneous pointer cannot become a fresh hold or prime audio', async () => {
  const f = fixture();
  f.dispatch(f.button, 'pointerdown', { pointerId: 11 });
  await f.advance(100);
  f.dispatch(f.button, 'pointerdown', { pointerId: 12, isPrimary: false });
  await f.advance(600);
  assert.equal(f.opened.length, 0);
  assert.equal(f.primes(), 0);
  f.dispatch(f.button, 'pointerup', { pointerId: 12 });
  f.dispatch(f.button, 'pointerup', { pointerId: 11 });
  assert.equal(f.dispatch(f.button, 'click', { pointerId: 11 }).prevented, true);
  await f.hold(13);
});
