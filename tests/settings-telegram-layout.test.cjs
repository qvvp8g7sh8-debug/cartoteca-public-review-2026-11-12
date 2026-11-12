const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function fixture(t, manager = true) {
  const w = new JSDOM(
    '<main id="global-view"><section class="settings-panel"><div class="settings-tiles"></div></section></main>',
    {
      runScripts: 'outside-only',
      url: 'https://synthetic.test/',
      pretendToBeVisual: true,
    },
  ).window;
  t.after(async () => {
    // Let queued native details toggle events finish before destroying their document.
    await new Promise((resolve) => setTimeout(resolve, 10));
    w.close();
  });
  for (const file of [
    'settings-help',
    'team',
    'team-events',
    'settings-pages',
    'telegram-settings',
    'staff-notifications',
  ]) {
    w.eval(fs.readFileSync(path.join(__dirname, '../src/client/modules', file + '.js'), 'utf8'));
  }
  const state = {
    account: { id: 'account', organizationId: 'organization' },
    currentView: 'settings',
    busy: false,
    multiUser: true,
    roleNames: {},
  };
  const calls = [];
  const actions = {
    syncVisibleTelegram: async () => {},
    $: (selector) => w.document.querySelector(selector),
    canManageTeam: () => manager,
    mountClientNotificationSettings() {},
    esc: (value) =>
      String(value).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
      ),
    readBackground: async (url) =>
      url === '/api/notifications/reminders'
        ? actions.request(url)
        : { linked: false, available: true, bot: { connected: true } },
    request: async (url) => {
      calls.push(url);
      return {
        settings: { timeZone: 'Europe/Moscow', enabled: true, leadMinutes: 60, showServices: true },
        bot: { connected: true, username: 'Synthetic_bot' },
        preview: 'Пример',
        maxPreview: 'Пример MAX',
        max: { configured: false, running: false },
      };
    },
  };
  Object.assign(actions, w.eval('createSettingsHelp')(state, actions));
  require('./helpers/staff-channel-ui.cjs').installStaffChannelUI(w, state, actions);
  Object.assign(actions, w.eval('createTeam')(state, actions));
  Object.assign(actions, w.eval('createStaffNotifications')(state, actions));
  Object.assign(actions, w.eval('createTelegramSettings')(state, actions));
  Object.assign(actions, w.eval('createSettingsPages')(state, actions));
  actions.$('.settings-tiles').innerHTML =
    actions.settingsSectionHtml(
      'Сотрудники и доступ',
      manager ? 'team-settings' : 'personal-access',
      '<div id="staff-notifications"></div>',
    ) + actions.telegramSettingsHtml();
  actions.bindSettingsPageEvents();
  return { w, actions, calls };
}

test('staff retains personal Telegram settings without loading client administration', async (t) => {
  const f = fixture(t, false);
  await f.actions.loadTelegramSettings();
  assert.ok(f.actions.$('#personal-access #staff-notifications'));
  assert.equal(f.actions.$('#telegram-client-settings'), null);
  assert.deepEqual(f.calls, []);
  assert.match(
    f.actions.$('#staff-notifications [data-settings-help]').dataset.helpText,
    /^События ваших заявок и записей в Telegram и MAX\./,
  );
});

test('refresh of client reminders preserves personal UI and invitation', async (t) => {
  const f = fixture(t);
  f.actions.$('#telegram-settings').closest('details').open = true;
  await f.actions.loadTelegramSettings();
  const personalHeading = f.actions.$('#telegram-staff-heading');
  assert.match(
    f.actions.$('#staff-notifications [data-settings-help]').dataset.helpText,
    /всей организации/,
  );
  const form = f.actions.$('#telegram-settings-form');
  form.elements.leadMinutes.value = '120';
  await f.actions.loadTelegramSettings({ statusOnly: true });
  assert.equal(f.actions.$('#telegram-settings-form'), form);
  assert.equal(form.elements.leadMinutes.value, '120');
  await f.actions.loadTelegramSettings();
  assert.notEqual(f.actions.$('#telegram-settings-form'), form);
  assert.equal(f.actions.$('#telegram-staff-heading'), personalHeading);
});

test('client settings failure does not hide the personal Telegram connection', async (t) => {
  const f = fixture(t);
  const personal = f.actions.$('#staff-notifications').closest('details');
  personal.open = true;
  f.actions.mountStaffNotifications();
  await f.actions.syncStaffNotifications();
  personal.open = false;
  f.actions.$('#telegram-settings').closest('details').open = true;
  f.actions.request = async () => {
    throw Error('Нет связи');
  };
  await f.actions.loadTelegramSettings();
  assert.ok(f.actions.$('[data-telegram-settings-retry]'));
  assert.ok(f.actions.$('[data-staff-notify-connect]'));
  assert.match(f.actions.$('#telegram-client-settings').textContent, /Нет связи/);
});

test('only top-level settings collapse; form drafts and nested panels remain intact', (t) => {
  const f = fixture(t);
  f.actions.$('.settings-tiles').innerHTML =
    f.actions.settingsSectionHtml(
      'Профиль',
      'profile-settings',
      '<input value="Сохранить черновик">',
    ) + f.actions.telegramSettingsHtml();
  f.w.eval('createTeamEvents')({}, f.actions).bindTeamEvents();
  const profile = f.actions.$('#profile-settings').closest('details');
  const telegram = f.actions.$('#telegram-settings').closest('details');
  assert.equal(profile.getAttribute('name'), 'cartoteca-settings');
  profile.open = true;
  profile.dispatchEvent(new f.w.Event('toggle'));
  telegram.open = true;
  telegram.dispatchEvent(new f.w.Event('toggle'));
  assert.equal(profile.open, false);
  assert.equal(telegram.open, true);
  assert.equal(f.actions.$('#profile-settings input').value, 'Сохранить черновик');
  const nested = f.w.document.createElement('details');
  nested.innerHTML = '<summary>Подробнее</summary>';
  f.actions.$('#telegram-settings').append(nested);
  nested.open = true;
  nested.dispatchEvent(new f.w.Event('toggle'));
  assert.equal(telegram.open, true);
  assert.equal(nested.open, true);
});
