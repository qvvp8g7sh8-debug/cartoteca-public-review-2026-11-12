const { assetPath } = require('./helpers/interface-assets.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/client/core/deferred-settings.js'), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => {
  resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture({ installFails = false } = {}) {
  const frames = [], idle = [], timers = new Map(), loads = [], installed = [], notices = [];
  let id = 0, probeStatus = 200;
  const state = { account: { id: 'synthetic' }, settingsReady: false, settingsBundleId: 'same-source' };
  const document = { hidden: false, querySelector: () => ({ content: '1111111111111111' }) };
  const factory = vm.runInNewContext(source + '\ncreateDeferredSettings', {
    document, window: { requestAnimationFrame: (fn) => frames.push(fn),
      requestIdleCallback: (fn) => idle.push(fn) }, AbortController,
    setTimeout(fn, delay) { timers.set(++id, { fn, delay }); return id; },
    clearTimeout(key) { timers.delete(key); },
    fetch: async () => ({ status: probeStatus }),
  });
  const api = factory(state, { toast: (value) => notices.push(value) },
    (module) => { installed.push(module); if (installFails) throw Error('Synthetic bind failure'); }, (url) => {
      const pending = deferred(); loads.push({ url, ...pending }); return pending.promise;
    });
  return { state, api, frames, idle, timers, loads, installed, notices,
    probe(status) { probeStatus = status; },
    timeout(delay) { const entry = [...timers].find(([, value]) => value.delay === delay);
      assert.ok(entry, 'Expected timer ' + delay); timers.delete(entry[0]); entry[1].fn(); },
    complete(index = 0) { loads[index].resolve({ bundleId: 'same-source' }); } };
}
test('settings automatically starts after two frames and idle without a click', async () => {
  const f = fixture(); f.api.scheduleSettingsLoad(); f.api.scheduleSettingsLoad();
  assert.equal(f.loads.length, 0); assert.equal(f.frames.length, 1);
  f.frames.shift()(); assert.equal(f.loads.length, 0);
  f.frames.shift()(); assert.equal(f.loads.length, 0);
  f.idle.shift()(); assert.equal(f.loads.length, 1);
  const joined = f.api.ensureSettings(); assert.equal(f.loads.length, 1);
  f.complete(); await joined; assert.equal(f.state.settingsReady, true);
  await f.api.ensureSettings(); assert.equal(f.installed.length, 1);
});
test('animation fallback starts the automatic load when frames are throttled', async () => {
  const f = fixture(); f.api.scheduleSettingsLoad(); f.timeout(1500); f.idle.shift()();
  assert.equal(f.loads.length, 1); f.complete(); await flush();
  assert.equal(f.installed.length, 1);
});
test('failed transport can retry and cannot install an expired late result', async () => {
  const f = fixture(); const first = f.api.ensureSettings();
  const failed = assert.rejects(first, /Проверьте соединение/);
  f.timeout(15000); await failed;
  f.complete(); await flush(); assert.equal(f.installed.length, 0);
  const second = f.api.ensureSettings();
  assert.notEqual(f.loads[0].url, f.loads[1].url);
  f.complete(1); await second; assert.equal(f.installed.length, 1);
});
test('stale HTTP release and mismatched code require reload without installation', async () => {
  const f = fixture(); f.probe(409); const first = f.api.ensureSettings();
  const failed = assert.rejects(first, (error) => error.reloadRequired && /Сохраните/.test(error.message));
  f.loads[0].reject(Error('Native import HTTP error')); await failed;
  assert.equal(f.installed.length, 0);
  const g = fixture(); const second = g.api.ensureSettings();
  g.loads[0].resolve({ bundleId: 'another-source' });
  await assert.rejects(second, (error) => error.reloadRequired === true);
  assert.equal(g.installed.length, 0);
});
test('account change before delivery prevents installing into the old scope', async () => {
  const f = fixture(), pending = f.api.ensureSettings();
  f.state.account = { id: 'other-synthetic' }; f.complete();
  await assert.rejects(pending, /Учётная запись изменилась/);
  assert.equal(f.installed.length, 0); assert.equal(f.state.settingsReady, false);
});
test('delivery manifest keeps calendar and staff form actions initial and moves settings code', () => {
  const root = path.resolve(__dirname, '..');
  const manifest = require('../src/client/manifest.json');
  for (const name of ['createCalendar', 'createAppointments', 'createClients', 'createStaffField'])
    assert.equal(manifest.factories.find((item) => item.factory === name).phase, undefined);
  for (const name of ['createTeam', 'createSupport', 'createIntegrations'])
    assert.equal(manifest.factories.find((item) => item.factory === name).phase, 'settings');
  const initial = fs.readFileSync(assetPath('app.js'), 'utf8');
  const background = fs.readFileSync(assetPath('app-settings.js'), 'utf8');
  assert.doesNotMatch(initial, /function createIntegrations\(/);
  assert.match(background, /function createIntegrations\(/);
  assert.match(initial, /function createStaffField\(/);
  assert.match(background, /export const bundleId=/);
  assert.ok(require('../scripts/release/files.cjs').allowed('app-settings.js'));
  assert.match(fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8'), /^COPY dist\/public \.\/dist\/public$/m);
});


test('early settings navigation cannot reopen itself after leaving for clients', async (t) => {
  const { JSDOM } = require('jsdom');
  const window = new JSDOM('<p id="load-status" hidden></p><input id="search"><main id="workspace"><div id="global-view"></div></main>').window;
  t.after(() => window.close());
  const state = { account: { id: 'synthetic' }, currentView: 'calendar',
    sessionReady: true, settingsReady: false, multiUser: false };
  const delivery = deferred(); let settingsRenders = 0;
  const actions = new Proxy({
    $: (selector) => window.document.querySelector(selector),
    ensureSettings: () => delivery.promise,
    settingsHtml: () => { settingsRenders++; return '<section>Settings</section>'; },
  }, { get: (object, name) => object[name] || (() => {}) });
  const text = fs.readFileSync(path.join(__dirname, '../src/client/core/navigation.js'), 'utf8');
  const factory = vm.runInNewContext(text + '\ncreateNavigation', { document: window.document, window });
  const api = factory(state, actions);
  const settings = api.setView('settings');
  assert.equal(state.currentView, 'calendar');
  assert.equal(actions.$('#load-status').hidden, false);
  await api.setView('clients');
  state.settingsReady = true; delivery.resolve(); await settings;
  assert.equal(state.currentView, 'clients'); assert.equal(settingsRenders, 0);
  assert.equal(actions.$('#load-status').hidden, true);
});


test('a partially installed module is terminal and never retries its bindings', async () => {
  const f = fixture({ installFails: true }), pending = f.api.ensureSettings();
  f.complete(); await assert.rejects(pending, (error) => error.reloadRequired === true);
  await assert.rejects(f.api.ensureSettings(), (error) => error.reloadRequired === true);
  assert.equal(f.installed.length, 1); assert.equal(f.loads.length, 1);
  assert.equal(f.state.settingsReady, false);
});

test('background redraw preserves a pending settings transition', async (t) => {
  const { JSDOM } = require('jsdom');
  const window = new JSDOM('<p id="load-status" hidden></p><input id="search"><main id="workspace"><div id="global-view"></div></main>').window;
  t.after(() => window.close());
  const state = { account: { id: 'synthetic' }, currentView: 'calendar',
    sessionReady: true, settingsReady: false, multiUser: false };
  const delivery = deferred(); let settingsRenders = 0;
  const actions = new Proxy({
    $: (selector) => window.document.querySelector(selector),
    ensureSettings: () => delivery.promise,
    calendarHtml: () => '<section>Calendar</section>',
    settingsHtml: () => { settingsRenders++; return '<section>Settings</section>'; },
  }, { get: (object, name) => object[name] || (() => {}) });
  const text = fs.readFileSync(path.join(__dirname, '../src/client/core/navigation.js'), 'utf8');
  const factory = vm.runInNewContext(text + '\ncreateNavigation', { document: window.document, window });
  const api = factory(state, actions), pending = api.setView('settings');
  await api.setView('calendar', { redraw: true });
  assert.equal(actions.$('#load-status').hidden, false);
  state.settingsReady = true; delivery.resolve(); await pending;
  assert.equal(state.currentView, 'settings'); assert.equal(settingsRenders, 1);
  assert.equal(actions.$('#load-status').hidden, true);
});
