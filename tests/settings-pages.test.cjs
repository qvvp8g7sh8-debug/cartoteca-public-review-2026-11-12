const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const expectedOwnerPages = [
  ['profile-settings', 'Мой профиль'],
  ['integrations-settings', 'Интеграции'],
  ['paid-services-settings', 'Пакеты и оплата'],
  ['team-settings', 'Сотрудники и доступ'],
  ['workspace-settings', 'Кабинеты и занятость'],
  ['online-booking-settings', 'Онлайн-запись'],
  ['telegram-settings', 'Напоминания клиентам'],
  ['support-settings', 'Техподдержка'],
  ['improvement-settings', 'Развитие Картотеки'],
];

async function fixture(t, width = 390) {
  const errors = [], virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error.message));
  const w = new JSDOM(
    '<header class="topbar" style="position:fixed"><nav class="app-nav"></nav></header><main id="global-view"></main>',
    { runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole },
  ).window;
  t.after(async () => {
    // Flush queued native details toggles before disposing the synthetic document.
    await new Promise((resolve) => w.setTimeout(() => w.setTimeout(resolve, 0), 0));
    try { assert.deepEqual(errors, []); } finally { w.close(); }
  });
  const media = [];
  w.matchMedia = () => {
    const query = {
      get matches() {
        return width >= 980;
      },
      listeners: [],
      addEventListener(_, fn) {
        this.listeners.push(fn);
      },
    };
    media.push(query);
    return query;
  };
  for (const name of ['team', 'profile', 'profile-overview', 'settings-pages'])
    w.eval(fs.readFileSync(path.join(__dirname, '../src/client/modules', name + '.js'), 'utf8'));
  const state = {
    multiUser: true,
    currentView: 'settings',
    busy: false,
    account: {
      id: 'demo',
      organizationId: 'org',
      displayName: 'Анна Примерова',
      email: 'example@example.test',
    },
    roleNames: { owner: 'Владелец' },
  };
  let confirm = true,
    saves = 0;
  const result = {
    account: state.account,
    specialty: 'Тренер',
    organization: { name: '<Студия>', city: 'Город', phone: '' },
    canEditOrganization: true,
  };
  const actions = {
    syncVisibleTelegram: async () => {},
    $: (s) => w.document.querySelector(s),
    esc: (value) =>
      String(value ?? '').replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
      ),
    accountRole: () => 'owner',
    canManageTeam: () => true,
    canManageMembers: () => true,
    initials: () => 'АП',
    settingsHelpHtml: () => '',
    markSettingsSaved: () => saves++,
    request: async () => structuredClone(result),
    readBackground: async () => structuredClone(result),
    mountOrganizationTimeZone() {},
    confirmAction: async () => confirm,
    loadTeamAccess() {},
    toast() {},
  };
  Object.assign(
    actions,
    w.eval('createTeam')(state, actions),
    w.eval('createProfile')(state, actions),
    w.eval('createProfileOverview')(state, actions),
    w.eval('createSettingsPages')(state, actions),
  );
  for (const [name, id, title] of [
    ['integrations', 'integrations', 'Интеграции'],
    ['paidServices', 'paid-services', 'Пакеты и оплата'],
    ['workspace', 'workspace', 'Кабинеты и занятость'],
    ['onlineBooking', 'online-booking', 'Онлайн-запись'],
    ['telegram', 'telegram', 'Напоминания клиентам'],
    ['support', 'support', 'Техподдержка'],
    ['improvement', 'improvement', 'Развитие Картотеки'],
  ])
    actions[name + 'SettingsHtml'] = () =>
      actions.settingsSectionHtml(title, id + '-settings', '<input name="draft" value="Черновик">');
  actions.$('#global-view').innerHTML = actions.settingsHtml();
  assert.deepEqual(
    [...actions.$('.settings-tiles').children].map((page) => [
      page.querySelector('.settings-accordion-content').id,
      page.querySelector('.settings-page-title').textContent,
    ]),
    expectedOwnerPages,
  );
  actions.$('.topbar').getBoundingClientRect = () => ({ top: 720, bottom: 800 });
  actions.$('.settings-panel').getBoundingClientRect = () => ({ top: 16 });
  Object.defineProperty(w, 'innerHeight', { value: 800, configurable: true });
  actions.bindSettingsPageEvents();
  actions.bindProfileOverviewEvents();
  actions.mountSettingsPages();
  await actions.loadAccountProfile();
  return {
    w,
    state,
    actions,
    result,
    get saves() {
      return saves;
    },
    confirm(value) {
      confirm = value;
    },
    width(value) {
      width = value;
      media.forEach((q) => q.listeners.forEach((fn) => fn({ matches: q.matches })));
    },
    // Native details toggle is a queued task; setImmediate can run before it in JSDOM.
    settle: () => new Promise((resolve) => w.setTimeout(() => w.setTimeout(resolve, 0), 0)),
  };
}

test('mobile settings index opens one bounded page; Back and another page preserve the profile draft', async (t) => {
  const f = await fixture(t),
    $ = f.actions.$;
  assert.equal($('.settings-panel').style.getPropertyValue('--settings-space'), '688px');
  assert.equal($('details.settings-tile[open]'), null);
  const profile = $('#profile-settings').closest('details');
  profile.open = true;
  await f.settle();
  assert.equal($('.settings-panel').dataset.settingsOpen, 'profile-settings');
  assert.equal($('[data-profile-editor]').hidden, true);
  $('[data-profile-edit]').click();
  $('#account-profile-form').elements.city.value = 'Несохранённый город';
  profile.querySelector('[data-settings-back]').click();
  await f.settle();
  assert.equal($('.settings-panel').hasAttribute('data-settings-open'), false);
  const other = $('#team-settings').closest('details');
  other.open = true;
  await f.settle();
  profile.open = true;
  await f.settle();
  assert.equal(other.open, false);
  assert.equal($('#account-profile-form').elements.city.value, 'Несохранённый город');
});

test('desktop A shows the form; mobile B shows escaped information; resize retains entered values', async (t) => {
  const f = await fixture(t, 1440),
    $ = f.actions.$;
  assert.equal($('#profile-settings').closest('details').open, true);
  assert.equal($('[data-profile-editor]').hidden, false);
  assert.equal($('[data-profile-overview]').hidden, true);
  assert.ok($('[data-profile-overview]').textContent.includes('<Студия>'));
  assert.equal($('[data-profile-overview] Студия'), null);
  const form = $('#account-profile-form');
  form.elements.displayName.value = 'Черновик имени';
  f.width(390);
  assert.equal($('[data-profile-editor]').hidden, true);
  assert.equal($('[data-profile-overview]').hidden, false);
  $('[data-profile-edit]').click();
  assert.equal(form.elements.displayName.value, 'Черновик имени');
  f.width(1440);
  f.width(390);
  assert.equal($('[data-profile-editor]').hidden, false);
  assert.equal(form.elements.displayName.value, 'Черновик имени');
});

test('profile Cancel confirms changed fields, restores baseline only on acceptance, and respects busy/account scope', async (t) => {
  const f = await fixture(t),
    $ = f.actions.$,
    form = $('#account-profile-form');
  $('[data-profile-edit]').click();
  form.elements.city.value = 'Черновик';
  const saves = f.saves;
  f.confirm(false);
  $('[data-profile-cancel]').click();
  await f.settle();
  assert.equal(form.elements.city.value, 'Черновик');
  assert.equal(f.saves, saves);
  f.state.busy = true;
  f.confirm(true);
  $('[data-profile-cancel]').click();
  await f.settle();
  assert.equal(form.elements.city.value, 'Черновик');
  f.state.busy = false;
  $('[data-profile-cancel]').click();
  await f.settle();
  assert.equal(form.elements.city.value, 'Город');
  assert.equal($('[data-profile-editor]').hidden, true);
  $('[data-profile-edit]').click();
  form.elements.city.value = 'Другой';
  f.actions.confirmAction = async () => {
    f.state.account = { id: 'other' };
    return true;
  };
  $('[data-profile-cancel]').click();
  await f.settle();
  assert.equal(form.elements.city.value, 'Другой');
});
