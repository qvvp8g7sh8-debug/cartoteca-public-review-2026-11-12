const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(
  path.join(__dirname, '../src/client/modules/telegram-settings.js'),
  'utf8',
);
const delay = () => new Promise(setImmediate);
async function until(condition) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await delay();
  }
  throw Error('Notification settings UI timeout');
}
const clientEvents = ['created', 'moved', 'cancelled', 'reminder'];
const selected = (form) =>
  [...form.querySelectorAll('[name="notificationEvent"]:checked')].map((field) => field.value);
function choose(f, form, events, lead = form.elements.leadMinutes.value) {
  for (const field of form.querySelectorAll('[name="notificationEvent"]'))
    field.checked = events.includes(field.value);
  form.elements.leadMinutes.value = String(lead);
  form.elements.leadMinutes.dispatchEvent(new f.w.Event('change', { bubbles: true }));
}
const submit = (f, form) =>
  form.dispatchEvent(new f.w.Event('submit', { bubbles: true, cancelable: true }));
async function fixture(t, initial = {}) {
  const w = new JSDOM(
    '<section id="telegram-settings"><div id="telegram-client-settings"></div></section>',
    { runScripts: 'outside-only', url: 'https://synthetic.test/', pretendToBeVisual: true },
  ).window;
  t.after(() => w.close());
  w.eval(source);
  const state = {
    account: { id: 'owner', organizationId: 'org' },
    currentView: 'settings',
    busy: false,
  };
  let settings = { leadMinutes: 1440, events: ['reminder'], ...initial },
    failPost = null;
  const posts = [],
    reads = [],
    toasts = [];
  const snapshot = () =>
    structuredClone({
      settings,
      bot: { configured: true, connected: true, username: 'Synthetic_bot' },
      max: { configured: true, running: true },
      preview: 'Synthetic Telegram',
      maxPreview: 'Synthetic MAX',
    });
  const actions = {
    $: (selector) => w.document.querySelector(selector),
    esc: (value) =>
      String(value).replace(
        /[&<>"']/g,
        (character) =>
          ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
      ),
    canManageTeam: () => true,
    settingsSectionVisible: (element) =>
      state.currentView === 'settings' && Boolean(element?.isConnected),
    settingsHelpHtml: () => '',
    mountStaffNotifications() {},
    mountClientNotificationSettings() {
      // This independent form must never leak its fields into the reminders POST.
      actions.$('#client-notification-settings').innerHTML =
        '<form><input type="checkbox" name="notificationEvent" value="unrelated-event" checked><input type="checkbox" name="showServices" checked></form>';
    },
    markSettingsSaved() {},
    toast: (message) => toasts.push(message),
    confirmAction: async () => true,
    readBackground: async (url) => {
      reads.push(url);
      return snapshot();
    },
    request: async (url, options = {}) => {
      assert.equal(url, '/api/notifications/reminders');
      if (options.method !== 'POST') return snapshot();
      const body = JSON.parse(options.body);
      posts.push(body);
      if (failPost) throw failPost;
      if (
        JSON.stringify(body.expectedEvents) !== JSON.stringify(settings.events || ['reminder']) ||
        body.expectedLeadMinutes !== settings.leadMinutes
      )
        throw Object.assign(Error('Настройки уже изменены. Обновите состояние.'), { status: 409 });
      settings = { ...settings, events: [...body.events], leadMinutes: body.leadMinutes };
      return snapshot();
    },
  };
  const module = w.eval('createTelegramSettings')(state, actions);
  Object.assign(actions, module);
  module.bindTelegramSettingsEvents();
  await module.loadTelegramSettings();
  return {
    w,
    state,
    actions,
    module,
    posts,
    reads,
    toasts,
    setServer: (value) => {
      settings = { ...settings, ...value };
    },
    setPostError: (value) => {
      failPost = value;
    },
  };
}

test('client settings expose only four lifecycle categories and preserve CAS values without unrelated fields', async (t) => {
  const f = await fixture(t, { leadMinutes: 60, events: ['moved', 'reminder'] });
  const form = f.actions.$('#telegram-settings-form');
  assert.deepEqual(
    [...form.querySelectorAll('[name="notificationEvent"]')].map((field) => field.value),
    clientEvents,
  );
  choose(f, form, ['created', 'cancelled'], 30);
  submit(f, form);
  await until(() => f.posts.length === 1 && !f.state.busy);
  assert.deepEqual(f.posts[0], {
    leadMinutes: 30,
    events: ['created', 'cancelled'],
    expectedEvents: ['moved', 'reminder'],
    expectedLeadMinutes: 60,
  });
  const saved = f.actions.$('#telegram-settings-form');
  assert.deepEqual(selected(saved), ['created', 'cancelled']);
  assert.deepEqual(JSON.parse(saved.dataset.notificationEvents), ['created', 'cancelled']);
  assert.equal(saved.dataset.leadMinutes, '30');
  assert.equal(f.posts[0].showServices, undefined);
});

test('status-only polling preserves client drafts and a concurrent server edit fails CAS without losing them', async (t) => {
  const f = await fixture(t);
  const form = f.actions.$('#telegram-settings-form');
  choose(f, form, ['created', 'moved'], 120);
  f.setServer({ events: ['cancelled'], leadMinutes: 30 });
  await f.module.loadTelegramSettings({ statusOnly: true });
  assert.equal(f.actions.$('#telegram-settings-form'), form);
  assert.deepEqual(selected(form), ['created', 'moved']);
  assert.equal(form.elements.leadMinutes.value, '120');
  assert.deepEqual(JSON.parse(form.dataset.notificationEvents), ['reminder']);
  submit(f, form);
  await until(() => f.posts.length === 1 && !f.state.busy);
  assert.deepEqual(f.posts[0].expectedEvents, ['reminder']);
  assert.equal(f.posts[0].expectedLeadMinutes, 1440);
  assert.match(
    form.querySelector('#telegram-settings-message').textContent,
    /Настройки уже изменены/,
  );
  assert.equal(f.actions.$('#telegram-settings-form'), form);
  assert.deepEqual(selected(form), ['created', 'moved']);
  assert.equal(form.querySelector('[type="submit"]').disabled, false);
  assert.equal(f.toasts.length, 0);
});

test('client save failure retains fields and an empty event selection remains explicitly empty after save', async (t) => {
  const f = await fixture(t);
  const form = f.actions.$('#telegram-settings-form');
  choose(f, form, ['created'], 60);
  f.setPostError(Error('Synthetic client settings failure'));
  submit(f, form);
  await until(() => f.posts.length === 1 && !f.state.busy);
  assert.deepEqual(selected(form), ['created']);
  assert.equal(form.elements.leadMinutes.value, '60');
  assert.match(
    form.querySelector('#telegram-settings-message').textContent,
    /Synthetic client settings failure/,
  );
  assert.equal(form.querySelector('[type="submit"]').disabled, false);
  f.setPostError(null);
  choose(f, form, [], 60);
  submit(f, form);
  await until(() => f.posts.length === 2 && !f.state.busy);
  assert.deepEqual(f.posts[1], {
    leadMinutes: 60,
    events: [],
    expectedEvents: ['reminder'],
    expectedLeadMinutes: 1440,
  });
  const saved = f.actions.$('#telegram-settings-form');
  assert.deepEqual(selected(saved), []);
  assert.deepEqual(JSON.parse(saved.dataset.notificationEvents), []);
});

test('a newer client draft survives an in-flight save and its next POST uses the accepted server baseline', async (t) => {
  const f = await fixture(t),
    original = f.actions.request;
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  f.actions.request = async (url, options) => {
    const result = await original(url, options);
    if (options?.method === 'POST') await held;
    return result;
  };
  let form = f.actions.$('#telegram-settings-form');
  choose(f, form, ['created'], 60);
  submit(f, form);
  await until(() => f.posts.length === 1);
  choose(f, form, ['created', 'moved'], 120);
  release();
  await until(() => !f.state.busy);
  form = f.actions.$('#telegram-settings-form');
  assert.deepEqual(selected(form), ['created', 'moved']);
  assert.equal(form.elements.leadMinutes.value, '120');
  f.actions.request = original;
  submit(f, form);
  await until(() => f.posts.length === 2 && !f.state.busy);
  assert.deepEqual(f.posts[1], {
    leadMinutes: 120,
    events: ['created', 'moved'],
    expectedEvents: ['created'],
    expectedLeadMinutes: 60,
  });
});

for (const replacedRoot of [false, true])
  test(
    'client save completion from an old organization is ignored with replacedRoot=' + replacedRoot,
    async (t) => {
      const f = await fixture(t),
        original = f.actions.request;
      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      t.after(() => release());
      f.actions.request = async (url, options) => {
        const result = await original(url, options);
        if (options?.method === 'POST') await held;
        return result;
      };
      const form = f.actions.$('#telegram-settings-form');
      choose(f, form, ['created'], 60);
      submit(f, form);
      await until(() => f.posts.length === 1);
      f.state.account.organizationId = 'another-org';
      if (replacedRoot)
        f.w.document.body.innerHTML =
          '<section id="telegram-settings"><div id="telegram-client-settings">Other workspace</div></section>';
      const reads = f.reads.length;
      release();
      await until(() => !f.state.busy);
      if (replacedRoot) {
        assert.equal(f.actions.$('#telegram-client-settings').textContent, 'Other workspace');
        assert.equal(f.actions.$('#telegram-settings-form'), null);
      } else {
        assert.equal(f.actions.$('#telegram-settings-form'), form);
        assert.deepEqual(JSON.parse(form.dataset.notificationEvents), ['reminder']);
      }
      assert.equal(f.toasts.length, 0);
      assert.equal(f.reads.length, reads);
    },
  );
