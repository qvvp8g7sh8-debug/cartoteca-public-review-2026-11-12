const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  vm = require('node:vm'),
  path = require('node:path');
const source = fs.readFileSync(
  path.join(__dirname, '../src/client/core/background-refresh.js'),
  'utf8',
);
function fixture() {
  const events = {},
    timers = new Map(),
    calls = [];
  let time = 100000,
    id = 0,
    open = false,
    inboxAt = -Infinity;
  const state = {
    account: { id: 'a', organizationId: 'o' },
    currentView: 'calendar',
    busy: false,
    workspace: { enabled: true },
  };
  const document = {
      hidden: false,
      addEventListener(n, fn) {
        events[n] = fn;
      },
    },
    window = {
      addEventListener(n, fn) {
        events[n] = fn;
      },
    };
  const actions = {
    $: () => ({ open }),
    bookingInboxInterval: () => 15000,
    bookingInboxDeadline: () => inboxAt + actions.bookingInboxInterval(),
    refreshBookingInbox: () => {
      inboxAt = time;
      calls.push('inbox');
    },
    updateCurrentTime: () => calls.push('clock'),
    refreshCabinetTimeZone: () => calls.push('zone'),
    loadCalendarRecords: () => calls.push('calendar'),
    loadRoomAvailability: () => calls.push('rooms'),
    syncVisibleTelegram: () => calls.push('telegram'),
    request: async (url) => {
      calls.push(url);
      return { user: state.account };
    },
  };
  const factory = vm.runInNewContext(source + '\ncreateBackgroundRefresh', {
    Date: { now: () => time },
    JSON,
    Promise,
    Map,
    document,
    window,
    location: { replace: () => calls.push('logout') },
    setTimeout(fn, delay) {
      timers.set(++id, { fn, delay });
      return id;
    },
    clearTimeout(i) {
      timers.delete(i);
    },
  });
  actions.canManageTeam = () => false;
  actions.bookingHealthInterval = () => 30000;
  actions.bookingHealthDeadline = () => -Infinity;
  actions.refreshBookingHealth = () => calls.push('health');
  actions.improvementsVisible = () => false;
  actions.loadImprovements = () => calls.push('improvements');
  actions.earlyAccessVisible = () => false;
  actions.loadEarlyAccess = () => calls.push('early-access');
  Object.assign(actions, factory(state, actions));
  return {
    state,
    document,
    events,
    timers,
    calls,
    actions,
    advance(ms) {
      time += ms;
    },
    editor(value) {
      open = value;
    },
  };
}
test('one scheduler joins duplicate reads, scopes them and allows retry after rejection', async () => {
  const f = fixture();
  let resolve,
    sends = 0;
  f.actions.request = () => {
    sends++;
    return new Promise((r) => (resolve = r));
  };
  const a = f.actions.readBackground('/calendar'),
    b = f.actions.readBackground('/calendar');
  assert.equal(a, b);
  await Promise.resolve();
  assert.equal(sends, 1);
  resolve({ ok: true });
  await a;
  await Promise.resolve();
  f.actions.request = async () => {
    sends++;
    throw Error('offline');
  };
  await assert.rejects(f.actions.readBackground('/calendar'));
  await Promise.resolve();
  f.actions.request = async () => {
    sends++;
    return {};
  };
  await f.actions.readBackground('/calendar');
  assert.equal(sends, 3);
  f.actions.readBackground('/calendar');
  f.state.account = { id: 'b', organizationId: 'other' };
  await f.actions.readBackground('/calendar');
  assert.equal(sends, 5);
});
test('focus and visibility coalesce; hidden pages stop the sole timer and busy editors pause calendar', async () => {
  const f = fixture();
  f.actions.bindBackgroundEvents();
  f.actions.bindBackgroundEvents();
  assert.equal(f.timers.size, 1);
  await f.actions.refreshBackground({ reason: 'resume' });
  await f.actions.refreshBackground({ reason: 'resume' });
  assert.equal(f.calls.filter((v) => v === 'calendar').length, 1);
  assert.equal(f.calls.filter((v) => v === '/api/auth/session').length, 1);
  f.advance(16000);
  f.editor(true);
  await f.actions.refreshBackground();
  assert.equal(f.calls.filter((v) => v === 'calendar').length, 1);
  assert.equal(f.calls.filter((v) => v === 'rooms').length, 1);
  f.document.hidden = true;
  f.events.visibilitychange();
  assert.equal(f.timers.size, 0);
  f.advance(16000);
  await f.actions.refreshBackground();
  assert.equal(f.timers.size, 0);
  f.document.hidden = false;
  f.editor(false);
  await f.actions.refreshBackground({ reason: 'resume' });
  assert.equal(f.calls.filter((v) => v === 'calendar').length, 2);
  assert.equal(f.timers.size, 1);
  f.events.pagehide();
  assert.equal(f.timers.size, 0);
  await f.actions.refreshBackground();
  assert.equal(f.timers.size, 0);
});
test('slow refresh cannot issue a concurrent copy or block unrelated Telegram updates', async () => {
  const f = fixture();
  let resolve;
  f.actions.loadCalendarRecords = () => {
    f.calls.push('calendar');
    return new Promise((r) => (resolve = r));
  };
  const first = f.actions.refreshBackground();
  await new Promise(setImmediate);
  f.advance(5000);
  const next = f.actions.refreshBackground();
  await new Promise(setImmediate);
  assert.equal(f.calls.filter((v) => v === 'calendar').length, 1);
  assert.equal(f.calls.filter((v) => v === 'telegram').length, 2);
  resolve();
  await Promise.all([first, next]);
});

test('inbox shares the single scheduler, adjusts its interval and stops in a hidden page', async () => {
  const f = fixture();
  f.state.multiUser = true;
  f.state.currentView = 'card';
  f.state.busy = true;
  f.actions.bindBackgroundEvents();
  await f.actions.refreshBackground();
  assert.equal(f.calls.filter((v) => v === 'inbox').length, 1);
  assert.equal(f.timers.size, 1);
  f.advance(14000);
  await f.actions.refreshBackground();
  assert.equal(f.calls.filter((v) => v === 'inbox').length, 1);
  f.advance(1000);
  await f.actions.refreshBackground();
  assert.equal(f.calls.filter((v) => v === 'inbox').length, 2);
  f.actions.bookingInboxInterval = () => 30000;
  f.advance(16000);
  await f.actions.refreshBackground();
  assert.equal(f.calls.filter((v) => v === 'inbox').length, 2);
  f.advance(14000);
  await f.actions.refreshBackground();
  assert.equal(f.calls.filter((v) => v === 'inbox').length, 3);
  f.document.hidden = true;
  f.events.visibilitychange();
  f.advance(30000);
  await f.actions.refreshBackground();
  assert.equal(f.calls.filter((v) => v === 'inbox').length, 3);
  assert.equal(f.timers.size, 0);
  f.document.hidden = false;
  await f.actions.refreshBackground({ reason: 'resume' });
  assert.equal(f.calls.filter((v) => v === 'inbox').length, 4);
  assert.equal(f.timers.size, 1);
});

test('booking health is another job in the same timer, not an independent poller', async () => {
  const f = fixture();
  f.state.multiUser = true;
  f.actions.canManageTeam = () => true;
  let healthAt = -Infinity;
  f.actions.bookingHealthDeadline = () => healthAt + 30000;
  f.actions.refreshBookingHealth = () => {
    healthAt = 100000;
    f.calls.push('health');
  };
  f.actions.bindBackgroundEvents();
  await f.actions.refreshBackground();
  assert.equal(f.calls.filter((v) => v === 'health').length, 1);
  assert.equal(f.timers.size, 1);
  f.advance(15000);
  await f.actions.refreshBackground();
  assert.equal(f.calls.filter((v) => v === 'health').length, 1);
  f.document.hidden = true;
  f.events.visibilitychange();
  assert.equal(f.timers.size, 0);
  f.document.hidden = false;
  await f.actions.refreshBackground({ reason: 'resume' });
  assert.equal(f.calls.filter((v) => v === 'health').length, 1);
  assert.equal(f.timers.size, 1);
  f.advance(15000);
  await f.actions.refreshBackground();
  assert.equal(f.calls.filter((v) => v === 'health').length, 2);
});

// Exercise real visibility, messenger and scheduler modules with one synthetic
// clock. These regressions never wait for a wall-clock polling interval.
async function messengerFixture(t) {
  const { JSDOM } = require('jsdom');
  const w = new JSDOM(
    '<main id="global-view"><section class="settings-panel"><div class="settings-tiles"><details class="settings-tile" id="personal-page"><summary>Personal</summary><section id="staff-notifications"></section></details><details class="settings-tile" id="reminder-page"><summary>Reminders</summary><section id="telegram-settings"><div id="telegram-client-settings"></div></section></details></div></section></main>',
    { runScripts: 'outside-only', url: 'https://synthetic.test/', pretendToBeVisual: true },
  ).window;
  // JSDOM queues native details toggles through Node timers. Explicitly drive
  // toggles below and remove their listener before disposal, without sleeping.
  const host = w.document.querySelector('#global-view'),
    toggleListeners = [],
    listen = host.addEventListener.bind(host);
  host.addEventListener = (name, callback, options) => {
    if (name === 'toggle') toggleListeners.push({ callback, options });
    listen(name, callback, options);
  };
  t.after(() => {
    for (const { callback, options } of toggleListeners)
      host.removeEventListener('toggle', callback, options);
    w.close();
  });
  let now = 100000,
    timerId = 0;
  const timers = new Map(),
    calls = [],
    handlers = new Map(),
    push = { mount: 0, sync: 0 };
  w.Date.now = () => now;
  w.setTimeout = (fn, delay) => {
    timers.set(++timerId, { fn, delay });
    return timerId;
  };
  w.clearTimeout = (id) => timers.delete(id);
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new w.Event('close'));
  };
  const state = {
    multiUser: true,
    currentView: 'settings',
    busy: false,
    account: { id: 'a', organizationId: 'o', role: 'owner' },
    roleNames: {},
    workspace: { enabled: false },
  };
  const status = {
    telegram: {
      linked: false,
      enabled: false,
      bindingId: '',
      available: true,
      compatible: true,
      bot: { connected: true },
    },
    max: {
      linked: false,
      enabled: false,
      bindingId: '',
      prepared: true,
      available: true,
      compatible: true,
      bot: { connected: true },
    },
  };
  let leadMinutes = 60;
  const actions = {
    $: (selector) => w.document.querySelector(selector),
    canManageTeam: () => true,
    esc: (value) =>
      String(value).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
      ),
    confirmAction: async () => true,
    mountClientNotificationSettings() {},
    markSettingsSaved() {},
    toast() {},
    mountStaffPush() {
      push.mount++;
    },
    async syncStaffPush() {
      push.sync++;
    },
    bookingInboxInterval: () => 30000,
    bookingInboxDeadline: () => Infinity,
    refreshBookingInbox() {},
    bookingHealthInterval: () => 30000,
    bookingHealthDeadline: () => Infinity,
    refreshBookingHealth() {},
    improvementsVisible: () => false,
    earlyAccessVisible: () => false,
    updateCurrentTime() {},
    refreshCabinetTimeZone() {},
    loadCalendarSchedule() {},
    loadCalendarRecords() {},
    loadRoomAvailability() {},
    async request(route, options) {
      const method = options?.method || 'GET';
      calls.push({
        route,
        method,
        at: now,
        scope: state.account.id + ':' + state.account.organizationId,
      });
      if (handlers.has(route)) return handlers.get(route)(options);
      if (route === '/api/auth/session') return { user: state.account };
      if (route === '/api/telegram/patient?patientId=p') return {};
      if (route === '/api/notifications/reminders') {
        if (method === 'POST') leadMinutes = JSON.parse(options.body).leadMinutes;
        return {
          settings: { leadMinutes },
          bot: { configured: true, connected: true, username: 'Synthetic_bot' },
          max: { configured: true, running: true },
          preview: 'Synthetic Telegram',
          maxPreview: 'Synthetic MAX',
        };
      }
      const match = /^\/api\/(telegram|max)\/staff(?:\/(link|settings|unlink))?$/.exec(route);
      assert.ok(match, 'Unexpected messenger fixture route: ' + route);
      const channel = match[1],
        action = match[2];
      if (action === 'link')
        return {
          url:
            (channel === 'telegram'
              ? 'https://t.me/Synthetic_bot'
              : 'https://max.ru/id000000000000_1_bot') +
            '?start=staff_' +
            's'.repeat(43),
          expiresAt: now + 900000,
        };
      if (action === 'settings')
        status[channel] = { ...status[channel], enabled: JSON.parse(options.body).enabled };
      if (action === 'unlink')
        status[channel] = { ...status[channel], linked: false, enabled: false, bindingId: '' };
      return structuredClone(status[channel]);
    },
  };
  for (const file of [
    'settings-help',
    'settings-pages',
    'telegram-settings',
    'staff-notifications',
    'telegram',
  ])
    w.eval(fs.readFileSync(path.join(__dirname, '../src/client/modules', file + '.js'), 'utf8'));
  w.eval(source);
  Object.assign(actions, w.eval('createSettingsHelp')(state, actions));
  require('./helpers/staff-channel-ui.cjs').installStaffChannelUI(w, state, actions);
  Object.assign(actions, w.eval('createSettingsPages')(state, actions));
  Object.assign(actions, w.eval('createStaffNotifications')(state, actions));
  Object.assign(actions, w.eval('createTelegramSettings')(state, actions));
  Object.assign(actions, w.eval('createTelegram')(state, actions));
  Object.assign(actions, w.eval('createBackgroundRefresh')(state, actions));
  actions.loadPatientTelegram = async () => actions.request('/api/telegram/patient?patientId=p');
  actions.bindSettingsPageEvents();
  actions.bindTelegramSettingsEvents();
  actions.bindBackgroundEvents();
  const settle = async () => {
    for (let n = 0; n < 30; n++) await Promise.resolve();
  };
  actions.mountStaffNotifications();
  await actions.loadTelegramSettings();
  await settle();
  return {
    w,
    state,
    actions,
    calls,
    push,
    timers,
    status,
    settle,
    count: (route) => calls.filter((call) => call.route === route && call.method === 'GET').length,
    handle: (route, handler) => (handler ? handlers.set(route, handler) : handlers.delete(route)),
    advance(ms) {
      now += ms;
    },
    async sync(ms = 0, { force = false } = {}) {
      now += ms;
      await actions.syncVisibleTelegram({ force });
      await settle();
    },
    async tick(ms = 0) {
      now += ms;
      await actions.refreshBackground();
      await settle();
    },
    async open(id) {
      const block = actions.$('#' + id);
      block.open = true;
      block.dispatchEvent(new w.Event('toggle'));
      await settle();
    },
    hidden(value) {
      Object.defineProperty(w.document, 'hidden', { configurable: true, value });
      Object.defineProperty(w.document, 'visibilityState', {
        configurable: true,
        value: value ? 'hidden' : 'visible',
      });
      w.document.dispatchEvent(new w.Event('visibilitychange'));
    },
  };
}
function deferredRead() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const staffTelegram = '/api/telegram/staff',
  staffMax = '/api/max/staff',
  reminders = '/api/notifications/reminders';
const messengerReads = (f) =>
  f.calls.filter(
    (call) => call.method === 'GET' && [staffTelegram, staffMax, reminders].includes(call.route),
  );

test('closed settings mount performs no messenger or push reads; opening reminders reads only that visible section', async (t) => {
  const f = await messengerFixture(t);
  await f.sync(60000);
  await f.sync(0, { force: true });
  assert.deepEqual(messengerReads(f), []);
  assert.deepEqual(f.push, { mount: 0, sync: 0 });
  await f.open('reminder-page');
  assert.equal(f.count(reminders), 1);
  assert.equal(f.count(staffTelegram), 0);
  assert.equal(f.count(staffMax), 0);
  assert.deepEqual(f.push, { mount: 0, sync: 0 });
  const form = f.actions.$('#telegram-settings-form');
  form.elements.leadMinutes.value = '120';
  await f.sync(29999);
  assert.equal(f.count(reminders), 1);
  await f.sync(1);
  assert.equal(f.count(reminders), 2);
  assert.equal(f.actions.$('#telegram-settings-form'), form);
  assert.equal(form.elements.leadMinutes.value, '120');
  f.actions.$('#reminder-page').open = false;
  await f.sync(60000, { force: true });
  assert.equal(f.count(reminders), 2);
  await f.open('reminder-page');
  assert.equal(f.count(reminders), 3);
  assert.equal(f.actions.$('#telegram-settings-form'), form);
  assert.equal(form.elements.leadMinutes.value, '120');
});

test('session initialization and hidden ancestors suppress direct mounts, forced opens and reads', async (t) => {
  const f = await messengerFixture(t);
  f.state.sessionReady = false;
  await f.open('personal-page');
  await f.open('reminder-page');
  await f.sync(60000, { force: true });
  assert.deepEqual(messengerReads(f), []);
  assert.deepEqual(f.push, { mount: 0, sync: 0 });
  f.state.sessionReady = true;
  await f.open('personal-page');
  const root = f.actions.$('#staff-notifications');
  assert.equal(f.actions.settingsSectionVisible(root), true);
  root.hidden = true;
  assert.equal(f.actions.settingsSectionVisible(root), false);
  root.hidden = false;
  f.actions.$('#personal-page').open = false;
  assert.equal(f.actions.settingsSectionVisible(root), false);
  assert.equal(f.actions.settingsSectionVisible(f.w.document.createElement('div')), false);
});

test('visible personal status is steady at thirty seconds and only a channel with a live invitation uses four seconds', async (t) => {
  const f = await messengerFixture(t);
  await f.open('personal-page');
  assert.equal(f.count(staffTelegram), 1);
  assert.equal(f.count(staffMax), 1);
  assert.equal(f.count(reminders), 0);
  assert.ok(f.push.mount > 0);
  assert.ok(f.push.sync > 0);
  await f.sync(29999);
  assert.equal(f.count(staffTelegram), 1);
  assert.equal(f.count(staffMax), 1);
  await f.sync(1);
  assert.equal(f.count(staffTelegram), 2);
  assert.equal(f.count(staffMax), 2);
  f.actions.$('[data-staff-channel-open="telegram"]').click();
  await f.settle();
  assert.equal(f.count(staffTelegram), 3);
  assert.equal(f.count(staffMax), 2);
  f.actions.$('[data-staff-notify-connect]').click();
  await f.settle();
  assert.equal(f.calls.filter((call) => call.route === staffTelegram + '/link').length, 1);
  const telegramAt = f.count(staffTelegram),
    maxAt = f.count(staffMax);
  await f.sync(3999);
  assert.equal(f.count(staffTelegram), telegramAt);
  await f.sync(1);
  assert.equal(f.count(staffTelegram), telegramAt + 1);
  assert.equal(f.count(staffMax), maxAt);
  f.status.telegram = {
    ...f.status.telegram,
    linked: true,
    enabled: true,
    bindingId: 'synthetic-binding',
  };
  await f.sync(4000);
  assert.equal(f.count(staffTelegram), telegramAt + 2);
  const linkedAt = f.count(staffTelegram);
  await f.sync(29999);
  assert.equal(f.count(staffTelegram), linkedAt);
  await f.sync(1);
  assert.equal(f.count(staffTelegram), linkedAt + 1);
});

test('expired invitations stop fast polling and a failed pending status backs off until thirty seconds or explicit refresh', async (t) => {
  const f = await messengerFixture(t);
  await f.open('personal-page');
  f.actions.$('[data-staff-channel-open="telegram"]').click();
  await f.settle();
  f.actions.$('[data-staff-notify-connect]').click();
  await f.settle();
  f.handle(staffTelegram, async () => {
    throw Error('Synthetic status outage');
  });
  const before = f.count(staffTelegram);
  await f.sync(4000);
  assert.equal(f.count(staffTelegram), before + 1);
  await f.sync(4000);
  assert.equal(f.count(staffTelegram), before + 1);
  await f.sync(25999);
  assert.equal(f.count(staffTelegram), before + 1);
  await f.sync(1);
  assert.equal(f.count(staffTelegram), before + 2);
  f.handle(staffTelegram, null);
  f.actions.$('[data-staff-notify-refresh]').click();
  await f.settle();
  assert.equal(f.count(staffTelegram), before + 3);
  f.advance(900001);
  await f.sync();
  const expiredAt = f.count(staffTelegram);
  await f.sync(4000);
  assert.equal(f.count(staffTelegram), expiredAt);
});

test('manual status and settings changes stay immediate inside the thirty-second steady interval', async (t) => {
  const f = await messengerFixture(t);
  await f.open('personal-page');
  f.actions.$('[data-staff-channel-open="telegram"]').click();
  await f.settle();
  const before = f.count(staffTelegram),
    maxBefore = f.count(staffMax);
  await f.sync(1000);
  assert.equal(f.count(staffTelegram), before);
  f.actions.$('[data-staff-notify-refresh]').click();
  await f.settle();
  assert.equal(f.count(staffTelegram), before + 1);
  assert.equal(f.count(staffMax), maxBefore);
  f.status.telegram = {
    ...f.status.telegram,
    linked: true,
    enabled: true,
    bindingId: 'synthetic-binding',
  };
  await f.actions.syncStaffNotifications();
  await f.settle();
  const toggle = f.actions.$('[data-staff-notify-toggle]'),
    checkedAt = f.count(staffTelegram);
  toggle.checked = false;
  toggle.dispatchEvent(new f.w.Event('change', { bubbles: true }));
  await f.settle();
  assert.equal(
    f.calls.filter((call) => call.route === staffTelegram + '/settings' && call.method === 'POST')
      .length,
    1,
  );
  assert.equal(f.count(staffTelegram), checkedAt + 1);
  assert.equal(f.actions.$('[data-staff-notify-toggle]').checked, false);
});

test('hidden documents pause messenger and push work; visible resume refreshes due status without focus burst', async (t) => {
  const f = await messengerFixture(t);
  await f.open('personal-page');
  const before = messengerReads(f).length,
    pushBefore = { ...f.push };
  f.hidden(true);
  assert.equal(f.timers.size, 0);
  await f.sync(60000, { force: true });
  await f.tick();
  assert.equal(messengerReads(f).length, before);
  assert.deepEqual(f.push, pushBefore);
  f.hidden(false);
  await f.settle();
  assert.equal(messengerReads(f).length, before + 2);
  assert.equal(f.timers.size, 1);
  const resumed = messengerReads(f).length;
  f.advance(600);
  f.w.dispatchEvent(new f.w.Event('focus'));
  await f.settle();
  assert.equal(messengerReads(f).length, resumed);
});

test('concurrent forced refreshes join in-flight reads and a changed account scope receives fresh status instead of an old result', async (t) => {
  const f = await messengerFixture(t);
  await f.open('personal-page');
  const pending = deferredRead(),
    before = f.count(staffTelegram);
  f.handle(staffTelegram, () => pending.promise);
  const first = f.actions.syncStaffNotifications(),
    second = f.actions.syncStaffNotifications(),
    third = f.actions.syncVisibleTelegram({ force: true });
  await f.settle();
  assert.equal(f.count(staffTelegram), before + 1);
  f.state.account = { ...f.state.account, organizationId: 'other' };
  f.actions.mountStaffNotifications();
  f.handle(staffTelegram, null);
  pending.resolve({
    ...f.status.telegram,
    linked: true,
    enabled: true,
    bindingId: 'old-scope-binding',
  });
  await Promise.all([first, second, third]);
  await f.settle();
  assert.equal(f.count(staffTelegram), before + 2);
  assert.deepEqual(
    f.calls
      .filter((call) => call.route === staffTelegram)
      .slice(-2)
      .map((call) => call.scope),
    ['a:o', 'a:other'],
  );
  assert.equal(
    f.actions.$('[data-staff-channel-open="telegram"]').classList.contains('is-linked'),
    false,
  );
  assert.ok(f.actions.$('[data-staff-notify-connect]'));
});

test('opening a recently checked section during an unrelated pending read coalesces forced requests into one current refresh', async (t) => {
  const f = await messengerFixture(t);
  await f.open('personal-page');
  const telegramAt = f.count(staffTelegram),
    maxAt = f.count(staffMax),
    pending = deferredRead();
  f.handle(reminders, () => pending.promise);
  await f.open('reminder-page');
  assert.equal(f.count(reminders), 1);
  await f.open('personal-page');
  void f.actions.syncVisibleTelegram({ force: true });
  pending.resolve({
    settings: { leadMinutes: 60 },
    bot: { connected: true, configured: true, username: 'Synthetic_bot' },
    max: { configured: true, running: true },
  });
  await f.settle();
  assert.equal(f.count(staffTelegram), telegramAt + 1);
  assert.equal(f.count(staffMax), maxAt + 1);
  assert.equal(f.count(reminders), 1);
  assert.equal(f.actions.$('#telegram-settings-form'), null);
  assert.equal(f.actions.$('#personal-page').open, true);
});

test('focus bursts during an ordinary in-flight status tick join its fresh result without a second round of reads', async (t) => {
  const f = await messengerFixture(t);
  await f.open('personal-page');
  f.advance(30000);
  const pending = deferredRead(),
    telegramAt = f.count(staffTelegram),
    maxAt = f.count(staffMax);
  f.handle(staffTelegram, () => pending.promise);
  const tick = f.actions.syncVisibleTelegram();
  await f.settle();
  const firstForce = f.actions.syncVisibleTelegram({ force: true }),
    secondForce = f.actions.syncVisibleTelegram({ force: true });
  pending.resolve(structuredClone(f.status.telegram));
  await Promise.all([tick, firstForce, secondForce]);
  await f.settle();
  assert.equal(f.count(staffTelegram), telegramAt + 1);
  assert.equal(f.count(staffMax), maxAt + 1);
});

test('patient-card Telegram polling remains at four seconds independently of the settings status interval', async (t) => {
  const f = await messengerFixture(t);
  f.state.currentView = 'card';
  f.w.document.body.insertAdjacentHTML(
    'beforeend',
    '<section class="telegram-patient-panel"></section>',
  );
  const patient = '/api/telegram/patient?patientId=p';
  await f.tick();
  assert.equal(f.count(patient), 1);
  await f.tick(3999);
  assert.equal(f.count(patient), 1);
  await f.tick(1);
  assert.equal(f.count(patient), 2);
  f.hidden(true);
  await f.tick(4000);
  assert.equal(f.count(patient), 2);
  assert.deepEqual(messengerReads(f), []);
  assert.deepEqual(f.push, { mount: 0, sync: 0 });
});

test('bootstrap blocks polling and resume session duplicate until the initial calendar is ready', async () => {
  const f = fixture();
  f.state.sessionReady = false;
  await f.actions.refreshBackground({ reason: 'resume' });
  assert.deepEqual(f.calls, []);
  f.state.sessionReady = true;
  await f.actions.refreshBackground({ reason: 'resume' });
  assert.equal(f.calls.filter((v) => v === 'calendar').length, 1);
  assert.equal(f.calls.filter((v) => v === '/api/auth/session').length, 1);
});
