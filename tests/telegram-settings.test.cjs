const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  { JSDOM } = require('jsdom');
const source = fs.readFileSync(
  path.join(__dirname, '../src/client/modules/telegram-settings.js'),
  'utf8',
);

test('connection colors follow background status without replacing the reminder draft', async (t) => {
  const w = new JSDOM(
    '<section id="telegram-settings"><div id="telegram-client-settings"></div></section>',
    { runScripts: 'outside-only' },
  ).window;
  t.after(() => w.close());
  w.eval(source);
  let bot = { connected: true, configured: true, username: 'Synthetic_bot' };
  let max = { configured: true, running: true };
  const actions = {
    settingsSectionVisible: () => true,
    readBackground: (route) => actions.request(route),
    mountStaffNotifications() {},
    mountClientNotificationSettings() {},
    canManageTeam: () => true,
    $: (selector) => w.document.querySelector(selector),
    esc: (value) => String(value),
    settingsHelpHtml: () => '',
    request: async () => ({ settings: { leadMinutes: 60 }, bot, max }),
  };
  const module = w.eval('createTelegramSettings')({}, actions);
  await module.loadTelegramSettings();
  const form = actions.$('#telegram-settings-form');
  form.elements.leadMinutes.value = '20160';
  assert.equal(actions.$('#telegram-bot-status').dataset.connectionState, 'connected');
  assert.equal(actions.$('#max-bot-status').dataset.connectionState, 'connected');
  assert.ok(actions.$('#telegram-bot-status svg'));
  assert.equal(actions.$('#telegram-bot-status [data-channel-mark]').textContent, '✓');
  assert.match(actions.$('#telegram-bot-status').getAttribute('aria-label'), /Telegram/);
  assert.doesNotMatch(actions.$('#telegram-bot-status').textContent, /Telegram|Подключён бот/);
  assert.equal(actions.$('#client-notification-settings').closest('form'), null);
  bot = { connected: false, configured: true };
  max = { configured: true, running: false };
  await module.loadTelegramSettings({ statusOnly: true });
  assert.equal(actions.$('#telegram-bot-status').dataset.connectionState, 'checking');
  assert.equal(actions.$('#max-bot-status').dataset.connectionState, 'checking');
  bot = { connected: false, configured: false };
  max = { configured: false };
  await module.loadTelegramSettings({ statusOnly: true });
  assert.equal(actions.$('#telegram-bot-status').dataset.connectionState, 'unlinked');
  assert.equal(actions.$('#max-bot-status').dataset.connectionState, 'unlinked');
  assert.ok(actions.$('#telegram-bot-status svg'));
  assert.equal(actions.$('#telegram-bot-status [data-channel-mark]').textContent, '−');
  assert.equal(actions.$('#telegram-settings-form'), form);
  assert.equal(form.elements.leadMinutes.value, '20160');
});

test('a saved service-visibility preview reads fresh data instead of joining an older pending status GET', async (t) => {
  const w = new JSDOM('<section id="telegram-settings"><div id="telegram-client-settings"></div></section>',
    { runScripts: 'outside-only', pretendToBeVisual: true }).window;
  t.after(() => w.close());
  w.Date.now = () => 100000;
  w.eval(source);
  w.eval(fs.readFileSync(path.join(__dirname, '../src/client/modules/settings-pages.js'), 'utf8'));
  const state = { currentView: 'settings', account: { id: 'a', organizationId: 'o' } },
    stale = { settings: { leadMinutes: 60 }, bot: { connected: true, configured: true, username: 'Synthetic_bot' },
      max: { configured: true, running: true }, preview: 'Before service visibility save', maxPreview: 'Before MAX save' };
  let finishStatus, explicitReads = 0;
  const pendingStatus = new Promise(resolve => { finishStatus = resolve; });
  const actions = {
    $: selector => w.document.querySelector(selector), esc: value => String(value), settingsHelpHtml: () => '',
    canManageTeam: () => true, mountStaffNotifications() {}, mountClientNotificationSettings() {},
    readBackground: async () => structuredClone(stale),
    request: async route => {
      assert.equal(route, '/api/notifications/reminders'); explicitReads++;
      return { ...stale, preview: 'After service visibility save', maxPreview: 'After MAX save' };
    },
  };
  Object.assign(actions, w.eval('createSettingsPages')(state, actions));
  const settings = w.eval('createTelegramSettings')(state, actions);
  Object.assign(actions, settings);
  settings.bindTelegramSettingsEvents();
  await settings.loadTelegramSettings();
  const form = actions.$('#telegram-settings-form');
  form.elements.leadMinutes.value = '120';
  actions.readBackground = () => pendingStatus;
  const oldStatus = settings.loadTelegramSettings({ statusOnly: true });
  actions.$('#client-notification-settings').dispatchEvent(new w.Event('client-notification-visibility-saved', { bubbles: true }));
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(explicitReads, 1);
  assert.equal(actions.$('#telegram-message-preview').textContent, 'After service visibility save');
  assert.equal(actions.$('#max-message-preview').textContent, 'After MAX save');
  finishStatus(structuredClone(stale));
  await oldStatus;
  assert.equal(actions.$('#telegram-message-preview').textContent, 'After service visibility save');
  assert.equal(actions.$('#telegram-settings-form'), form);
  assert.equal(form.elements.leadMinutes.value, '120');
});

for (const leadMinutes of [60, 20160, 45])
  test(
    'reminder selector includes fourteen days and keeps saved period ' + leadMinutes,
    async (t) => {
      const w = new JSDOM(
        '<section id="telegram-settings"><div id="telegram-client-settings"></div></section>',
        {
          runScripts: 'outside-only',
        },
      ).window;
      t.after(() => w.close());
      w.eval(source);
      const actions = {
        settingsSectionVisible: () => true,
        readBackground: (route) => actions.request(route),
        mountStaffNotifications() {},
        mountClientNotificationSettings() {},
        canManageTeam: () => true,
        $: (selector) => w.document.querySelector(selector),
        esc: (value) => String(value),
        settingsHelpHtml: () => '',
        request: async () => ({
          settings: { leadMinutes },
          bot: { connected: false, configured: false },
          max: { configured: false },
        }),
      };
      const settings = w.eval('createTelegramSettings')({}, actions);
      await settings.loadTelegramSettings();
      const select = actions.$('#telegram-settings-form select[name="leadMinutes"]');
      assert.equal(select.value, String(leadMinutes));
      const periods = Array.from(select.options, (option) => Number(option.value));
      assert.ok(periods.includes(10080));
      assert.equal(periods.filter((value) => value === 20160).length, 1);
      assert.match(select.querySelector('[value="20160"]').textContent, /14/);
      select.value = '20160';
      await settings.loadTelegramSettings({ statusOnly: true });
      assert.equal(actions.$('#telegram-settings-form select[name="leadMinutes"]'), select);
      assert.equal(select.value, '20160');
    },
  );
test('Telegram settings grid shrinks to narrow screens and wraps long text without clipping', () => {
  const css = require('postcss').parse(
    fs.readFileSync(path.join(__dirname, '../src/client/styles/telegram-base.css'), 'utf8'),
  );
  const declarations = (selector) => {
    const rule = css.nodes.find((node) => node.type === 'rule' && node.selector === selector);
    assert.ok(rule, 'Missing Telegram layout rule: ' + selector);
    return Object.fromEntries(
      rule.nodes.filter((node) => node.type === 'decl').map((node) => [node.prop, node.value]),
    );
  };
  const form = declarations('.telegram-settings-form');
  const children = declarations('.telegram-settings-form>*');
  const select = declarations('.telegram-settings-form select');
  assert.equal(form['grid-template-columns'], 'minmax(0,1fr)');
  assert.equal(form['min-width'], '0');
  assert.equal(children['min-width'], '0');
  assert.equal(children['overflow-wrap'], 'anywhere');
  assert.equal(select.width, '100%');
  assert.equal(select['min-width'], '0');
  assert.equal(select['max-width'], '100%');
  assert.equal(select.contain, 'paint');
  assert.equal(form.overflow, undefined);
  assert.equal(children.overflow, undefined);
  assert.equal(select.overflow, undefined);
});
async function until(fn) {
  const end = Date.now() + 3000;
  while (!fn()) {
    if (Date.now() > end) throw Error('Settings UI timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
for (const width of [390, 1440])
  test(
    'Russian-only timezones require an explicit replacement of a legacy foreign zone at ' + width,
    async (t) => {
      const dom = new JSDOM('<div id="organization-time-zone-settings"></div>', {
          runScripts: 'outside-only',
        }),
        w = dom.window;
      t.after(() => w.close());
      w.matchMedia = () => ({ matches: width >= 980, addEventListener() {} });
      const state = { busy: false },
        saved = { enabled: true, leadMinutes: 60, timeZone: 'Asia/Yerevan', showServices: true },
        writes = [];
      let confirmations = 0;
      w.confirm = () => {
        confirmations++;
        return false;
      };
      const actions = {
        settingsSectionVisible: () => true,
        readBackground: (route) => actions.request(route),
        markSettingsSaved() {},
        confirmAction: async () => w.confirm(),
        applyCabinetTimeZone: (zone) => {
          state.timeZone = zone;
        },
        canManageTeam: () => true,
        $: (s) => w.document.querySelector(s),
        esc: (s) =>
          String(s).replace(
            /[&<>"']/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
          ),
        toast() {},
        async request(route, options) {
          if (route === '/api/cabinet/time-zone' && options?.method === 'POST') {
            const body = JSON.parse(options.body);
            writes.push(body);
            Object.assign(saved, body);
            return { timeZone: saved.timeZone };
          }
          return { timeZone: saved.timeZone };
        },
      };
      w.eval(
        fs.readFileSync(path.join(__dirname, '../src/client/modules/settings-help.js'), 'utf8'),
      );
      Object.assign(actions, w.eval('createSettingsHelp')(state, actions));
      w.eval(source + '\nwindow.makeSettings=createTelegramSettings;');
      Object.assign(actions, w.makeSettings(state, actions));
      w.eval(
        fs.readFileSync(
          path.join(__dirname, '../src/client/modules/organization-time-zone.js'),
          'utf8',
        ),
      );
      Object.assign(actions, w.eval('createOrganizationTimeZoneSettings')(state, actions));
      actions.bindOrganizationTimeZoneEvents();
      await actions.mountOrganizationTimeZone();
      const form = actions.$('#organization-time-zone-form'),
        select = form.elements.timeZone;
      assert.equal(select.value, '');
      assert.equal(select.options[0].disabled, true);
      assert.match(select.options[0].textContent, /российский/);
      const zones = [...select.options].map((o) => o.value).filter(Boolean);
      assert.equal(zones.length, 11);
      assert.ok(zones.includes('Europe/Moscow') && zones.includes('Asia/Kamchatka'));
      assert.ok(!zones.includes('UTC') && !zones.includes('Asia/Yerevan'));
      assert.equal(form.dataset.timeZone, 'Asia/Yerevan');
      assert.equal(form.elements.showServices, undefined);
      const submit = () =>
        form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      submit();
      assert.equal(confirmations, 0);
      assert.equal(writes.length, 0);
      assert.equal(saved.timeZone, 'Asia/Yerevan');
      select.value = 'Europe/Samara';
      submit();
      await until(() => confirmations === 1 && !state.busy);
      assert.equal(confirmations, 1);
      assert.equal(writes.length, 0);
      assert.equal(select.value, 'Europe/Samara');
      assert.equal(saved.timeZone, 'Asia/Yerevan');
      w.confirm = () => {
        confirmations++;
        return true;
      };
      submit();
      await until(() => saved.timeZone === 'Europe/Samara' && !state.busy);
      assert.equal(confirmations, 2);
      assert.equal(writes.length, 1);
      assert.equal(saved.timeZone, 'Europe/Samara');
      assert.equal(
        actions.$('#organization-time-zone-form').elements.timeZone.value,
        'Europe/Samara',
      );
      assert.equal(state.timeZone, 'Europe/Samara');
    },
  );
