const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = path.resolve(__dirname, '../src/client');
const settle = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve();
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const status = (linked = false) => ({
  linked,
  compatible: linked,
  canConnect: true,
  canDisconnect: linked,
  bindingId: linked ? 'synthetic-binding' : '',
});
function fixture(t, { polling = false } = {}) {
  const w = new JSDOM(
    '<section class="telegram-patient-panel"><div id="patient-telegram-body"></div>' +
      '<div id="patient-telegram-connection" data-patient-id="p"></div>' +
      '<div id="patient-max-connection" data-patient-id="p"></div></section>' +
      '<input id="unsaved" value="draft">',
    { runScripts: 'outside-only', pretendToBeVisual: true },
  ).window;
  t.after(() => w.close());
  let now = 100000;
  w.Date.now = () => now;
  const timers = new Map();
  let nextTimer = 0;
  w.setTimeout = (callback, milliseconds) => {
    const id = ++nextTimer;
    timers.set(id, { callback, milliseconds });
    return id;
  };
  w.clearTimeout = (id) => timers.delete(id);
  const state = {
    account: { id: 'owner', organizationId: 'org' },
    currentView: 'card',
    selectedId: 'p',
    multiUser: true,
    busy: false,
    sessionReady: true,
    workspace: {},
    data: [{ id: 'p', appointments: [] }],
  };
  const calls = [],
    summaries = [];
  const handlers = new Map();
  const actions = {
    $: (selector) => w.document.querySelector(selector),
    esc: (value) => String(value),
    request: (url, options = {}) => {
      calls.push({
        url,
        options,
        account: state.account,
        organizationId: state.account?.organizationId,
      });
      if (handlers.has(url)) return handlers.get(url)(options);
      if (url.startsWith('/api/max/patient')) return Promise.resolve(status());
      if (url.startsWith('/api/telegram/patient'))
        return Promise.resolve({
          confirmations: [],
          appointments: [],
          linked: false,
          bot: { connected: true },
        });
      throw Error('Unexpected synthetic route: ' + url);
    },
    updateClientServiceSummary: (...args) => summaries.push(args),
    dismissMaxInvitation() {},
    showMaxInvitation() {},
    toast() {},
    appointmentPanelHtml: () => '<p>Telegram loaded</p>',
    isActiveAppointment: () => true,
    canManageTeam: () => false,
    earlyAccessVisible: () => false,
    improvementsVisible: () => false,
    bookingInboxInterval: () => 30000,
    bookingInboxDeadline: () => now + 30000,
    refreshBookingInbox() {},
    refreshCabinetTimeZone() {},
    updateCurrentTime() {},
    patientView: () => null,
    readPatientTelegramStatus: (id) =>
      actions.request('/api/telegram/patient?patientId=' + encodeURIComponent(id)),
  };
  for (const [file, factory] of [
    ['modules/max-client.js', 'createMaxClient'],
    ...(polling
      ? [
          ['modules/telegram.js', 'createTelegram'],
          ['core/background-refresh.js', 'createBackgroundRefresh'],
        ]
      : []),
  ]) {
    w.eval(fs.readFileSync(path.join(source, file), 'utf8'));
    Object.assign(actions, w[factory](state, actions));
  }
  w.confirm = () => true;
  actions.bindMaxClientEvents();
  return {
    w,
    state,
    actions,
    calls,
    summaries,
    handlers,
    timers,
    advance: (milliseconds) => {
      now += milliseconds;
    },
    count: (prefix) => calls.filter((row) => row.url.startsWith(prefix)).length,
    root: () => actions.$('#patient-max-connection'),
  };
}

test('same card polling and direct reads join one MAX request until settlement, then read freshly', async (t) => {
  const f = fixture(t),
    pending = deferred();
  f.handlers.set('/api/max/patient?patientId=p', () => pending.promise);
  const first = f.actions.loadPatientMax(),
    second = f.actions.loadPatientMax();
  f.advance(4000);
  const third = f.actions.loadPatientMax();
  assert.equal(f.calls.length, 1);
  pending.resolve(status(true));
  await Promise.all([first, second, third]);
  assert.match(f.root().textContent, /Подключён/);
  assert.equal(f.actions.$('#unsaved').value, 'draft');
  f.handlers.delete('/api/max/patient?patientId=p');
  await f.actions.loadPatientMax();
  assert.equal(f.calls.length, 2);
  assert.match(f.root().textContent, /Не подключён/);
  assert.equal(f.timers.size, 0);
});

for (const change of ['organization', 'account-object', 'root', 'patient'])
  test('pending MAX ownership rejects an old response after changing ' + change, async (t) => {
    const f = fixture(t),
      old = deferred(),
      fresh = deferred();
    let index = 0;
    f.handlers.set('/api/max/patient?patientId=p', () =>
      ++index === 1 ? old.promise : fresh.promise,
    );
    const first = f.actions.loadPatientMax();
    const oldSignal = f.calls[0].options.signal;
    if (change === 'organization') f.state.account.organizationId = 'other-org';
    if (change === 'account-object') f.state.account = { ...f.state.account };
    if (change === 'root')
      f.root().outerHTML = '<div id="patient-max-connection" data-patient-id="p"></div>';
    if (change === 'patient') {
      f.state.selectedId = 'other-p';
      f.root().dataset.patientId = 'other-p';
      f.handlers.set('/api/max/patient?patientId=other-p', () => fresh.promise);
    }
    const second = f.actions.loadPatientMax();
    assert.equal(oldSignal.aborted, true);
    fresh.resolve(status(false));
    await second;
    const html = f.root().innerHTML,
      summaries = f.summaries.length;
    old.resolve(status(true)); // Deliberately ignores abort to exercise the response fence.
    await first;
    assert.equal(f.root().innerHTML, html);
    assert.equal(f.summaries.length, summaries);
    assert.equal(f.timers.size, 0);
  });

test('a settled failed read and a timed-out read release ownership for the next poll', async (t) => {
  const f = fixture(t);
  f.handlers.set('/api/max/patient?patientId=p', () => Promise.reject(Error('synthetic outage')));
  await f.actions.loadPatientMax();
  assert.match(f.root().textContent, /Недоступен/);
  f.handlers.set(
    '/api/max/patient?patientId=p',
    ({ signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Error('synthetic abort')), { once: true });
      }),
  );
  const timed = f.actions.loadPatientMax();
  assert.equal(f.timers.size, 1);
  const timer = [...f.timers.values()][0];
  assert.equal(timer.milliseconds, 12000);
  timer.callback();
  await timed;
  assert.equal(f.calls[1].options.signal.aborted, true);
  assert.equal(f.timers.size, 0);
  f.handlers.delete('/api/max/patient?patientId=p');
  await f.actions.loadPatientMax();
  assert.equal(f.calls.length, 3);
  assert.match(f.root().textContent, /Не подключён/);
});

test('unlink completes before a fresh read and an older polling result cannot restore the binding', async (t) => {
  const f = fixture(t),
    old = deferred();
  f.handlers.set('/api/max/patient?patientId=p', () => Promise.resolve(status(true)));
  await f.actions.loadPatientMax();
  f.handlers.set('/api/max/patient?patientId=p', () => old.promise);
  const poll = f.actions.loadPatientMax(),
    oldSignal = f.calls.at(-1).options.signal;
  f.handlers.set('/api/max/unlink', () => Promise.resolve({ linked: false }));
  f.handlers.set('/api/max/patient?patientId=p', () => Promise.resolve(status(false)));
  f.actions.$('[data-max-unlink]').click();
  await settle();
  const post = f.calls.find((row) => row.url === '/api/max/unlink');
  assert.deepEqual(JSON.parse(post.options.body), {
    patientId: 'p',
    bindingId: 'synthetic-binding',
  });
  assert.equal(oldSignal.aborted, true);
  assert.equal(f.count('/api/max/patient'), 3);
  assert.match(f.root().textContent, /Не подключён/);
  old.resolve(status(true));
  await poll;
  assert.match(f.root().textContent, /Не подключён/);
  assert.equal(f.state.busy, false);
  assert.equal(f.actions.$('#unsaved').value, 'draft');
});

test('link preparation also requests post-write status instead of reusing a pre-link poll', async (t) => {
  const f = fixture(t),
    old = deferred();
  await f.actions.loadPatientMax();
  f.handlers.set('/api/max/patient?patientId=p', () => old.promise);
  const poll = f.actions.loadPatientMax(),
    oldSignal = f.calls.at(-1).options.signal;
  const invitation = { url: 'https://max.ru/synthetic', expiresAt: 200000 };
  f.handlers.set('/api/max/link', () => Promise.resolve(invitation));
  f.handlers.set('/api/max/patient?patientId=p', () => Promise.resolve(status(false)));
  let shown;
  f.actions.showMaxInvitation = (value) => {
    shown = value;
  };
  f.actions.$('[data-max-link]').click();
  await settle();
  assert.equal(f.count('/api/max/link'), 1);
  assert.equal(f.count('/api/max/patient'), 3);
  assert.equal(oldSignal.aborted, true);
  assert.equal(shown.patientId, 'p');
  assert.match(f.root().textContent, /Приглашение/);
  old.resolve(status(true));
  await poll;
  assert.match(f.root().textContent, /Приглашение/);
});

test('two isolated tab instances do not share pending MAX reads or results', async (t) => {
  const a = fixture(t),
    b = fixture(t),
    one = deferred(),
    two = deferred();
  a.handlers.set('/api/max/patient?patientId=p', () => one.promise);
  b.handlers.set('/api/max/patient?patientId=p', () => two.promise);
  const first = a.actions.loadPatientMax(),
    second = b.actions.loadPatientMax();
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 1);
  one.resolve(status(true));
  two.resolve(status(false));
  await Promise.all([first, second]);
  assert.match(a.root().textContent, /Подключён/);
  assert.match(b.root().textContent, /Не подключён/);
});

test('the actual four-second pump continues Telegram reads while one slow MAX read is shared', async (t) => {
  const f = fixture(t, { polling: true }),
    slow = deferred();
  f.handlers.set('/api/max/patient?patientId=p', () => slow.promise);
  const first = f.actions.refreshBackground();
  await settle();
  assert.match(f.actions.$('#patient-telegram-body').textContent, /Telegram loaded/);
  assert.equal(f.count('/api/telegram/patient'), 1);
  assert.equal(f.count('/api/max/patient'), 1);
  f.advance(4000);
  const second = f.actions.refreshBackground();
  await settle();
  f.advance(4000);
  const third = f.actions.refreshBackground();
  await settle();
  assert.equal(f.count('/api/telegram/patient'), 3);
  assert.equal(f.count('/api/max/patient'), 1);
  slow.resolve(status(true));
  await Promise.all([first, second, third]);
  f.handlers.delete('/api/max/patient?patientId=p');
  f.advance(3999);
  await f.actions.refreshBackground();
  assert.equal(f.count('/api/max/patient'), 1);
  f.advance(1);
  await f.actions.refreshBackground();
  assert.equal(f.count('/api/max/patient'), 2);
  assert.equal(f.count('/api/telegram/patient'), 4);
  Object.defineProperty(f.w.document, 'hidden', { configurable: true, value: true });
  f.advance(4000);
  await f.actions.refreshBackground();
  assert.equal(f.count('/api/max/patient'), 2);
});

for (const change of ['root-disconnect', 'account-and-DOM', 'pagehide', 'hidden'])
  test('an obsolete MAX read aborts its actual transport after ' + change, async (t) => {
    const f = fixture(t),
      old = deferred();
    f.handlers.set('/api/max/patient?patientId=p', () => old.promise);
    const first = f.actions.loadPatientMax(),
      signal = f.calls[0].options.signal;
    if (change === 'root-disconnect') f.root().remove();
    if (change === 'account-and-DOM') {
      f.state.account = { id: 'other-account', organizationId: 'other-org' };
      f.actions.$('#unsaved').outerHTML = '<input id="unsaved" value="other draft">';
    }
    if (change === 'pagehide') f.w.dispatchEvent(new f.w.Event('pagehide'));
    if (change === 'hidden') {
      Object.defineProperty(f.w.document, 'hidden', { configurable: true, value: true });
      f.w.document.dispatchEvent(new f.w.Event('visibilitychange'));
    }
    await settle();
    assert.equal(signal.aborted, true);
    const summaries = f.summaries.length;
    old.resolve(status(true));
    await first;
    assert.equal(f.summaries.length, summaries);
    assert.equal(f.timers.size, 0);
  });

for (const outcome of ['success', 'failure'])
  test(
    'closing the actual owning JSDOM window during a MAX read safely settles ' + outcome,
    async (t) => {
      const f = fixture(t),
        pending = deferred();
      f.handlers.set('/api/max/patient?patientId=p', () => pending.promise);
      const owningDocument = f.w.document,
        savedRoot = f.root(),
        before = savedRoot.innerHTML,
        summaries = f.summaries.length;
      const observed = f.actions.loadPatientMax().then(
        () => ({ status: 'fulfilled' }),
        (error) => ({ status: 'rejected', error }),
      );
      let lateLookups = 0;
      const lookup = f.actions.$;
      f.actions.$ = (selector) => {
        lateLookups++;
        return lookup(selector);
      };
      f.w.close(); // Real teardown removes Window.document; no optional fake DOM cleanup.
      assert.equal(f.w.document, undefined);
      assert.equal(savedRoot.isConnected, false);
      if (outcome === 'success') pending.resolve(status(true));
      else pending.reject(Error('synthetic failure after actual window close'));
      const result = await observed;
      await settle();
      await new Promise(setImmediate);
      assert.equal(result.status, 'fulfilled', result.error?.stack);
      assert.equal(
        lateLookups,
        0,
        'detached-root fence must run before the global-document lookup',
      );
      assert.equal(savedRoot.innerHTML, before);
      assert.equal(f.summaries.length, summaries);
      assert.equal(f.timers.size, 0);
    },
  );
