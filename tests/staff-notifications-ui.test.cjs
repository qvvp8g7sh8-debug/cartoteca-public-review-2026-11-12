const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  { JSDOM } = require('jsdom');
const { setTimeout: delay } = require('node:timers/promises');
const source = fs.readFileSync(
  path.join(__dirname, '../src/client/modules/staff-notifications.js'),
  'utf8',
);
const until = async (fn) => {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await delay(5);
  }
  throw Error('UI timeout');
};
function fixture(t) {
  const w = new JSDOM('<div id="staff-notifications"></div>', {
    runScripts: 'outside-only',
    url: 'https://synthetic.test/',
  }).window;
  t.after(() => w.close());
  w.eval(source);
  w.confirm = () => true;
  w.eval(fs.readFileSync(path.join(__dirname, '../src/client/modules/settings-help.js'), 'utf8'));
  const state = {
    account: { id: 'a', organizationId: 'o' },
    roleNames: {},
    currentView: 'settings',
    busy: false,
  };
  let status = {
      linked: false,
      enabled: false,
      bindingId: '',
      available: true,
      bot: { connected: true },
    },
    maxStatus = {
      linked: false,
      enabled: false,
      bindingId: '',
      prepared: false,
      available: false,
      bot: { connected: false },
    },
    posts = [];
  const actions = {
    settingsSectionVisible: () => true,
    canManageTeam: () => false,
    $: (s) => w.document.querySelector(s),
    esc: (v) =>
      String(v).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
      ),
    confirmAction: async () => w.confirm(),
    readBackground: async (url) => structuredClone(url.includes('/max/') ? maxStatus : status),
    request: async (url, options) => {
      posts.push({ url, body: JSON.parse(options.body) });
      if (url.endsWith('/link'))
        return {
          url: `${url.includes('/max/') ? 'https://max.ru/id000000000000_1_bot' : 'https://t.me/Synthetic_bot'}?start=staff_${'s'.repeat(43)}`,
          expiresAt: Date.now() + 900000,
        };
      const prior = url.includes('/max/') ? maxStatus : status;
      if (url.endsWith('/test')) return { queued: true };
      const body = posts.at(-1).body;
      const next = url.endsWith('/unlink')
        ? { ...prior, linked: false, enabled: false, bindingId: '' }
        : {
            ...prior,
            ...(Object.hasOwn(body, 'enabled') ? { enabled: body.enabled } : {}),
            ...(Object.hasOwn(body, 'events') ? { events: [...body.events] } : {}),
          };
      if (url.includes('/max/')) maxStatus = next;
      else status = next;
      return structuredClone(next);
    },
  };
  Object.assign(actions, w.eval('createSettingsHelp')(state, actions));
  require('./helpers/staff-channel-ui.cjs').installStaffChannelUI(w, state, actions);
  const module = w.eval('createStaffNotifications')(state, actions);
  module.mountStaffNotifications();
  void module.syncStaffNotifications();
  return {
    w,
    state,
    actions,
    module,
    posts,
    setStatus: (value) => (status = { ...status, ...value }),
    setMaxStatus: (value) => (maxStatus = { ...maxStatus, ...value }),
  };
}
for (const width of [390, 1440])
  test(
    'personal connection waits for bot start then updates automatically at ' + width,
    async (t) => {
      const f = fixture(t);
      Object.defineProperty(f.w, 'innerWidth', { value: width });
      await until(() => f.actions.$('[data-staff-notify-connect]')?.disabled === false);
      assert.ok(f.actions.$('[data-staff-notify-connect]').classList.contains('primary'));
      f.actions.$('[data-staff-notify-connect]').click();
      await until(() => f.actions.$('a'));
      assert.ok(f.actions.$('a').classList.contains('primary'));
      assert.equal(f.actions.$('a').textContent, 'Открыть Telegram');
      assert.ok(f.actions.$('[data-staff-notify-copy]').classList.contains('secondary'));
      assert.equal(f.actions.$('.connection-telegram').classList.contains('is-linked'), false);
      assert.match(f.actions.$('a').href, /t.me\/Synthetic_bot/);
      assert.equal(f.actions.$('#telegram-staff-heading').textContent, 'Мои уведомления');
      assert.equal(f.w.localStorage.length, 0);
      const invitation = f.actions.$('a');
      f.module.mountStaffNotifications();
      assert.equal(f.actions.$('a'), invitation);
      f.setStatus({ linked: true, enabled: true, bindingId: 'binding' });
      await f.module.syncStaffNotifications();
      assert.equal(f.actions.$('.connection-telegram').classList.contains('is-linked'), true);
      assert.match(
        f.actions.$('[data-staff-channel="telegram"] .staff-channel-status').textContent,
        /Включены/,
      );
      assert.equal(f.actions.$('[data-staff-channel="telegram"]').dataset.staffState, 'ready');
      assert.equal(f.actions.$('a'), null);
      assert.equal(f.actions.$('[data-staff-notify-unlink]').closest('dialog').open, false);
      const toggle = f.actions.$('[data-staff-notify-toggle]');
      toggle.checked = false;
      toggle.dispatchEvent(new f.w.Event('change', { bubbles: true }));
      await until(
        () => f.posts.length === 2 && !f.actions.$('[data-staff-notify-toggle]').disabled,
      );
      assert.deepEqual(f.posts[1].body, { bindingId: 'binding', enabled: false });
      assert.equal(f.actions.$('[data-staff-notify-toggle]').checked, false);
      assert.equal(f.actions.$('[data-staff-channel="telegram"]').dataset.staffState, 'unlinked');
      f.w.confirm = () => false;
      f.actions.$('[data-staff-notify-unlink]').click();
      await delay(10);
      assert.equal(f.posts.length, 2);
      f.w.confirm = () => true;
      f.actions.$('[data-staff-notify-unlink]').click();
      await until(() => f.actions.$('[data-staff-notify-connect]'));
      assert.equal(f.posts[2].body.bindingId, 'binding');
    },
  );
test('stale organization responses and unavailable bot never claim success or enable connection', async (t) => {
  const f = fixture(t);
  await until(() => f.actions.$('[data-staff-notify-connect]')?.disabled === false);
  let resolve;
  f.actions.readBackground = (url) =>
    url.includes('/max/')
      ? Promise.resolve({ prepared: false, available: false, bot: { connected: false } })
      : new Promise((r) => (resolve = r));
  const request = f.module.syncStaffNotifications();
  f.state.account.organizationId = 'other';
  resolve({ linked: true, enabled: true });
  await request;
  assert.ok(!f.w.document.body.textContent.includes('✓ Подключено'));
  f.actions.readBackground = async () => ({
    linked: false,
    enabled: false,
    available: true,
    bot: { connected: false },
  });
  f.module.mountStaffNotifications();
  await f.module.syncStaffNotifications();
  await until(() => f.w.document.body.textContent.includes('Сервис недоступен'));
  assert.equal(f.actions.$('[data-staff-notify-connect]'), null);
});

test('MAX is an independent personal connection; caption clicks and rejected confirmations do not mutate it', async (t) => {
  const f = fixture(t);
  await until(() => f.actions.$('[data-staff-notify-connect]')?.disabled === false);
  assert.equal(f.actions.$('[data-staff-max-connect]'), null);
  f.setStatus({ linked: true, enabled: true, bindingId: 'telegram-binding' });
  f.setMaxStatus({ prepared: true, available: true, bot: { connected: true } });
  await f.module.syncStaffNotifications();
  f.actions.$('[data-staff-max-connect]').click();
  await until(() => f.actions.$('[data-staff-channel="max"] a'));
  assert.match(
    f.actions.$('[data-staff-channel="max"] a').href,
    /^https:\/\/max\.ru\/id000000000000_1_bot\?start=staff_/,
  );
  assert.equal(f.actions.$('[data-staff-max-toggle]'), null);
  f.setMaxStatus({ linked: true, compatible: true, enabled: true, bindingId: 'max-binding' });
  await f.module.syncStaffNotifications();
  f.actions.$('[data-staff-channel="max"] .telegram-switch span').click();
  assert.equal(f.posts.length, 1);
  assert.equal(f.actions.$('[data-staff-max-toggle]').checked, true);
  f.w.confirm = () => false;
  const denied = f.actions.$('[data-staff-max-toggle]');
  denied.checked = false;
  denied.dispatchEvent(new f.w.Event('change', { bubbles: true }));
  await until(() => f.actions.$('[data-staff-max-toggle]').checked);
  await delay(0);
  assert.equal(f.posts.length, 1);
  f.w.confirm = () => true;
  const allowed = f.actions.$('[data-staff-max-toggle]');
  allowed.checked = false;
  allowed.dispatchEvent(new f.w.Event('change', { bubbles: true }));
  await until(() => f.posts.length === 2 && !f.actions.$('[data-staff-max-toggle]').disabled);
  assert.equal(f.posts[1].url, '/api/max/staff/settings');
  assert.deepEqual(f.posts[1].body, { bindingId: 'max-binding', enabled: false });
  assert.equal(f.actions.$('[data-staff-notify-toggle]').checked, true);
});

test('confirmation error frees the action and invitation survives same-account remount', async (t) => {
  const f = fixture(t);
  f.setMaxStatus({ prepared: true, available: true, bot: { connected: true } });
  await until(() => f.actions.$('[data-staff-notify-connect]')?.disabled === false);
  await f.module.syncStaffNotifications();
  f.actions.$('[data-staff-max-connect]').click();
  await until(() => f.actions.$('[data-staff-channel="max"] a'));
  const url = f.actions.$('[data-staff-channel="max"] a').href;
  f.w.document.body.innerHTML = '<div id="staff-notifications"></div>';
  f.module.mountStaffNotifications();
  assert.equal(f.actions.$('[data-staff-channel="max"] a').href, url);
  await delay(0);
  f.setMaxStatus({ linked: true, compatible: true, enabled: true, bindingId: 'binding' });
  await f.module.syncStaffNotifications();
  f.actions.confirmAction = async () => {
    throw Error('Synthetic confirmation failure');
  };
  f.actions.$('[data-staff-max-unlink]').click();
  await until(() => f.w.document.body.textContent.includes('Не удалось подтвердить действие'));
  assert.equal(f.actions.$('[data-staff-max-unlink]').disabled, false);
  assert.equal(f.posts.length, 1);
});

const personalEvents = [
  'new-request',
  'client-agreed',
  'client-declined',
  'created',
  'moved',
  'cancelled',
  'confirmation',
  'completed',
  'no_show',
  'restored',
  'removed',
  'updated',
];
function readyStaffForms(f) {
  f.setStatus({
    linked: true,
    enabled: true,
    bindingId: 'telegram-binding',
    events: ['new-request', 'moved'],
  });
  f.setMaxStatus({
    prepared: true,
    available: true,
    bot: { connected: true },
    linked: true,
    compatible: true,
    enabled: true,
    bindingId: 'max-binding',
    events: ['client-agreed'],
  });
  return f.module.syncStaffNotifications();
}
const selectedStaffEvents = (form) =>
  [...form.querySelectorAll('[name="event"]:checked')].map((field) => field.value);
function selectStaffEvents(f, form, events) {
  for (const field of form.querySelectorAll('[name="event"]'))
    field.checked = events.includes(field.value);
  form.querySelector('[name="event"]').dispatchEvent(new f.w.Event('change', { bubbles: true }));
}
const submitStaffEvents = (f, form) =>
  form.dispatchEvent(new f.w.Event('submit', { bubbles: true, cancelable: true }));

test('staff event forms show individual categories and disable only the unavailable channel', async (t) => {
  const f = fixture(t);
  await until(() => f.actions.$('[data-staff-notify-connect]'));
  await readyStaffForms(f);
  const telegram = f.actions.$('[data-staff-notify-events]');
  assert.deepEqual(
    [...telegram.querySelectorAll('[name="event"]')].map((field) => field.value),
    personalEvents,
  );
  assert.deepEqual(selectedStaffEvents(telegram), ['new-request', 'moved']);
  assert.equal(telegram.querySelector('fieldset').disabled, false);
  assert.equal(f.actions.$('[data-staff-max-events] fieldset').disabled, false);
  f.setMaxStatus({ bot: { connected: false } });
  await f.module.syncStaffNotifications();
  assert.equal(f.actions.$('[data-staff-max-events] fieldset').disabled, true);
  assert.equal(f.actions.$('[data-staff-notify-events]'), telegram);
  assert.equal(telegram.querySelector('fieldset').disabled, false);
  assert.equal(f.actions.$('[data-staff-notify-toggle]').disabled, false);
  assert.equal(f.actions.$('[data-staff-max-toggle]').disabled, true);
  assert.equal(f.posts.length, 0);
});

test('staff drafts survive same-binding polling and are cleared by a replacement binding', async (t) => {
  const f = fixture(t);
  await until(() => f.actions.$('[data-staff-notify-connect]'));
  await readyStaffForms(f);
  selectStaffEvents(f, f.actions.$('[data-staff-notify-events]'), ['created', 'completed']);
  f.setStatus({ events: ['cancelled'] });
  await f.module.syncStaffNotifications();
  assert.deepEqual(selectedStaffEvents(f.actions.$('[data-staff-notify-events]')), [
    'created',
    'completed',
  ]);
  assert.deepEqual(selectedStaffEvents(f.actions.$('[data-staff-max-events]')), ['client-agreed']);
  const priorForm = f.actions.$('[data-staff-notify-events]');
  f.setStatus({ bindingId: 'new-telegram-binding', events: ['cancelled'] });
  await f.module.syncStaffNotifications();
  assert.notEqual(f.actions.$('[data-staff-notify-events]'), priorForm);
  assert.deepEqual(selectedStaffEvents(f.actions.$('[data-staff-notify-events]')), ['cancelled']);
});

test('saving staff categories keeps the other channel usable and posts each independent binding', async (t) => {
  const f = fixture(t);
  await until(() => f.actions.$('[data-staff-notify-connect]'));
  await readyStaffForms(f);
  const original = f.actions.request;
  let release,
    entered = false;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  f.actions.request = async (url, options) => {
    if (url === '/api/telegram/staff/settings') {
      entered = true;
      await held;
    }
    return original(url, options);
  };
  selectStaffEvents(f, f.actions.$('[data-staff-notify-events]'), ['created', 'moved']);
  submitStaffEvents(f, f.actions.$('[data-staff-notify-events]'));
  await until(() => entered);
  assert.equal(f.actions.$('[data-staff-notify-events] fieldset').disabled, true);
  assert.equal(f.actions.$('[data-staff-max-events] fieldset').disabled, false);
  selectStaffEvents(f, f.actions.$('[data-staff-max-events]'), ['client-declined', 'confirmation']);
  submitStaffEvents(f, f.actions.$('[data-staff-max-events]'));
  await until(
    () =>
      f.posts.some((post) => post.url === '/api/max/staff/settings') &&
      !f.actions.$('[data-staff-max-events] fieldset').disabled,
  );
  assert.deepEqual(f.posts.at(-1), {
    url: '/api/max/staff/settings',
    body: {
      bindingId: 'max-binding',
      events: ['client-declined', 'confirmation'],
    },
  });
  assert.equal(f.actions.$('[data-staff-notify-events] fieldset').disabled, true);
  release();
  await until(
    () =>
      f.posts.some((post) => post.url === '/api/telegram/staff/settings') &&
      !f.actions.$('[data-staff-notify-events] fieldset').disabled,
  );
  assert.deepEqual(f.posts.find((post) => post.url === '/api/telegram/staff/settings').body, {
    bindingId: 'telegram-binding',
    events: ['created', 'moved'],
  });
  assert.equal(f.actions.$('[data-staff-notify-toggle]').checked, true);
  assert.equal(f.actions.$('[data-staff-max-toggle]').checked, true);
});

test('staff save errors preserve selected categories and an empty save does not disconnect either channel', async (t) => {
  const f = fixture(t);
  await until(() => f.actions.$('[data-staff-notify-connect]'));
  await readyStaffForms(f);
  const original = f.actions.request;
  f.actions.request = async (url, options) => {
    if (url === '/api/telegram/staff/settings') throw Error('Synthetic preferences failure');
    return original(url, options);
  };
  selectStaffEvents(f, f.actions.$('[data-staff-notify-events]'), ['created', 'removed']);
  submitStaffEvents(f, f.actions.$('[data-staff-notify-events]'));
  await until(() => f.w.document.body.textContent.includes('Synthetic preferences failure'));
  assert.deepEqual(selectedStaffEvents(f.actions.$('[data-staff-notify-events]')), [
    'created',
    'removed',
  ]);
  assert.equal(f.actions.$('[data-staff-notify-events] fieldset').disabled, false);
  assert.deepEqual(selectedStaffEvents(f.actions.$('[data-staff-max-events]')), ['client-agreed']);
  f.actions.request = original;
  selectStaffEvents(f, f.actions.$('[data-staff-notify-events]'), []);
  submitStaffEvents(f, f.actions.$('[data-staff-notify-events]'));
  await until(
    () => f.posts.length === 1 && !f.actions.$('[data-staff-notify-events] fieldset').disabled,
  );
  assert.deepEqual(f.posts[0], {
    url: '/api/telegram/staff/settings',
    body: { bindingId: 'telegram-binding', events: [] },
  });
  assert.match(
    f.actions.$('[data-staff-channel="telegram"] .staff-channel-status').textContent,
    /События не выбраны/,
  );
  assert.equal(f.actions.$('[data-staff-notify-toggle]').checked, true);
  assert.equal(f.actions.$('[data-staff-max-toggle]').checked, true);
  assert.ok(f.actions.$('[data-staff-notify-unlink]'));
});
