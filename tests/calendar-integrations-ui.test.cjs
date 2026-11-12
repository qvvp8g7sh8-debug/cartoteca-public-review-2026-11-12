const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { JSDOM } = require('jsdom');
const { setTimeout: delay } = require('node:timers/promises');
const read = (name) => fs.readFileSync(path.join(__dirname, '../src/client/modules/', name), 'utf8');
const source = read('integrations.js'), helpSource = read('settings-help.js'),
  viewSource = read('calendar-integration-view.js');
const routes = { apple: '/api/calendar/subscription', google: '/api/calendar/subscription?provider=google' };
const credentials = { apple: 'synthetic-subscription', google: 'synthetic-google-subscription' };
function adminSnapshot(provider, selection = { mode: 'all', staffIds: [] }, extra = {}) {
  return { connected: false, credential: null, selection,
    selectionRevision: provider + '-revision-1',
    specialists: [{ id: 'a', displayName: 'Анна' }, { id: 'b', displayName: 'Борис' }], ...extra };
}
async function until(condition) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await delay(5);
  }
  throw Error('Calendar integration UI timeout');
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fixture(t, { role = 'cosmetologist', url = 'https://synthetic.test/' } = {}) {
  const w = new JSDOM('<main></main>', { runScripts: 'outside-only', url }).window;
  t.after(() => w.close());
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new w.Event('close'));
  };
  w.eval(helpSource); w.eval(viewSource); w.eval(source);
  const state = { multiUser: true, busy: false, account: { id: 'staff', role } },
    calls = [], confirmations = [], handlers = {}, openings = [], events = [],
    snapshots = Object.fromEntries(Object.keys(routes).map((provider) => [provider,
      role === 'salon_admin' ? adminSnapshot(provider) : { connected: false }]));
  let openHandler = (target) => ({
    document: w.document.implementation.createHTMLDocument(''),
    location: { href: target }, opener: {}, closed: false,
    close() { this.closed = true; },
  });
  w.open = (target, name) => {
    const opening = { target, name };
    openings.push(opening); events.push({ kind: 'open', target });
    opening.popup = openHandler(target, name);
    return opening.popup;
  };
  const actions = {
    $: (selector) => w.document.querySelector(selector),
    accountRole: () => state.account.role,
    esc: (value) => String(value).replace(/[&<>"']/g, (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]),
    settingsSectionHtml: (_title, id, html) => `<section id="${id}">${html}</section>`,
    request: async (route, options) => {
      const provider = Object.keys(routes).find((name) => routes[name] === route), method = options?.method || 'GET';
      assert.ok(provider, 'Unexpected calendar route: ' + route);
      assert.ok(['GET', 'POST', 'PUT', 'DELETE'].includes(method), 'Unexpected calendar method');
      calls.push({ route, method, provider, ...(method === 'PUT' ? { body: JSON.parse(options.body) } : {}) }); events.push({ kind: 'request', method, provider });
      if (handlers[provider]) return handlers[provider](route, options);
      if (method === 'POST') snapshots[provider] = { ...snapshots[provider], connected: true, credential: credentials[provider] };
      if (method === 'DELETE') snapshots[provider] = { ...snapshots[provider], connected: false, credential: null };
      if (method === 'PUT') snapshots[provider] = { ...snapshots[provider], selection: JSON.parse(options.body).selection,
        selectionRevision: snapshots[provider].selectionRevision + '-saved' };
      return structuredClone(snapshots[provider]);
    },
    confirmAction: async (...arguments_) => { confirmations.push(arguments_); return true; },
  };
  Object.assign(actions, w.eval('createSettingsHelp')(state, actions));
  Object.assign(actions, w.eval('createCalendarIntegrationView')(state, actions));
  const integrations = w.eval('createIntegrations')(state, actions);
  w.document.querySelector('main').innerHTML = integrations.integrationsSettingsHtml();
  const card = (provider) => actions.$(`#${provider}-calendar-integration`),
    query = (provider, selector) => card(provider).querySelector(selector);
  return {
    w, state, actions, integrations, calls, confirmations, openings, events, card, query,
    setOpen: (value) => (openHandler = value),
    setHandler: (value, provider = 'apple') => (handlers[provider] = value),
    setSnapshot: (value, provider = 'apple') => (snapshots[provider] = structuredClone(value)),
    toggle(provider, checked) {
      const input = query(provider, '[data-calendar-switch]');
      input.checked = checked;
      input.dispatchEvent(new w.Event('change', { bubbles: true }));
      return input;
    },
    help(provider, expand = false) {
      query(provider, '.integration-card-heading [data-settings-help]').click();
      const dialog = query(provider, 'dialog');
      assert.equal(dialog.open, true);
      if (expand) dialog.querySelector('.integration-manual').open = true;
      return dialog;
    },
  };
}
function connected(f, provider) { f.setSnapshot({ connected: true, credential: credentials[provider] }, provider); }
function installClipboard(f, writeText) {
  Object.defineProperty(f.w.navigator, 'clipboard', { configurable: true, value: { writeText } });
}
function feed(f, provider) {
  const url = new URL('/api/calendar/feed.ics', f.w.location.origin);
  url.searchParams.set('subscription', credentials[provider]);
  return url.href;
}
function webcal(f, provider) { return feed(f, provider).replace(/^https?:/, 'webcal:'); }
function assertGoogleTarget(f, target) {
  const url = new URL(target);
  assert.equal(url.origin, 'https://calendar.google.com');
  assert.equal(url.pathname, '/calendar/r');
  assert.deepEqual([...url.searchParams.keys()], ['cid']);
  assert.equal(url.searchParams.get('cid'), webcal(f, 'google'));
}
function assertState(f, provider, value) {
  const toggle = f.query(provider, '[data-calendar-switch]'), status = f.query(provider, '[data-calendar-status]');
  assert.equal(toggle.type, 'checkbox');
  assert.equal(toggle.getAttribute('role'), 'switch');
  assert.equal(toggle.checked, value);
  assert.equal(status.dataset.calendarStatus, value ? 'connected' : 'disconnected');
  assert.equal(status.textContent, value ? 'Включено' : 'Выключено');
}

test('Apple enables through one switch and opens webcal once only after the POST succeeds', async (t) => {
  const f = fixture(t), pending = deferred();
  await f.integrations.mountIntegrations();
  assert.equal(f.openings.length, 0);
  f.setHandler(() => pending.promise);
  const toggle = f.toggle('apple', true);
  assert.equal(toggle.checked, false);
  assert.equal(toggle.disabled, true);
  assert.equal(f.openings.length, 0);
  pending.resolve({ connected: true, credential: credentials.apple });
  await until(() => f.query('apple', '[data-calendar-switch]').checked);
  assertState(f, 'apple', true);
  assert.equal(f.openings.length, 1);
  assert.equal(f.openings[0].target, webcal(f, 'apple'));
  assert.equal(f.openings[0].name, '_self');
  const dialog = f.help('apple');
  const manual = dialog.querySelector('.integration-manual'), input = manual.querySelector('input');
  assert.equal(manual.open, false);
  assert.equal(manual.querySelector('summary').textContent, 'Если календарь не открылся');
  assert.equal(input.value, feed(f, 'apple'));
  assert.equal(input.readOnly, true);
  assert.equal(f.w.localStorage.length, 0);
  assertState(f, 'google', false);
});

test('Apple switches off immediately without confirmation, navigation or another provider mutation', async (t) => {
  const f = fixture(t);
  connected(f, 'apple'); connected(f, 'google');
  await f.integrations.mountIntegrations();
  const google = f.card('google').innerHTML;
  f.toggle('apple', false);
  await until(() => !f.query('apple', '[data-calendar-switch]').checked);
  assertState(f, 'apple', false);
  assert.equal(f.confirmations.length, 0);
  assert.equal(f.openings.length, 0);
  assert.equal(f.card('google').innerHTML, google);
  assert.equal(f.query('apple', 'input[readonly], [data-calendar-launch]'), null);
  assert.deepEqual(f.calls.filter((call) => call.method !== 'GET'),
    [{ route: routes.apple, method: 'DELETE', provider: 'apple' }]);
});

for (const provider of Object.keys(routes)) {
  test('an uncertain ' + provider + ' enable re-reads only that provider without duplicate POST or calendar navigation', async (t) => {
    const f = fixture(t);
    let committed = false;
    f.setHandler(async (_route, options) => {
      if (options?.method === 'POST') {
        committed = true;
        throw Object.assign(Error('Synthetic timeout'), { outcomeUnknown: true });
      }
      return committed ? { connected: true, credential: credentials[provider] } : { connected: false };
    }, provider);
    await f.integrations.mountIntegrations();
    f.toggle(provider, true);
    await until(() => f.query(provider, '[data-calendar-message]')?.textContent === 'Synthetic timeout');
    assertState(f, provider, true);
    for (const name of Object.keys(routes))
      assert.deepEqual(f.calls.filter((call) => call.provider === name).map((call) => call.method),
        name === provider ? ['GET', 'POST', 'GET'] : ['GET']);
    assert.equal(f.openings.length, provider === 'google' ? 1 : 0);
    if (provider === 'google') {
      assert.equal(f.openings[0].popup.location.href, 'about:blank');
      assert.equal(f.openings[0].popup.closed, true);
    }
  });
}

test('shared busy guards restore authorized switch state and block duplicate mutations across both cards', async (t) => {
  const f = fixture(t), pending = deferred();
  await f.integrations.mountIntegrations();
  assert.deepEqual(f.calls.map((call) => call.route).sort(), Object.values(routes).sort());
  f.state.busy = true;
  f.toggle('apple', true); f.toggle('google', true);
  assertState(f, 'apple', false); assertState(f, 'google', false);
  assert.equal(f.calls.length, 2);
  assert.equal(f.openings.length, 0);
  f.state.busy = false;
  f.setHandler(() => pending.promise);
  f.toggle('apple', true); f.toggle('apple', true); f.toggle('google', true);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(f.openings.length, 0);
  for (const provider of Object.keys(routes)) {
    assert.equal(f.query(provider, '[data-calendar-switch]').disabled, true);
    assert.equal(f.query(provider, '[data-calendar-switch]').checked, false);
  }
  f.state.account = { id: 'another-staff', role: 'cosmetologist' };
  pending.resolve({ connected: true, credential: 'old-account-subscription' });
  await delay(0);
  assert.equal(f.openings.length, 0);
  assert.equal(f.query('apple', 'input[readonly], [data-calendar-launch]'), null);
});

test('an administrator can configure either calendar with all active specialists before connecting', async (t) => {
  const f = fixture(t, { role: 'salon_admin' });
  await f.integrations.mountIntegrations();
  assert.deepEqual(f.calls.map((call) => call.route).sort(), Object.values(routes).sort());
  assert.equal(f.openings.length, 0);
  for (const provider of Object.keys(routes)) {
    assertState(f, provider, false);
    assert.equal(f.query(provider, '[data-calendar-mode][value="all"]').checked, true);
    assert.equal(f.query(provider, '[data-calendar-staff-list]').hidden, true);
    assert.equal(f.card(provider).querySelectorAll('[data-calendar-staff]').length, 2);
    assert.equal(f.query(provider, '[data-calendar-save]').disabled, true);
    assert.ok(f.card(provider).textContent.includes('Анна'));
    assert.ok(f.card(provider).textContent.includes('Борис'));
    assert.doesNotMatch(f.card(provider).textContent, /нет личного расписания/);
  }
});

test('roles outside the organization calendar roles still make no subscription requests', async (t) => {
  const f = fixture(t, { role: 'global_admin' });
  await f.integrations.mountIntegrations();
  assert.equal(f.calls.length, 0);
  for (const provider of Object.keys(routes)) assert.equal(f.query(provider, '[data-calendar-switch]'), null);
});

test('cards expose only heading, help, switch and status while manual controls stay in their own closed help dialogs', async (t) => {
  const f = fixture(t);
  connected(f, 'apple'); connected(f, 'google');
  await f.integrations.mountIntegrations();
  assert.equal(f.openings.length, 0);
  for (const provider of Object.keys(routes)) {
    assertState(f, provider, true);
    assert.equal(f.card(provider).querySelectorAll('[data-calendar-switch]').length, 1);
    assert.equal(f.query(provider, '[data-calendar-connect], [data-calendar-disconnect]'), null);
    const dialog = f.query(provider, 'dialog.integration-help-dialog');
    assert.equal(dialog.id, provider + '-calendar-help');
    assert.equal(dialog.open, false);
    const manual = dialog.querySelector('.integration-manual');
    assert.equal(manual.open, false);
    assert.equal(manual.querySelector('summary').textContent, 'Если календарь не открылся');
    for (const control of f.card(provider).querySelectorAll('input[readonly], .integration-manual, [data-calendar-copy], [data-calendar-launch]'))
      assert.equal(control.closest('dialog'), dialog);
    const normal = f.card(provider).cloneNode(true);
    normal.querySelectorAll('dialog').forEach((node) => node.remove());
    assert.equal(normal.querySelector('a, input[readonly], details, [data-calendar-copy]'), null);
    assert.equal(normal.querySelectorAll('button').length, 1);
    const opener = f.query(provider, '.integration-card-heading [data-settings-help]');
    f.help(provider);
    assert.ok(dialog.querySelector('[data-calendar-help-text]').textContent.length);
    dialog.querySelector('[data-calendar-help-close]').click();
    assert.equal(dialog.open, false);
    assert.equal(f.w.document.activeElement, opener);
  }
  const google = f.query('google', 'dialog'), repeat = google.querySelector('[data-calendar-launch]'),
    manual = google.querySelector('[data-calendar-manual-google]');
  assertGoogleTarget(f, repeat.href);
  assert.equal(repeat.target, '_blank');
  for (const anchor of [repeat, manual]) {
    assert.ok(anchor.relList.contains('noopener'));
    assert.ok(anchor.relList.contains('noreferrer'));
    assert.equal(anchor.getAttribute('referrerpolicy'), 'no-referrer');
  }
  assert.equal(manual.href, 'https://calendar.google.com/calendar/u/0/r/settings/addbyurl');
  assert.equal(f.query('google', '#google-calendar-subscription-url').value, feed(f, 'google'));
});

test('Google reserves an isolated no-referrer window synchronously before POST and fills its encoded cid only after success', async (t) => {
  const f = fixture(t, { role: 'owner' }), pending = deferred();
  await f.integrations.mountIntegrations();
  f.setHandler((_route, options) => options?.method === 'POST'
    ? pending.promise
    : Promise.resolve({ connected: false }), 'google');
  const toggle = f.toggle('google', true);
  assert.equal(toggle.checked, false);
  assert.equal(toggle.disabled, true);
  assert.equal(f.openings.length, 1);
  const opening = f.openings[0], popup = opening.popup;
  assert.equal(opening.target, 'about:blank');
  assert.equal(opening.name, '_blank');
  assert.equal(popup.opener, null);
  assert.equal(popup.location.href, 'about:blank');
  assert.equal(popup.document.querySelector('meta[name="referrer"]').content, 'no-referrer');
  assert.ok(f.events.findIndex((event) => event.kind === 'open') <
    f.events.findIndex((event) => event.kind === 'request' && event.method === 'POST'));
  f.toggle('apple', true);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(f.query('apple', '[data-calendar-switch]').checked, false);
  pending.resolve({ connected: true, credential: credentials.google });
  await until(() => f.query('google', '[data-calendar-switch]').checked);
  assertState(f, 'google', true);
  assertGoogleTarget(f, popup.location.href);
  assert.equal(popup.closed, false);
  assert.equal(f.openings.length, 1);
  assertState(f, 'apple', false);
  f.toggle('google', false);
  await until(() => !f.query('google', '[data-calendar-switch]').checked);
  assert.equal(f.confirmations.length, 0);
  assert.equal(f.openings.length, 1);
  assert.deepEqual(f.calls.filter((call) => call.method !== 'GET').map(({ route, method }) => [route, method]),
    [[routes.google, 'POST'], [routes.google, 'DELETE']]);
});

test('Google clipboard is called inside the gesture and success waits for its result without exposing the URL in feedback', async (t) => {
  const f = fixture(t), pending = deferred();
  connected(f, 'google');
  await f.integrations.mountIntegrations();
  f.help('google', true);
  let inGesture = false, copied;
  installClipboard(f, (value) => { assert.equal(inGesture, true); copied = value; return pending.promise; });
  inGesture = true;
  f.query('google', '[data-calendar-copy]').click();
  inGesture = false;
  assert.equal(copied, feed(f, 'google'));
  assert.doesNotMatch(f.query('google', '[data-calendar-message]').textContent, /скопирован/i);
  pending.resolve();
  await until(() => /скопирован/i.test(f.query('google', '[data-calendar-message]').textContent));
  const message = f.query('google', '[data-calendar-message]').textContent;
  assert.match(message, /URL календаря/);
  assert.equal(message.includes(copied), false);
  assert.equal(message.includes(credentials.google), false);
  assert.equal(f.calls.length, 2);
  assert.equal(f.openings.length, 0);
});

test('Google copy cannot run from controls inside a closed help dialog', async (t) => {
  const f = fixture(t);
  connected(f, 'google');
  await f.integrations.mountIntegrations();
  let copied = false;
  installClipboard(f, () => { copied = true; return Promise.resolve(); });
  f.query('google', '[data-calendar-copy]').click();
  assert.equal(copied, false);
  assert.equal(f.query('google', 'dialog').open, false);
  assert.equal(f.query('google', '[data-calendar-message]').textContent, '');
});

for (const mode of ['missing', 'rejected']) {
  test('Google clipboard ' + mode + ' falls back to focused selected readonly text inside help', async (t) => {
    const f = fixture(t), pending = deferred();
    connected(f, 'google');
    await f.integrations.mountIntegrations();
    const dialog = f.help('google', true), manual = dialog.querySelector('.integration-manual');
    if (mode === 'rejected') installClipboard(f, () => pending.promise);
    f.query('google', '[data-calendar-copy]').click();
    if (mode === 'rejected') { manual.open = false; pending.reject(Error('Synthetic clipboard rejection')); }
    const input = f.query('google', '#google-calendar-subscription-url');
    await until(() => manual.open && f.w.document.activeElement === input);
    assert.equal(input.value, feed(f, 'google'));
    assert.equal(input.readOnly, true);
    assert.equal(input.selectionStart, 0);
    assert.equal(input.selectionEnd, input.value.length);
    assert.match(f.query('google', '[data-calendar-message]').textContent, /выдел|вручную|скопируйте/i);
    assert.equal(f.calls.length, 2);
  });
}

test('HTTP and private HTTPS origins retain the same Google switch and manual help without local availability branches', async (t) => {
  for (const url of ['http://localhost:4174/', 'https://localhost/', 'https://10.0.0.2/']) {
    const f = fixture(t, { url });
    connected(f, 'google');
    await f.integrations.mountIntegrations();
    assertState(f, 'google', true);
    const dialog = f.help('google', true), input = dialog.querySelector('input[readonly]');
    assert.equal(input.value, feed(f, 'google'));
    assert.equal(dialog.querySelector('[data-calendar-copy]').disabled, false);
    assertGoogleTarget(f, dialog.querySelector('[data-calendar-launch]').href);
    assert.doesNotMatch(f.card('google').textContent, /Доступно после публикации|локальная Картотека|Локальная ссылка недоступна/);
    dialog.querySelector('[data-calendar-help-close]').click();
    f.toggle('google', false);
    await until(() => !f.query('google', '[data-calendar-switch]').checked);
    f.toggle('google', true);
    await until(() => f.query('google', '[data-calendar-switch]').checked);
    assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
    assertGoogleTarget(f, f.openings[0].popup.location.href);
    assert.equal(f.confirmations.length, 0);
  }
});

for (const method of ['GET', 'POST']) {
  test('a late Google ' + method + ' result cannot expose or launch an old account subscription', async (t) => {
    const f = fixture(t), pending = deferred();
    if (method === 'POST') await f.integrations.mountIntegrations();
    f.setHandler(() => pending.promise, 'google');
    const mounting = method === 'GET' ? f.integrations.mountIntegrations() : null;
    if (method === 'POST') f.toggle('google', true);
    await until(() => f.calls.some((call) => call.provider === 'google' && call.method === method));
    f.state.account = { id: 'another-staff', role: 'cosmetologist' };
    pending.resolve({ connected: true, credential: 'old-google-account-subscription' });
    if (mounting) await mounting; else await delay(0);
    assert.equal(f.query('google', 'input[readonly], [data-calendar-launch]'), null);
    assert.equal(f.card('google').innerHTML.includes('old-google-account-subscription'), false);
    assert.equal(f.openings.length, method === 'POST' ? 1 : 0);
    if (method === 'POST') {
      assert.equal(f.openings[0].popup.location.href, 'about:blank');
      assert.equal(f.openings[0].popup.closed, true);
    }
  });
}

for (const stale of ['account', 'revoked', 'closed-help']) {
  test('a late Google clipboard failure cannot restore feedback for ' + stale, async (t) => {
    const f = fixture(t), pending = deferred();
    connected(f, 'google');
    await f.integrations.mountIntegrations();
    const dialog = f.help('google', true);
    installClipboard(f, () => pending.promise);
    f.query('google', '[data-calendar-copy]').click();
    if (stale === 'account') f.state.account = { id: 'another-staff', role: 'cosmetologist' };
    if (stale === 'closed-help') dialog.querySelector('[data-calendar-help-close]').click();
    if (stale === 'revoked') {
      f.toggle('google', false);
      await until(() => !f.query('google', '[data-calendar-switch]').checked);
    }
    const before = f.card('google').innerHTML;
    pending.reject(Error('Synthetic stale clipboard failure'));
    await delay(0);
    assert.equal(f.card('google').innerHTML, before);
    assert.equal(f.query('google', '[data-calendar-message]').textContent, '');
    if (stale === 'closed-help') assert.equal(dialog.open, false);
  });
}

test('a successful late clipboard result cannot update feedback after help is closed', async (t) => {
  const f = fixture(t), pending = deferred();
  connected(f, 'google');
  await f.integrations.mountIntegrations();
  const dialog = f.help('google', true);
  installClipboard(f, () => pending.promise);
  f.query('google', '[data-calendar-copy]').click();
  dialog.querySelector('[data-calendar-help-close]').click();
  const before = f.card('google').innerHTML;
  pending.resolve();
  await delay(0);
  assert.equal(f.card('google').innerHTML, before);
  assert.equal(f.query('google', '[data-calendar-message]').textContent, '');
  assert.equal(dialog.open, false);
});

for (const outcome of ['success', 'error']) {
  test('a stale Google retry ' + outcome + ' cannot replace a newer connection switched off afterward', async (t) => {
    const f = fixture(t), older = deferred(), newer = deferred();
    let reads = 0;
    f.setHandler(async (_url, options) => {
      if (options?.method === 'DELETE') return { connected: false };
      assert.equal(options?.method || 'GET', 'GET');
      reads++;
      if (reads === 1) throw Error('Synthetic initial Google read failure');
      if (reads === 2) return older.promise;
      if (reads === 3) return newer.promise;
      assert.fail('Unexpected additional Google read');
    }, 'google');
    await f.integrations.mountIntegrations();
    const retry = Array.from(f.card('google').querySelectorAll('button')).find((button) => button.textContent === 'Повторить');
    assert.ok(retry);
    retry.click(); retry.click();
    assert.equal(reads, 3);
    newer.resolve({ connected: true, credential: credentials.google });
    await until(() => f.query('google', '[data-calendar-switch]'));
    f.toggle('google', false);
    await until(() => !f.query('google', '[data-calendar-switch]').checked);
    const before = f.card('google').innerHTML;
    if (outcome === 'success') older.resolve({ connected: true, credential: 'synthetic-revoked-google' });
    else older.reject(Error('Synthetic stale Google read failure'));
    await delay(0);
    assert.equal(f.card('google').innerHTML, before);
    assertState(f, 'google', false);
    assert.equal(f.query('google', 'input[readonly], [data-calendar-launch]'), null);
    assert.equal(f.openings.length, 0);
    assert.deepEqual(f.calls.filter((call) => call.provider === 'google').map((call) => call.method), ['GET', 'GET', 'GET', 'DELETE']);
    assert.deepEqual(f.calls.filter((call) => call.provider === 'apple').map((call) => call.method), ['GET']);
  });
}

for (const mode of ['blocked', 'closed', 'throws', 'setup-error', 'navigation-error']) {
  test('Google popup ' + mode + ' leaves a connected switch and a useful help fallback', async (t) => {
    const f = fixture(t), pending = deferred();
    await f.integrations.mountIntegrations();
    if (mode === 'blocked') f.setOpen(() => null);
    if (mode === 'throws') f.setOpen(() => { throw Error('Synthetic popup failure'); });
    if (mode === 'setup-error') f.setOpen(() => {
      const document = f.w.document.implementation.createHTMLDocument('');
      document.head.append = () => { throw Error('Synthetic popup preparation failure'); };
      return { document, location: { href: 'about:blank' }, opener: {}, closed: false,
        close() { this.closed = true; } };
    });
    f.setHandler(() => pending.promise, 'google');
    f.toggle('google', true);
    const popup = f.openings[0].popup;
    if (mode === 'closed') popup.closed = true;
    if (mode === 'navigation-error') Object.defineProperty(popup.location, 'href', {
      get: () => 'about:blank', set: () => { throw Error('Synthetic popup navigation failure'); },
    });
    pending.resolve({ connected: true, credential: credentials.google });
    await until(() => f.query('google', '[data-calendar-message]').textContent.includes('Нажмите «?»') ||
      f.query('google', '[data-calendar-message]').textContent.includes('нажмите «?»'));
    assertState(f, 'google', true);
    const dialog = f.help('google', true);
    assert.equal(dialog.querySelector('input[readonly]').value, feed(f, 'google'));
    assertGoogleTarget(f, dialog.querySelector('[data-calendar-launch]').href);
    if (popup) assert.equal(popup.closed, true);
  });
}

test('an Apple launch exception preserves the enabled connection and points to manual help', async (t) => {
  const f = fixture(t);
  await f.integrations.mountIntegrations();
  f.setOpen(() => { throw Error('Synthetic Apple navigation failure'); });
  f.toggle('apple', true);
  await until(() => /нажмите «\?»/i.test(f.query('apple', '[data-calendar-message]').textContent));
  assertState(f, 'apple', true);
  assert.equal(f.openings.length, 1);
  assert.equal(f.openings[0].name, '_self');
  assert.equal(f.help('apple', true).querySelector('input[readonly]').value, feed(f, 'apple'));
});

test('a failed Google POST closes its unused reserved window and does not navigate after status reconciliation', async (t) => {
  const f = fixture(t);
  await f.integrations.mountIntegrations();
  f.setHandler(async (_route, options) => {
    if (options?.method === 'POST') throw Error('Synthetic rejected Google mutation');
    return { connected: false };
  }, 'google');
  f.toggle('google', true);
  await until(() => f.query('google', '[data-calendar-message]').textContent === 'Synthetic rejected Google mutation');
  assertState(f, 'google', false);
  assert.equal(f.openings.length, 1);
  assert.equal(f.openings[0].popup.closed, true);
  assert.equal(f.openings[0].popup.location.href, 'about:blank');
  assert.deepEqual(f.calls.filter((call) => call.provider === 'google').map((call) => call.method), ['GET', 'POST', 'GET']);
});

function choose(f, provider, selector, checked = true) {
  const control = f.query(provider, selector);
  control.checked = checked;
  control.dispatchEvent(new f.w.Event('change', { bubbles: true }));
  return control;
}

test('admin explicit save validates empty selection and updates only that provider without connecting or navigating', async (t) => {
  const f = fixture(t, { role: 'salon_admin' });
  await f.integrations.mountIntegrations();
  const google = f.card('google').innerHTML;
  choose(f, 'apple', '[data-calendar-mode][value="selected"]');
  assert.equal(f.query('apple', '[data-calendar-staff-list]').hidden, false);
  assert.equal(f.query('apple', '[data-calendar-save]').disabled, true);
  assert.equal(f.query('apple', '[data-calendar-switch]').disabled, true);
  assert.match(f.query('apple', '[data-calendar-selection-hint]').textContent, /хотя бы одного/);
  f.query('apple', '[data-calendar-save]').click();
  assert.equal(f.calls.length, 2);
  choose(f, 'apple', '[data-calendar-staff][value="a"]');
  assert.equal(f.query('apple', '[data-calendar-save]').disabled, false);
  assert.match(f.query('apple', '[data-calendar-selection-hint]').textContent, /после сохранения/);
  f.query('apple', '[data-calendar-save]').click();
  await until(() => f.query('apple', '[data-calendar-message]').textContent.includes('сохранён'));
  assert.deepEqual(f.calls.filter((call) => call.method === 'PUT'), [{
    route: routes.apple, provider: 'apple', method: 'PUT',
    body: { selection: { mode: 'selected', staffIds: ['a'] }, expectedSelectionRevision: 'apple-revision-1' },
  }]);
  assertState(f, 'apple', false);
  assert.equal(f.query('apple', '[data-calendar-switch]').disabled, false);
  assert.equal(f.query('apple', '[data-calendar-save]').disabled, true);
  assert.equal(f.card('google').innerHTML, google);
  assert.equal(f.openings.length, 0);
  assert.equal(f.w.localStorage.length, 0);
});

test('admin Google selection survives enable and disable and uses the saved scope revision for the next save', async (t) => {
  const f = fixture(t, { role: 'salon_admin' });
  await f.integrations.mountIntegrations();
  choose(f, 'google', '[data-calendar-mode][value="selected"]');
  choose(f, 'google', '[data-calendar-staff][value="b"]');
  f.query('google', '[data-calendar-save]').click();
  await until(() => f.query('google', '[data-calendar-message]').textContent.includes('сохранён'));
  assert.equal(f.openings.length, 0);
  f.toggle('google', true);
  await until(() => f.query('google', '[data-calendar-switch]').checked);
  assertGoogleTarget(f, f.openings[0].popup.location.href);
  assert.equal(f.query('google', '[data-calendar-staff][value="b"]').checked, true);
  f.toggle('google', false);
  await until(() => !f.query('google', '[data-calendar-switch]').checked);
  assert.equal(f.query('google', '[data-calendar-mode][value="selected"]').checked, true);
  assert.equal(f.query('google', '[data-calendar-staff][value="b"]').checked, true);
  choose(f, 'google', '[data-calendar-mode][value="all"]');
  f.query('google', '[data-calendar-save]').click();
  await until(() => f.calls.filter((call) => call.method === 'PUT').length === 2 && !f.query('google', '[data-calendar-switch]').disabled);
  assert.deepEqual(f.calls.filter((call) => call.method === 'PUT')[1].body, {
    selection: { mode: 'all', staffIds: [] }, expectedSelectionRevision: 'google-revision-1-saved',
  });
  assert.equal(f.openings.length, 1);
  assert.deepEqual(f.calls.filter((call) => call.provider === 'google').map((call) => call.method), ['GET', 'PUT', 'POST', 'DELETE', 'PUT']);
});

test('admin selection save disables both cards until completion and prevents duplicate requests', async (t) => {
  const f = fixture(t, { role: 'salon_admin' }), pending = deferred();
  await f.integrations.mountIntegrations();
  f.setHandler(() => pending.promise, 'apple');
  choose(f, 'apple', '[data-calendar-mode][value="selected"]');
  choose(f, 'apple', '[data-calendar-staff][value="a"]');
  f.query('apple', '[data-calendar-save]').click();
  f.query('apple', '[data-calendar-save]').click();
  f.toggle('google', true);
  assert.equal(f.calls.filter((call) => call.method !== 'GET').length, 1);
  for (const provider of Object.keys(routes)) {
    assert.equal(f.query(provider, '[data-calendar-switch]').disabled, true);
    for (const field of f.card(provider).querySelectorAll('[data-calendar-selection] input, [data-calendar-save]'))
      assert.equal(field.disabled, true);
  }
  pending.resolve(adminSnapshot('apple', { mode: 'selected', staffIds: ['a'] }, { selectionRevision: 'apple-revision-2' }));
  await until(() => f.query('apple', '[data-calendar-message]').textContent.includes('сохранён'));
  assert.equal(f.query('apple', '[data-calendar-switch]').disabled, false);
  assert.equal(f.query('google', '[data-calendar-switch]').disabled, false);
  assert.equal(f.openings.length, 0);
});

test('admin stale selection conflict re-reads only that provider and presents the server selection without reconnecting', async (t) => {
  const f = fixture(t, { role: 'salon_admin' });
  await f.integrations.mountIntegrations();
  f.setHandler(async (_route, options) => {
    if (options?.method === 'PUT') throw Object.assign(Error('Synthetic selection conflict'), { status: 409 });
    return adminSnapshot('apple', { mode: 'selected', staffIds: ['b'] }, { selectionRevision: 'apple-revision-2' });
  });
  choose(f, 'apple', '[data-calendar-mode][value="selected"]');
  choose(f, 'apple', '[data-calendar-staff][value="a"]');
  f.query('apple', '[data-calendar-save]').click();
  await until(() => f.query('apple', '[data-calendar-message]').textContent === 'Synthetic selection conflict');
  assert.deepEqual(f.calls.filter((call) => call.provider === 'apple').map((call) => call.method), ['GET', 'PUT', 'GET']);
  assert.deepEqual(f.calls.filter((call) => call.provider === 'google').map((call) => call.method), ['GET']);
  assert.equal(f.query('apple', '[data-calendar-staff][value="a"]').checked, false);
  assert.equal(f.query('apple', '[data-calendar-staff][value="b"]').checked, true);
  assert.equal(f.query('apple', '[data-calendar-save]').disabled, true);
  assertState(f, 'apple', false);
  assert.equal(f.openings.length, 0);
});

test('the other provider finishing its initial read preserves an unsaved administrator selection', async (t) => {
  const f = fixture(t, { role: 'salon_admin' }), google = deferred();
  f.setHandler(() => google.promise, 'google');
  const mounting = f.integrations.mountIntegrations();
  await until(() => f.query('apple', '[data-calendar-mode]'));
  choose(f, 'apple', '[data-calendar-mode][value="selected"]');
  choose(f, 'apple', '[data-calendar-staff][value="a"]');
  google.resolve(adminSnapshot('google'));
  await mounting;
  assert.equal(f.query('apple', '[data-calendar-mode][value="selected"]').checked, true);
  assert.equal(f.query('apple', '[data-calendar-staff][value="a"]').checked, true);
  assert.equal(f.query('apple', '[data-calendar-save]').disabled, false);
  assert.equal(f.query('apple', '[data-calendar-switch]').disabled, true);
  assert.equal(f.query('google', '[data-calendar-switch]').disabled, false);
  assert.equal(f.calls.length, 2);
});

for (const field of ['id', 'organizationId', 'role']) {
  test('late admin selection response cannot update the DOM after same-object ' + field + ' changes', async (t) => {
    const f = fixture(t, { role: 'salon_admin' }), pending = deferred();
    await f.integrations.mountIntegrations();
    f.setHandler(() => pending.promise, 'apple');
    choose(f, 'apple', '[data-calendar-mode][value="selected"]');
    choose(f, 'apple', '[data-calendar-staff][value="a"]');
    f.query('apple', '[data-calendar-save]').click();
    f.state.account[field] = field === 'role' ? 'owner' : 'other-identity';
    const before = f.card('apple').innerHTML;
    pending.resolve(adminSnapshot('apple', { mode: 'selected', staffIds: ['a'] }, { connected: true, credential: 'stale-admin-credential' }));
    await delay(0);
    assert.equal(f.card('apple').innerHTML, before);
    assert.equal(f.query('apple', '[data-calendar-message]').textContent, '');
    assert.equal(f.query('apple', 'input[readonly]'), null);
    assert.equal(f.openings.length, 0);
  });
}

test('admin empty roster explains the state and keeps all available while selected is disabled', async (t) => {
  const f = fixture(t, { role: 'salon_admin' });
  for (const provider of Object.keys(routes)) f.setSnapshot(adminSnapshot(provider, undefined, { specialists: [] }), provider);
  await f.integrations.mountIntegrations();
  for (const provider of Object.keys(routes)) {
    assert.equal(f.query(provider, '[data-calendar-mode][value="all"]').checked, true);
    assert.equal(f.query(provider, '[data-calendar-mode][value="selected"]').disabled, true);
    assert.equal(f.query(provider, '[data-calendar-switch]').disabled, false);
    assert.match(f.query(provider, '[data-calendar-selection-hint]').textContent, /пока нет специалистов/);
  }
});
