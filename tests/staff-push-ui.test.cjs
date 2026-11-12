const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../src/client/modules/staff-push.js'), 'utf8');
const delay = () => new Promise((resolve) => setImmediate(resolve));
async function until(fn) {
  for (let i = 0; i < 80; i++) {
    if (fn()) return;
    await delay();
  }
  throw Error('Push UI timeout');
}
function fixture(t, width, supported = true, { mount = true, hidden = false } = {}) {
  const w = new JSDOM('<div id="staff-push"></div>', {
    runScripts: 'outside-only',
    url: 'https://synthetic.test/',
    pretendToBeVisual: true,
  }).window;
  w.document.querySelector('#staff-push').hidden = hidden;
  t.after(() => w.close());
  const listeners = new Map(),
    addListener = w.addEventListener.bind(w),
    removeListener = w.removeEventListener.bind(w);
  w.addEventListener = (name, callback, options) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(callback);
    addListener(name, callback, options);
  };
  w.removeEventListener = (name, callback, options) => {
    listeners.get(name)?.delete(callback);
    removeListener(name, callback, options);
  };
  Object.defineProperty(w, 'innerWidth', { value: width });
  Object.defineProperty(w, 'isSecureContext', { value: true });
  let permissionCalls = 0,
    subscribed = false,
    unsubscribed = 0;
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic',
    toJSON: () => ({ endpoint: 'synthetic' }),
    unsubscribe: async () => {
      unsubscribed++;
      subscribed = false;
      return true;
    },
  };
  const registration = {
    pushManager: {
      getSubscription: async () => (subscribed ? subscription : null),
      subscribe: async () => {
        subscribed = true;
        return subscription;
      },
    },
  };
  if (supported) {
    w.PushManager = function () {};
    w.Notification = {
      permission: 'default',
      requestPermission: async () => {
        permissionCalls++;
        w.Notification.permission = 'granted';
        return 'granted';
      },
    };
    Object.defineProperty(w.navigator, 'serviceWorker', {
      value: { getRegistration: async () => registration },
    });
  }
  const state = {
    account: { id: 'user', organizationId: 'org' },
    currentView: 'settings',
    multiUser: true,
  };
  const posts = [],
    opened = [];
  let status = {
    prepared: true,
    available: true,
    bindingExpectation: 'staff-push-binding-expectation-v1:' + '1'.repeat(64),
    publicKey: Buffer.alloc(65, 4).toString('base64url'),
    device: null,
    preferences: {
      events: ['new-request', 'confirmation', 'change', 'reminder'],
      leadMinutes: 120,
      reminderMode: 'workday',
    },
  };
  const actions = {
    $: (s) => w.document.querySelector(s),
    esc: (s) => String(s).replace(/</g, '&lt;'),
    confirmAction: async () => true,
    markSettingsSaved() {},
    request: async (url, options) => {
      const body = JSON.parse(options.body);
      posts.push({ url, body });
      if (url.endsWith('/connect'))
        status.device = { id: 'device', enabled: true, preferences: status.preferences };
      if (url.endsWith('/disconnect')) status.device = null;
      if (url.endsWith('/settings')) status.device.preferences = body.preferences;
      return structuredClone(status);
    },
    toast: (text) => opened.push(text),
    setView: async (view) => opened.push(view),
    openManagement: async (section) => opened.push(section),
    ensurePatient: async (id) => ({ id, appointments: [{ id: 'appointment' }] }),
    openAppointmentActions: async (a) => opened.push(a.id),
  };
  require('./helpers/staff-channel-ui.cjs').installStaffChannelUI(w, state, actions);
  w.eval(fs.readFileSync(path.join(__dirname, '../src/client/modules/settings-pages.js'), 'utf8'));
  Object.assign(actions, w.eval('createSettingsPages')(state, actions));
  w.eval(source);
  const ui = w.eval('createStaffPushUI')(state, actions);
  if (mount) ui.mountStaffPush();
  return {
    w,
    ui,
    state,
    actions,
    posts,
    opened,
    registration,
    listeners: (name) => listeners.get(name)?.size || 0,
    permissionCalls: () => permissionCalls,
    unsubscribed: () => unsubscribed,
    getStatus: () => structuredClone(status),
    setStatus: (value) => {
      status = { ...status, ...value };
    },
  };
}

async function flushPushMicrotasks() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
function deferredPushRead() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('personal status rendering defers push reads so one initial visible refresh sends exactly one status POST', async (t) => {
  const f = fixture(t, 390, true, { mount: false }),
    staff = deferredPushRead();
  f.w.Date.now = () => 100000;
  f.w.document.body.innerHTML = '<div id="staff-notifications"></div>';
  f.state.roleNames = {};
  Object.assign(f.actions, f.ui, {
    canManageTeam: () => true,
    readBackground: () => staff.promise,
    settingsHelpHtml: () => '',
  });
  f.w.eval(
    fs.readFileSync(path.join(__dirname, '../src/client/modules/staff-notifications.js'), 'utf8'),
  );
  const personal = f.w.eval('createStaffNotifications')(f.state, f.actions);
  personal.mountStaffNotifications();
  const refresh = personal.syncStaffNotifications();
  await flushPushMicrotasks();
  assert.equal(f.posts.filter((post) => post.url.endsWith('/status')).length, 0);
  staff.resolve({ linked: false, available: true, prepared: true, bot: { connected: true } });
  await refresh;
  await flushPushMicrotasks();
  assert.equal(f.posts.filter((post) => post.url.endsWith('/status')).length, 1);
  await personal.syncStaffNotifications({ force: false });
  personal.mountStaffNotifications();
  await flushPushMicrotasks();
  assert.equal(f.posts.filter((post) => post.url.endsWith('/status')).length, 1);
});

test('a hidden push root performs no status POST on mount or explicit refresh', async (t) => {
  const f = fixture(t, 390, true, { hidden: true });
  await flushPushMicrotasks();
  await f.ui.syncStaffPush();
  assert.equal(f.posts.length, 0);
  f.actions.$('#staff-push').hidden = false;
  await f.ui.syncStaffPush();
  assert.equal(f.posts.filter((post) => post.url.endsWith('/status')).length, 1);
  assert.equal(f.permissionCalls(), 0);
});

for (const stage of ['registration', 'subscription'])
  test(
    'push rechecks visibility after asynchronous ' + stage + ' before status POST',
    async (t) => {
      const f = fixture(t, 390, true, { mount: false }),
        pending = deferredPushRead();
      let entered = false;
      if (stage === 'registration')
        f.w.navigator.serviceWorker.getRegistration = () => {
          entered = true;
          return pending.promise;
        };
      else
        f.registration.pushManager.getSubscription = () => {
          entered = true;
          return pending.promise;
        };
      f.ui.mountStaffPush();
      await flushPushMicrotasks();
      assert.equal(entered, true);
      f.actions.$('#staff-push').hidden = true;
      pending.resolve(stage === 'registration' ? f.registration : null);
      await flushPushMicrotasks();
      assert.equal(f.posts.length, 0);
    },
  );

test('an old push lookup finishing after a scope change cannot start a POST for the new hidden root', async (t) => {
  const f = fixture(t, 390, true, { mount: false }),
    pending = deferredPushRead(),
    request = f.actions.request;
  f.actions.request = async (url, options) => {
    const result = await request(url, options);
    await pending.promise;
    return result;
  };
  f.ui.mountStaffPush();
  await flushPushMicrotasks();
  assert.equal(f.posts.filter((post) => post.url.endsWith('/status')).length, 1);
  f.w.document.body.innerHTML = '<div id="staff-push" hidden></div>';
  f.state.account = { id: 'other-user', organizationId: 'other-org' };
  f.ui.mountStaffPush({ refresh: false });
  pending.resolve();
  await flushPushMicrotasks();
  assert.equal(f.posts.filter((post) => post.url.endsWith('/status')).length, 1);
});

test('pagehide explicitly cancels only the pending push status lookup', async (t) => {
  const f = fixture(t, 390),
    original = f.actions.request;
  let pendingSignal;
  f.actions.request = (url, options) => {
    if (!url.endsWith('/status')) return original(url, options);
    pendingSignal = options.signal;
    assert.equal(options.method, 'POST');
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Error('Synthetic status cancelled')), {
        once: true,
      });
    });
  };
  await until(() => pendingSignal);
  assert.equal(pendingSignal.aborted, false);
  f.w.dispatchEvent(new f.w.Event('pagehide'));
  assert.equal(pendingSignal.aborted, true);
  await delay();
  f.actions.request = original;
  await f.ui.syncStaffPush();
  assert.ok(f.actions.$('[data-push-connect]'));
});

test('completed push status is cleaned up before pagehide and later lookups still work', async (t) => {
  const f = fixture(t, 390),
    original = f.actions.request,
    signals = [];
  f.actions.request = (url, options) => {
    if (url.endsWith('/status')) signals.push(options.signal);
    return original(url, options);
  };
  await until(() => f.actions.$('[data-push-connect]')?.disabled === false);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, false);
  f.w.dispatchEvent(new f.w.Event('pagehide'));
  assert.equal(signals[0].aborted, false);
  await f.ui.syncStaffPush();
  assert.equal(signals.length, 2);
  f.w.dispatchEvent(new f.w.Event('pagehide'));
  assert.ok(signals.every((signal) => !signal.aborted));
  assert.equal(f.listeners('beforeunload'), 0);
});

test('beforeunload aborts pending push status without prompting and removes its temporary listener', async (t) => {
  const f = fixture(t, 390),
    original = f.actions.request;
  let signal;
  f.actions.request = (url, options) => {
    if (!url.endsWith('/status')) return original(url, options);
    signal = options.signal;
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Error('Synthetic status cancelled')), {
        once: true,
      });
    });
  };
  await until(() => signal);
  assert.equal(f.listeners('beforeunload'), 1);
  const leaving = new f.w.Event('beforeunload', { cancelable: true });
  assert.equal(f.w.dispatchEvent(leaving), true);
  assert.equal(leaving.defaultPrevented, false);
  assert.equal(leaving.returnValue, true);
  assert.equal(signal.aborted, true);
  await delay();
  assert.equal(f.listeners('beforeunload'), 0);
  f.actions.request = original;
  await f.ui.syncStaffPush();
  assert.ok(f.actions.$('[data-push-connect]'));
  assert.equal(f.listeners('beforeunload'), 0);
});

test('push connect, preferences, test and disconnect remain unsignalled during pagehide', async (t) => {
  const f = fixture(t, 390),
    original = f.actions.request;
  await until(() => f.actions.$('[data-push-connect]')?.disabled === false);
  let pending;
  f.actions.request = async (url, options) => {
    const result = await original(url, options);
    if (url.endsWith('/status')) return result;
    let release;
    const wait = new Promise((resolve) => {
      release = resolve;
    });
    pending = { url, options, release };
    await wait;
    return result;
  };
  const checkHeld = async (suffix) => {
    await until(() => pending?.url.endsWith('/' + suffix));
    assert.equal(pending.options.method, 'POST');
    assert.equal(pending.options.signal, undefined);
    f.w.dispatchEvent(new f.w.Event('pagehide'));
    assert.equal(pending.options.signal, undefined);
    const leaving = new f.w.Event('beforeunload', { cancelable: true });
    assert.equal(f.w.dispatchEvent(leaving), true);
    assert.equal(leaving.defaultPrevented, false);
    assert.equal(pending.options.signal, undefined);
    assert.equal(f.listeners('beforeunload'), 0);
    pending.release();
    pending = null;
    await delay();
    await delay();
  };
  f.actions.$('[data-push-connect]').click();
  await checkHeld('connect');
  await until(() => f.actions.$('[data-push-test]'));
  const preferences = f.actions.$('[data-push-preferences]');
  preferences.dispatchEvent(new f.w.Event('submit', { bubbles: true, cancelable: true }));
  await checkHeld('settings');
  await until(() => !f.actions.$('fieldset').disabled);
  f.actions.$('[data-push-test]').click();
  await checkHeld('test');
  await until(() => !f.actions.$('fieldset').disabled);
  f.actions.$('[data-push-disconnect]').click();
  await checkHeld('disconnect');
  await until(
    () =>
      f.posts.some((post) => post.url.endsWith('/disconnect')) &&
      !!f.actions.$('[data-push-connect]'),
  );
  assert.equal(f.unsubscribed(), 0);
  assert.ok(f.posts.some((post) => post.url.endsWith('/connect')));
  assert.ok(f.posts.some((post) => post.url.endsWith('/settings')));
  assert.ok(f.posts.some((post) => post.url.endsWith('/test')));
  assert.ok(f.posts.some((post) => post.url.endsWith('/disconnect')));
});

for (const width of [320, 390, 1440])
  test('push controls, explicit permission, preferences and disconnect at ' + width, async (t) => {
    const f = fixture(t, width);
    await until(() => f.actions.$('[data-push-connect]')?.disabled === false);
    assert.equal(f.permissionCalls(), 0);
    f.actions.$('[data-push-connect]').click();
    await until(() => f.actions.$('[data-push-test]'));
    assert.equal(f.permissionCalls(), 1);
    assert.equal(f.actions.$('.connection-push').classList.contains('is-linked'), true);
    assert.match(f.actions.$('.staff-channel-status').textContent, /Включены/);
    f.actions.$('[data-push-test]').click();
    await until(
      () => f.posts.some((p) => p.url.endsWith('/test')) && !f.actions.$('fieldset').disabled,
    );
    const form = f.actions.$('[data-push-preferences]');
    assert.equal(form.querySelector('[value="change"]'), null);
    assert.equal(form.querySelectorAll('[name="event"]').length, 11);
    form.querySelector('[value="moved"]').checked = false;
    form.querySelector('select').value = '45';
    form.dispatchEvent(new f.w.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => f.posts.some((p) => p.url.endsWith('/settings')));
    assert.equal(f.posts.at(-1).body.preferences.leadMinutes, 45);
    await until(() => !f.actions.$('fieldset').disabled);
    f.actions.confirmAction = async () => false;
    f.actions.$('[data-push-disconnect]').click();
    await delay();
    await delay();
    assert.equal(f.unsubscribed(), 0);
    f.actions.confirmAction = async () => true;
    f.actions.$('[data-push-disconnect]').click();
    await until(
      () =>
        f.posts.some((post) => post.url.endsWith('/disconnect')) &&
        !!f.actions.$('[data-push-connect]'),
    );
    assert.equal(f.unsubscribed(), 0);
    assert.ok(f.posts.every((p) => !/telegram|max/.test(p.url)));
  });
test('unsupported browser explains iPhone installation without permission prompt', async (t) => {
  const f = fixture(t, 390, false);
  await until(() => f.posts.length);
  assert.match(f.w.document.body.textContent, /главный экран/);
  assert.equal(f.permissionCalls(), 0);
  assert.equal(f.actions.$('[data-push-connect]'), null);
});
test('push navigation is scoped and opens authorized appointment or requests', async (t) => {
  const f = fixture(t, 390);
  f.w.location.hash =
    'staff-push=' +
    encodeURIComponent(
      JSON.stringify({
        accountId: 'user',
        organizationId: 'other',
        patientId: 'p',
        id: 'appointment',
      }),
    );
  await f.ui.openStaffPushTarget();
  assert.match(f.opened[0], /другой организации/);
  f.w.location.hash =
    'staff-push=' +
    encodeURIComponent(
      JSON.stringify({
        accountId: 'user',
        organizationId: 'org',
        patientId: 'p',
        id: 'appointment',
      }),
    );
  await f.ui.openStaffPushTarget();
  assert.equal(f.opened.at(-1), 'appointment');
  f.w.location.hash =
    'staff-push=' +
    encodeURIComponent(
      JSON.stringify({ accountId: 'user', organizationId: 'org', kind: 'request' }),
    );
  await f.ui.openStaffPushTarget();
  assert.equal(f.opened.at(-1), 'requests');
});
test('service worker shows neutral push and opens same origin without replacing unsaved tab', async () => {
  const handlers = {},
    notifications = [],
    windows = [];
  const self = {
    location: { origin: 'https://synthetic.test' },
    addEventListener: (name, cb) => (handlers[name] = cb),
    registration: { showNotification: async (...args) => notifications.push(args) },
    clients: {
      matchAll: async () => [
        {
          url: 'https://synthetic.test/',
          navigate: () => {
            throw Error('Do not replace editors');
          },
        },
      ],
      openWindow: async (url) => windows.push(url),
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../src/client/pwa/service-worker.js'), 'utf8'),
    { self, URL, Set },
  );
  let pending;
  handlers.push({
    data: {
      json: () => ({
        title: 'Картотека',
        body: 'Скоро начало рабочего дня.',
        data: { event: 'reminder', url: '/#staff-push=synthetic' },
      }),
    },
    waitUntil: (p) => (pending = p),
  });
  await pending;
  assert.equal(notifications.length, 1);
  handlers.notificationclick({
    notification: { close: () => {}, data: { url: '/#staff-push=synthetic' } },
    waitUntil: (p) => (pending = p),
  });
  await pending;
  assert.equal(windows[0], 'https://synthetic.test/#staff-push=synthetic');
  handlers.notificationclick({
    notification: { close: () => {}, data: { url: '//evil.test/' } },
    waitUntil: (p) => (pending = p),
  });
  await pending;
  assert.equal(windows.length, 1);
});

const pushCategories = [
  'new-request',
  'confirmation',
  'created',
  'moved',
  'cancelled',
  'completed',
  'no_show',
  'restored',
  'removed',
  'updated',
  'reminder',
];
const selectedPushEvents = (form) =>
  [...form.querySelectorAll('[name="event"]:checked')].map((field) => field.value);
function selectPushEvents(f, form, events) {
  for (const field of form.querySelectorAll('[name="event"]'))
    field.checked = events.includes(field.value);
  form.querySelector('[name="event"]').dispatchEvent(new f.w.Event('change', { bubbles: true }));
}
async function connectedPush(t) {
  const f = fixture(t, 390);
  await until(() => f.actions.$('[data-push-connect]')?.disabled === false);
  f.actions.$('[data-push-connect]').click();
  await until(() => f.actions.$('[data-push-preferences] fieldset')?.disabled === false);
  return f;
}

test('legacy Push change expands into individual categories and saves granular events without a legacy umbrella', async (t) => {
  const f = await connectedPush(t);
  const form = f.actions.$('[data-push-preferences]');
  assert.deepEqual(selectedPushEvents(form), pushCategories);
  assert.equal(form.querySelector('[value="change"]'), null);
  selectPushEvents(
    f,
    form,
    pushCategories.filter((event) => event !== 'moved'),
  );
  form.dispatchEvent(new f.w.Event('submit', { bubbles: true, cancelable: true }));
  await until(
    () =>
      f.posts.some((post) => post.url.endsWith('/settings')) &&
      !f.actions.$('[data-push-preferences] fieldset').disabled,
  );
  const settings = f.posts.find((post) => post.url.endsWith('/settings')).body;
  assert.equal(settings.deviceId, 'device');
  assert.deepEqual(
    settings.preferences.events,
    pushCategories.filter((event) => event !== 'moved'),
  );
  assert.equal(settings.preferences.leadMinutes, 120);
  assert.equal(f.unsubscribed(), 0);
});

test('Push draft and reminder visibility survive same-device status polling', async (t) => {
  const f = await connectedPush(t);
  let form = f.actions.$('[data-push-preferences]');
  selectPushEvents(f, form, ['created', 'cancelled']);
  form.querySelector('[name="leadMinutes"]').value = '45';
  form
    .querySelector('[name="leadMinutes"]')
    .dispatchEvent(new f.w.Event('change', { bubbles: true }));
  assert.equal(form.querySelector('[data-push-reminder]').hidden, true);
  const server = f.getStatus();
  f.setStatus({
    device: {
      ...server.device,
      preferences: { events: ['confirmation', 'reminder'], leadMinutes: 30 },
    },
  });
  await f.ui.syncStaffPush();
  form = f.actions.$('[data-push-preferences]');
  assert.deepEqual(selectedPushEvents(form), ['created', 'cancelled']);
  assert.equal(form.querySelector('[name="leadMinutes"]').value, '45');
  assert.equal(form.querySelector('[data-push-reminder]').hidden, true);
  selectPushEvents(f, form, ['created', 'reminder']);
  assert.equal(form.querySelector('[data-push-reminder]').hidden, false);
});

test('Push save failure retains its draft and saving an empty selection keeps the device connected', async (t) => {
  const f = await connectedPush(t),
    original = f.actions.request;
  selectPushEvents(f, f.actions.$('[data-push-preferences]'), ['moved', 'no_show']);
  f.actions.request = async (url, options) => {
    if (url.endsWith('/settings')) throw Error('Synthetic Push preferences failure');
    return original(url, options);
  };
  f.actions
    .$('[data-push-preferences]')
    .dispatchEvent(new f.w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => f.w.document.body.textContent.includes('Synthetic Push preferences failure'));
  assert.deepEqual(selectedPushEvents(f.actions.$('[data-push-preferences]')), [
    'moved',
    'no_show',
  ]);
  assert.equal(f.actions.$('[data-push-preferences] fieldset').disabled, false);
  f.actions.request = original;
  selectPushEvents(f, f.actions.$('[data-push-preferences]'), []);
  f.actions
    .$('[data-push-preferences]')
    .dispatchEvent(new f.w.Event('submit', { bubbles: true, cancelable: true }));
  await until(
    () =>
      f.posts.some((post) => post.url.endsWith('/settings')) &&
      !f.actions.$('[data-push-preferences] fieldset').disabled,
  );
  assert.deepEqual(
    f.posts.find((post) => post.url.endsWith('/settings')).body.preferences.events,
    [],
  );
  assert.match(f.actions.$('.staff-channel-status').textContent, /События не выбраны/);
  assert.ok(f.actions.$('[data-push-disconnect]'));
  assert.equal(f.unsubscribed(), 0);
});

for (const reason of ['unavailable', 'denied'])
  test('connected Push controls are disabled when ' + reason, async (t) => {
    const f = await connectedPush(t);
    if (reason === 'unavailable') f.setStatus({ available: false });
    else f.w.Notification.permission = 'denied';
    await f.ui.syncStaffPush();
    assert.equal(f.actions.$('[data-push-preferences] fieldset').disabled, true);
    assert.equal(
      f.actions.$('[data-push-preferences] button[type="submit"]').matches(':disabled'),
      true,
    );
    assert.equal(f.actions.$('[data-push-test]').matches(':disabled'), true);
    assert.equal(f.permissionCalls(), 1, 'background refresh must not ask for permission again');
    assert.equal(f.posts.filter((post) => post.url.endsWith('/settings')).length, 0);
  });

function sharedPushSlot(f, name = 'B') {
  const calls = { subscribe: 0, unsubscribe: [] };
  const make = (owner) => ({
    endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-' + owner,
    toJSON: () => ({
      endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-' + owner,
      keys: { p256dh: 'synthetic-public-key-' + owner, auth: 'synthetic-auth-' + owner },
    }),
    unsubscribe: async () => {
      calls.unsubscribe.push(owner);
      return true;
    },
  });
  let current = make(name);
  f.registration.pushManager.getSubscription = async () => current;
  f.registration.pushManager.subscribe = async () => {
    calls.subscribe++;
    current = make('new');
    return current;
  };
  return {
    calls,
    get: () => current,
    set: (value) => {
      current = value;
    },
    make,
  };
}
const pushContextRefusal = () =>
  Object.assign(Error('Synthetic cookie B'), {
    status: 428,
    code: 'AUTH_CONTEXT_CHANGED',
    outcomeUnknown: false,
  });

for (const outcome of ['success', 'unknown-device', 'context428', 'network']) {
  test('logout never removes a shared browser subscription: ' + outcome, async (t) => {
    const f = fixture(t, 390, true, { mount: false });
    f.state.account = { id: 'A', organizationId: 'org-A' };
    const slot = sharedPushSlot(f, 'B'),
      calls = [];
    const refusal =
      outcome === 'context428' ? pushContextRefusal() : TypeError('Synthetic offline');
    f.actions.request = async (route, options) => {
      calls.push({ route, body: JSON.parse(options.body) });
      assert.equal(
        f.state.account.id,
        'A',
        'The known page actor remains A; the cookie is modeled as B',
      );
      if (outcome === 'context428' || outcome === 'network') throw refusal;
      return { ...f.getStatus(), device: outcome === 'unknown-device' ? null : { id: 'A-device' } };
    };
    const leaving = f.ui.disconnectPushOnLogout();
    if (outcome === 'context428' || outcome === 'network')
      await assert.rejects(leaving, (error) => error === refusal);
    else await leaving;
    assert.equal(calls.filter((call) => call.route.endsWith('/status')).length, 1);
    assert.equal(
      calls.filter((call) => call.route.endsWith('/disconnect')).length,
      outcome === 'success' ? 1 : 0,
    );
    assert.deepEqual(
      slot.calls.unsubscribe,
      [],
      'No origin-wide mutation is authorized by account logout',
    );
    assert.equal(slot.calls.subscribe, 0);
  });
}

for (const outcome of ['success', 'context428', 'network']) {
  test(
    'explicit connect reuses the existing shared subscription without removing it: ' + outcome,
    async (t) => {
      const f = fixture(t, 390);
      await until(() => f.actions.$('[data-push-connect]')?.disabled === false);
      const slot = sharedPushSlot(f, 'B'),
        original = slot.get(),
        calls = [];
      f.actions.request = async (route, options) => {
        calls.push({ route, body: JSON.parse(options.body) });
        if (outcome === 'context428') throw pushContextRefusal();
        if (outcome === 'network') throw TypeError('Synthetic offline');
        if (route.endsWith('/status')) return { ...f.getStatus(), device: null };
        return {
          ...f.getStatus(),
          device: { id: 'new-owned-device', enabled: true, preferences: f.getStatus().preferences },
        };
      };
      f.actions.$('[data-push-connect]').click();
      await until(() => calls.length > 0);
      await flushPushMicrotasks();
      const binding = calls.find((call) => call.route.endsWith('/connect'));
      if (outcome === 'success') assert.ok(binding);
      if (binding) assert.deepEqual(binding.body.subscription, original.toJSON());
      assert.deepEqual(slot.calls.unsubscribe, []);
      assert.equal(slot.calls.subscribe, 0, 'An existing origin subscription must be reused');
    },
  );
}

test('an account switch during subscribe cannot unsubscribe the subscription now adopted by B', async (t) => {
  const f = fixture(t, 390);
  await until(() => f.actions.$('[data-push-connect]')?.disabled === false);
  const slot = sharedPushSlot(f, 'new'),
    adopted = slot.get();
  slot.set(null);
  let release,
    subscribing = false,
    connected = 0;
  f.registration.pushManager.subscribe = () => {
    subscribing = true;
    return new Promise((resolve) => {
      release = () => {
        slot.set(adopted);
        resolve(adopted);
      };
    });
  };
  f.actions.request = async (route) => {
    if (route.endsWith('/status')) return { ...f.getStatus(), device: null };
    connected++;
    throw Error('Old actor must not connect');
  };
  f.actions.$('[data-push-connect]').click();
  await until(() => subscribing);
  f.state.account = { id: 'B', organizationId: 'org-B' };
  release();
  await flushPushMicrotasks();
  assert.equal(connected, 0);
  assert.deepEqual(
    slot.calls.unsubscribe,
    [],
    'A late cleanup cannot revoke shared B browser state',
  );
});

test('the browser permission prompt stays in the direct click stack before asynchronous scope reads', async (t) => {
  const f = fixture(t, 390);
  await until(() => f.actions.$('[data-push-connect]')?.disabled === false);
  let clickStack = true,
    asked = false;
  const order = [],
    original = f.actions.request;
  f.w.Notification.requestPermission = () => {
    assert.equal(
      clickStack,
      true,
      'A network await must not consume the gesture before the prompt',
    );
    asked = true;
    order.push('permission');
    f.w.Notification.permission = 'granted';
    return Promise.resolve('granted');
  };
  f.actions.request = async (route, options) => {
    order.push(route);
    return original(route, options);
  };
  f.actions.$('[data-push-connect]').click();
  clickStack = false;
  assert.equal(asked, true);
  await until(() => f.actions.$('[data-push-test]'));
  assert.equal(order[0], 'permission');
});

for (const reason of ['context428', 'network']) {
  test(
    'a rejected disconnect leaves the shared browser subscription unchanged: ' + reason,
    async (t) => {
      const f = await connectedPush(t),
        slot = sharedPushSlot(f, 'B');
      let attempts = 0;
      f.actions.request = async (route) => {
        assert.ok(route.endsWith('/disconnect'));
        attempts++;
        throw reason === 'context428' ? pushContextRefusal() : TypeError('Synthetic offline');
      };
      f.actions.$('[data-push-disconnect]').click();
      await until(() => attempts === 1);
      await flushPushMicrotasks();
      assert.deepEqual(slot.calls.unsubscribe, []);
    },
  );
}

test('disconnect only disables its owned server device and never removes a later shared B subscription', async (t) => {
  const f = await connectedPush(t),
    slot = sharedPushSlot(f, 'A');
  let release,
    disconnecting = false;
  f.actions.request = async (route, options) => {
    assert.ok(route.endsWith('/disconnect'));
    assert.equal(JSON.parse(options.body).deviceId, 'device');
    disconnecting = true;
    return new Promise((resolve) => {
      release = () => resolve({ ...f.getStatus(), device: null });
    });
  };
  f.actions.$('[data-push-disconnect]').click();
  await until(() => disconnecting);
  slot.set(slot.make('B'));
  release();
  await flushPushMicrotasks();
  assert.deepEqual(
    slot.calls.unsubscribe,
    [],
    'The post-response browser subscription may already belong to B',
  );
});

for (const accountId of ['A', undefined]) {
  test(
    'a Push target without the current exact account cannot open under B: ' + String(accountId),
    async (t) => {
      const f = fixture(t, 390);
      f.state.account = { id: 'B', organizationId: 'org' };
      let patients = 0,
        management = 0;
      f.actions.ensurePatient = async () => {
        patients++;
        return { id: 'patient', appointments: [{ id: 'appointment' }] };
      };
      f.actions.openManagement = async () => {
        management++;
      };
      for (const reference of [
        { patientId: 'patient', id: 'appointment' },
        { kind: 'request', id: 'request' },
      ]) {
        f.w.location.hash =
          'staff-push=' +
          encodeURIComponent(JSON.stringify({ accountId, organizationId: 'org', ...reference }));
        await f.ui.openStaffPushTarget();
      }
      assert.equal(patients, 0);
      assert.equal(management, 0);
      assert.ok(f.opened.length >= 1, 'A neutral explanation replaces the stale target');
      assert.ok(f.opened.every((value) => value !== 'appointment' && value !== 'requests'));
    },
  );
}

test('connect sends the fresh endpoint-specific binding expectation, never its mounted snapshot', async (t) => {
  const f = fixture(t, 390);
  await until(() => f.actions.$('[data-push-connect]')?.disabled === false);
  const slot = sharedPushSlot(f, 'shared'),
    calls = [],
    expectation = 'synthetic-current-endpoint-revision';
  f.actions.request = async (route, options) => {
    const body = JSON.parse(options.body);
    calls.push({ route, body });
    if (route.endsWith('/status')) {
      assert.equal(body.endpoint, slot.get().endpoint);
      return { ...f.getStatus(), bindingExpectation: expectation };
    }
    assert.ok(route.endsWith('/connect'));
    assert.equal(body.bindingExpectation, expectation);
    assert.deepEqual(body.subscription, slot.get().toJSON());
    return { ...f.getStatus(), device: { id: 'owned-device', enabled: true } };
  };
  f.actions.$('[data-push-connect]').click();
  await until(() => calls.some((call) => call.route.endsWith('/connect')));
  const binding = calls.find((call) => call.route.endsWith('/connect'));
  assert.equal(binding.body.bindingExpectation, expectation);
  assert.deepEqual(binding.body.subscription, slot.get().toJSON());
  assert.equal(calls.filter((call) => call.route.endsWith('/status')).length, 1);
  assert.equal(slot.calls.subscribe, 0);
  assert.deepEqual(slot.calls.unsubscribe, []);
});

test('a new browser subscription obtains its expectation for the actual endpoint after subscribe', async (t) => {
  const f = fixture(t, 390);
  await until(() => f.actions.$('[data-push-connect]')?.disabled === false);
  const slot = sharedPushSlot(f, 'shared'),
    calls = [];
  slot.set(null);
  f.actions.request = async (route, options) => {
    const body = JSON.parse(options.body);
    calls.push({ route, body });
    if (route.endsWith('/status'))
      return {
        ...f.getStatus(),
        bindingExpectation: body.endpoint ? 'synthetic-actual-absent-revision' : undefined,
      };
    assert.ok(route.endsWith('/connect'));
    assert.equal(body.bindingExpectation, 'synthetic-actual-absent-revision');
    assert.deepEqual(body.subscription, slot.get().toJSON());
    return { ...f.getStatus(), device: { id: 'owned-device', enabled: true } };
  };
  f.actions.$('[data-push-connect]').click();
  await until(() => calls.some((call) => call.route.endsWith('/connect')));
  assert.deepEqual(
    calls.filter((call) => call.route.endsWith('/status')).map((call) => call.body.endpoint),
    ['', slot.get().endpoint],
  );
  assert.equal(slot.calls.subscribe, 1);
  assert.deepEqual(slot.calls.unsubscribe, []);
});

for (const initial of ['bound-to-A', 'absent-before-B']) {
  test(
    'a delayed A connect cannot retry after a binding revision conflict: ' + initial,
    async (t) => {
      const f = fixture(t, 390);
      await until(() => f.actions.$('[data-push-connect]')?.disabled === false);
      const slot = sharedPushSlot(f, 'shared');
      let serverRevision = 'synthetic-' + initial,
        serverOwner = initial === 'bound-to-A' ? 'A' : null,
        attempts = 0,
        apply = 0,
        release;
      f.actions.request = async (route, options) => {
        const body = JSON.parse(options.body);
        if (route.endsWith('/status'))
          return { ...f.getStatus(), bindingExpectation: serverRevision };
        assert.ok(route.endsWith('/connect'));
        attempts++;
        assert.equal(body.bindingExpectation, 'synthetic-' + initial);
        return new Promise((resolve, reject) => {
          release = () => {
            if (body.bindingExpectation !== serverRevision)
              return reject(
                Object.assign(Error('Synthetic binding changed; refresh manually'), {
                  status: 409,
                }),
              );
            apply++;
            serverOwner = 'A';
            resolve({ ...f.getStatus(), device: { id: 'A-device', enabled: true } });
          };
        });
      };
      f.actions.$('[data-push-connect]').click();
      await until(() => release);
      // Models B's independent valid connect committing before old A's HTTP body is applied.
      serverRevision = 'synthetic-B-connect';
      serverOwner = 'B';
      if (initial === 'absent-before-B') {
        // A null-only comparison would miss this ABA: B connects, then disconnects.
        serverRevision = 'synthetic-absent-after-B-disconnect';
        serverOwner = null;
      }
      release();
      await until(() => f.w.document.body.textContent.includes('Synthetic binding changed'));
      await flushPushMicrotasks();
      assert.equal(attempts, 1, 'No automatic status/rebind retry may replace explicit B intent');
      assert.equal(apply, 0);
      assert.equal(serverOwner, initial === 'bound-to-A' ? 'B' : null);
      assert.deepEqual(slot.calls.unsubscribe, []);
    },
  );
}
