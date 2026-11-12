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
  let now = 100000, sequence = 0, nextReceipt = receipt(ids.a), postHandler = null, infoHandler = null;
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
    if (call.url === '/api/app/info') return infoHandler ? infoHandler(call) : response({ version: '1111111111111111', supportForm: false });
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
    for (const gate of gates) gate.resolve(response(gate.kind === 'info' ? { version: '1111111111111111', supportForm: false } : { receipt: receipt(gate.id) }));
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
    infoReads: () => calls.filter(call => call.url === '/api/app/info'),
    setInfo(handler) { infoHandler = handler; },
    advance(ms) { now += ms; },
    holdInfo() {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      const gate = { kind: 'info', promise, resolve, reject,
        success(value = { version: '2222222222222222', supportForm: false }) { resolve(response(value)); } };
      gates.push(gate); infoHandler = () => promise; return gate;
    },
    fireVersionTimer() {
      const entries = [...timers].filter(([, value]) => value.delay === 300000);
      assert.equal(entries.length, 1, 'One owned automatic version timer');
      const [id, timer] = entries[0]; timers.delete(id); now = timer.due;
      const task = timer.fn(); if (task?.then) track(task);
      return { task };
    },
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
test('pagehide during an automatic version fetch prevents late success repaint and timer resurrection', async t => {
  const f = await fixture(t), gate = f.holdInfo();
  const { task } = f.fireVersionTimer(); await f.flush();
  assert.equal(f.infoReads().length, 2, 'Initial and one automatic check');
  f.w.dispatchEvent(new f.w.Event('pagehide'));
  assert.equal([...f.timers.values()].filter(value => value.delay === 300000).length, 0);
  gate.success(); await task; await f.flush();
  assert.equal(f.actions.$('#app-version-notice'), null, 'Departed generation must not paint a new-version banner');
  assert.equal([...f.timers.values()].filter(value => value.delay === 300000).length, 0,
    'A late timer-owned completion must not rearm the five-minute timer');
  assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0);
});
test('pagehide during an automatic version fetch prevents timer resurrection after late failure', async t => {
  const f = await fixture(t), gate = f.holdInfo();
  const { task } = f.fireVersionTimer(); await f.flush();
  f.w.dispatchEvent(new f.w.Event('pagehide'));
  gate.reject(TypeError('Synthetic late departed failure')); await task; await f.flush();
  assert.equal([...f.timers.values()].filter(value => value.delay === 300000).length, 0,
    'Failure completion has the same departed-owner fence');
  assert.equal(f.actions.$('#app-version-notice'), null);
  assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0);
});
test('a late departed success cannot erase a fresh resumed manual-force failure', async t => {
  const f = await fixture(t), old = f.holdInfo();
  const { task: oldTask } = f.fireVersionTimer(); await f.flush();
  f.w.dispatchEvent(new f.w.Event('pagehide'));
  const current = f.holdInfo(); f.advance(60001);
  f.w.dispatchEvent(new f.w.Event('pageshow'));
  const manual = f.support.checkAppVersion(true); await f.flush();
  assert.equal(f.infoReads().length, 3, 'Resumed epoch must not join invalid departed work');
  current.reject(TypeError('Synthetic current failure')); await manual; await f.flush();
  assert.match(f.actions.$('#support-contact').textContent, /Нет связи с сервером/);
  old.success({ version: '2222222222222222', supportTelegram: 'https://t.me/Synthetic_help', supportForm: false });
  await oldTask; await f.flush();
  assert.match(f.actions.$('#support-contact').textContent, /Нет связи с сервером/,
    'Old success cannot replace the current error with a stale connected state');
  assert.equal(f.actions.$('#app-version-notice'), null);
  assert.equal([...f.timers.values()].filter(value => value.delay === 300000).length, 1);
});
test('current forced checks still report real failure and preserve the unsent manual draft', async t => {
  const f = await fixture(t); f.setDraft('Keep this synthetic unsent question');
  const gate = f.holdInfo(), task = f.support.checkAppVersion(true);
  gate.reject(TypeError('Synthetic current offline')); await task; await f.flush();
  assert.match(f.actions.$('#support-contact').textContent, /Нет связи с сервером/);
  assert.equal(f.actions.$('#support-description').value, 'Keep this synthetic unsent question');
  assert.equal(f.actions.$('#support-open-telegram').disabled, true);
  assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0,
    'Version work must not send or retry the support draft');
});
test('concurrent current manual-force/focus checks retain one in-flight read', async t => {
  const f = await fixture(t), gate = f.holdInfo();
  const a = f.support.checkAppVersion(true), b = f.support.checkAppVersion(true);
  f.w.dispatchEvent(new f.w.Event('focus')); await f.flush();
  assert.equal(f.infoReads().length, 2, 'One initial read plus one shared current forced read');
  gate.success({ version: '2222222222222222', supportForm: false }); await Promise.all([a, b]); await f.flush();
  assert.ok(f.actions.$('#app-version-notice'));
  assert.equal([...f.timers.values()].filter(value => value.delay === 300000).length, 1);
});
test('pageshow after settled departed work can resume one fresh check and one timer', async t => {
  const f = await fixture(t), gate = f.holdInfo();
  const { task } = f.fireVersionTimer(); await f.flush();
  f.w.dispatchEvent(new f.w.Event('pagehide')); gate.success(); await task; await f.flush();
  f.setInfo(async () => response({ version: '1111111111111111', supportForm: false }));
  f.advance(60001); f.w.dispatchEvent(new f.w.Event('pageshow')); await f.flush();
  assert.equal(f.infoReads().length, 3);
  assert.equal([...f.timers.values()].filter(value => value.delay === 300000).length, 1,
    'Visible restoration must not permanently disable or duplicate update checks');
  assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0);
});
