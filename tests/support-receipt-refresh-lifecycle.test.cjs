'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = name => fs.readFileSync(path.join(__dirname, '../src/client/modules', name + '.js'), 'utf8');
const ids = { a: '10000000-0000-4000-8000-000000000001', b: '20000000-0000-4000-8000-000000000002' };
const receipt = (id, overrides = {}) => ({ id, replyEmail: 'owner@synthetic.test', state: 'open',
  deliveries: { telegram: 'pending' }, messages: [], ...overrides });
const response = value => ({ ok: true, json: async () => structuredClone(value) });
async function fixture(t) {
  const w = new JSDOM('<!doctype html><meta name="cartoteca-build" content="1111111111111111"><main id="workspace"><div id="global-view"></div></main>',
    { url: 'https://synthetic.test/', runScripts: 'outside-only', pretendToBeVisual: true }).window;
  if (w.document.readyState !== 'complete') await new Promise(resolve => w.addEventListener('load', resolve, { once: true }));
  let now = 100000, sequence = 0, nextReceipt = receipt(ids.a), postHandler = null;
  const timers = new Map(), calls = [], held = new Map(), gates = [], tasks = new Set(), unexpected = [];
  w.Date.now = () => now;
  w.setTimeout = (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay, due: now + delay }); return id; };
  w.clearTimeout = id => timers.delete(id);
  Object.defineProperty(w.AbortSignal, 'timeout', { configurable: true,
    value: () => new w.AbortController().signal });
  Object.defineProperty(w.document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(w.document, 'hidden', { configurable: true, value: false });
  const state = { currentView: 'settings', account: { id: 'owner-a', organizationId: 'org-a', role: 'owner' }, busy: false };
  const actions = {
    $: selector => w.document.querySelector(selector),
    esc: value => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    settingsSectionHtml: (title, id, html) => '<section id="' + id + '">' + html + '</section>',
    settingsHelpHtml: () => '<button type="button" data-settings-help></button>',
    hasUnsavedSettings: () => false, toast() {},
  };
  w.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || 'GET', signal: options.signal,
      body: options.body ? JSON.parse(options.body) : null,
      account: state.account.id, organization: state.account.organizationId };
    calls.push(call);
    if (call.url === '/api/app/info') return response({ version: '1111111111111111', supportForm: true });
    if (call.url === '/api/support/requests' && call.method === 'POST')
      return postHandler ? postHandler(call) : response({ receipt: nextReceipt });
    if (call.method === 'GET' && call.url.startsWith('/api/support/requests?id=')) {
      const id = new URL(call.url, 'https://synthetic.test').searchParams.get('id');
      return held.has(id) ? held.get(id).promise : response({ receipt: receipt(id) });
    }
    unexpected.push(call.url); throw Error('Unexpected synthetic route');
  };
  w.eval(source('support-requests') + '\n' + source('support'));
  Object.assign(actions, w.eval('createSupportRequests')(state, actions));
  const track = promise => {
    tasks.add(promise); void promise.finally(() => tasks.delete(promise)).catch(() => {}); return promise;
  };
  const originalRefresh = actions.refreshSupportReceipt;
  actions.refreshSupportReceipt = (...args) => track(originalRefresh(...args));
  const support = w.eval('createSupport')(state, actions);
  Object.assign(actions, support);
  actions.$('#global-view').innerHTML = support.supportSettingsHtml();
  support.bindSupportEvents();
  const flush = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
  await flush();
  t.after(async () => {
    for (const gate of gates) gate.resolve(response({ receipt: receipt(gate.id) }));
    await flush(); await Promise.allSettled([...tasks]); timers.clear(); w.close();
    assert.deepEqual(unexpected, []);
  });
  function hold(id) {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const gate = { id, promise, resolve, reject,
      success(value = receipt(id)) { resolve(response({ receipt: value })); } };
    held.set(id, gate); gates.push(gate); return gate;
  }
  return { w, state, actions, support, timers, calls, flush, hold,
    reads: () => calls.filter(call => call.method === 'GET' && call.url.startsWith('/api/support/requests?id=')),
    posts: () => calls.filter(call => call.method === 'POST'),
    async seed(value = receipt(ids.a)) { nextReceipt = value; return actions.sendSupportRequest({ description: 'Synthetic support question', diagnostics: {} }); },
    setPost(handler) { postHandler = handler; },
    async swapAccount() {
      state.account = { id: 'owner-b', organizationId: 'org-b', role: 'owner' };
      actions.$('#global-view').innerHTML = support.supportSettingsHtml(); await flush();
    },
    setDraft(value) {
      const input = actions.$('#support-description'); input.value = value;
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
    },
    async fireReceiptTimer() {
      const entries = [...timers].filter(([, value]) => value.delay === 5000);
      assert.equal(entries.length, 1, 'Own pending-receipt timer is present');
      const [id, timer] = entries[0]; timers.delete(id); now = timer.due; timer.fn(); await flush();
    },
  };
}
test('focus and visible resume join one pending same-receipt HTTP read and keep the draft', async t => {
  const f = await fixture(t); f.setDraft('Keep this unsent synthetic draft'); await f.seed();
  const gate = f.hold(ids.a);
  f.w.dispatchEvent(new f.w.Event('focus'));
  f.w.document.dispatchEvent(new f.w.Event('visibilitychange'));
  await f.flush();
  assert.equal(f.reads().length, 1, 'Both public resume hooks must join the same GET');
  gate.success(); await f.flush();
  assert.equal(f.actions.$('#support-description').value, 'Keep this unsent synthetic draft');
  assert.equal(f.posts().length, 1, 'Refresh never resends the seeded manual POST');
  assert.match(f.actions.$('#support-message').textContent, /10000000/);
});
test('pending receipt timer and focus also share exactly one status read', async t => {
  const f = await fixture(t); await f.seed(); const gate = f.hold(ids.a);
  await f.fireReceiptTimer(); f.w.dispatchEvent(new f.w.Event('focus')); await f.flush();
  assert.equal(f.reads().length, 1, 'Timer and focus must not duplicate an in-flight GET');
  gate.success(); await f.flush();
  assert.equal([...f.timers.values()].filter(timer => timer.delay === 5000).length, 1);
});
test('a failed shared read keeps the receipt and releases the slot for an explicit retry', async t => {
  const f = await fixture(t); f.setDraft('Still unsent'); await f.seed();
  const first = f.hold(ids.a), a = f.actions.refreshSupportReceipt(), b = f.actions.refreshSupportReceipt();
  first.reject(TypeError('Synthetic disconnected read')); await Promise.all([a, b]); await f.flush();
  assert.equal(f.reads().length, 1, 'Failure is shared, not duplicated');
  assert.match(f.actions.$('#support-message').textContent, /10000000/);
  assert.equal(f.actions.$('#support-description').value, 'Still unsent');
  const second = f.hold(ids.a), retry = f.actions.refreshSupportReceipt();
  assert.equal(f.reads().length, 2, 'A later explicit retry is a new read');
  second.success(); await retry;
  assert.equal(f.posts().length, 1);
});
test('account scope replacement gets its own read and an old success cannot replace the new receipt', async t => {
  const f = await fixture(t); await f.seed(); const old = f.hold(ids.a), oldTask = f.actions.refreshSupportReceipt();
  await f.swapAccount(); f.setDraft('New account draft'); await f.seed(receipt(ids.b));
  const current = f.hold(ids.b), currentTask = f.actions.refreshSupportReceipt();
  assert.equal(f.reads().length, 2, 'A new account cannot wait on the old scope');
  assert.deepEqual(f.reads().map(call => [call.account, call.organization]), [['owner-a', 'org-a'], ['owner-b', 'org-b']]);
  old.success(receipt(ids.a, { deliveries: { telegram: 'failed' } })); await oldTask;
  const joinedCurrent = f.actions.refreshSupportReceipt();
  assert.equal(f.reads().length, 2, 'Old scope completion must not release the still-current in-flight slot');
  current.success(receipt(ids.b, { deliveries: { telegram: 'sent' } })); await Promise.all([currentTask, joinedCurrent]);
  assert.match(f.actions.$('#support-message').textContent, /20000000/);
  assert.doesNotMatch(f.actions.$('#support-message').textContent, /10000000/);
  assert.equal(f.actions.$('#support-description').value, 'New account draft');
});
test('a cleared receipt id does not block a new receipt in the same account or revive on late failure', async t => {
  const f = await fixture(t); await f.seed(); const old = f.hold(ids.a), oldTask = f.actions.refreshSupportReceipt();
  f.actions.clearSupportReceipt(); await f.seed(receipt(ids.b));
  const current = f.hold(ids.b), currentTask = f.actions.refreshSupportReceipt();
  assert.equal(f.reads().length, 2, 'Receipt identity is part of single-flight ownership');
  current.success(); await currentTask; old.reject(TypeError('Synthetic late old failure')); await oldTask;
  assert.match(f.actions.$('#support-message').textContent, /20000000/);
  assert.doesNotMatch(f.actions.$('#support-message').textContent, /10000000/);
});
test('a completed status read is not cached forever and hidden pages start no read', async t => {
  const f = await fixture(t); await f.seed();
  await f.actions.refreshSupportReceipt(); await f.actions.refreshSupportReceipt();
  assert.equal(f.reads().length, 2, 'Only in-flight work is joined');
  Object.defineProperty(f.w.document, 'visibilityState', { configurable: true, value: 'hidden' });
  await f.actions.refreshSupportReceipt(); assert.equal(f.reads().length, 2);
  assert.equal(f.posts().length, 1);
});
test('manual POST failure stays explicit; resume does not retry it and same-body manual retry keeps its request id', async t => {
  const f = await fixture(t); f.setPost(async () => { throw TypeError('Synthetic unknown delivery'); });
  const body = { description: 'Manual synthetic question', diagnostics: { view: 'settings' } };
  await assert.rejects(f.actions.sendSupportRequest(body), /Synthetic unknown delivery/);
  f.w.dispatchEvent(new f.w.Event('focus')); f.w.document.dispatchEvent(new f.w.Event('visibilitychange')); await f.flush();
  assert.equal(f.posts().length, 1); assert.equal(f.reads().length, 0);
  f.setPost(async () => response({ receipt: receipt(ids.a) }));
  await f.actions.sendSupportRequest(body);
  assert.equal(f.posts().length, 2);
  assert.equal(f.posts()[0].body.requestId, f.posts()[1].body.requestId, 'Uncertain manual outcome must retain its idempotency key');
  assert.deepEqual(f.posts()[0].body, f.posts()[1].body);
});
