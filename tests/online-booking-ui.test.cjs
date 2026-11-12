const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const { JSDOM } = require('jsdom');
const { setTimeout: delay } = require('node:timers/promises');
const source = fs.readFileSync(
  path.join(__dirname, '../src/client/modules/online-booking-settings.js'),
  'utf8',
);
const until = async (fn) => {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await delay(10);
  }
  throw Error('UI timeout');
};
function fixture(t, canManage = true, minimumLeadMinutes = 60) {
  const w = new JSDOM('<main></main>', { runScripts: 'outside-only', url: 'http://localhost/' })
    .window;
  t.after(() => w.close());
  w.eval(source);
  w.eval(fs.readFileSync(path.join(__dirname, '../src/client/modules/settings-help.js'), 'utf8'));
  const state = {
    account: { id: 'owner', organizationId: 'o' },
    multiUser: true,
    currentView: 'settings',
    busy: false,
    roleNames: { owner: 'Владелец', salon_admin: 'Администратор', cosmetologist: 'Сотрудник' },
  };
  let saved = {
      revision: 0,
      publication: { enabled: true, canManage: true },
      mode: 'any',
      minimumLeadMinutes,
      reservationMinutes: 30,
      staff: { archived: { enabled: false, manageOwnRequests: false } },
      services: { s: ['staff', 'archived'] },
      canManage,
      canManageOwnRequests: true,
      members: [
        { accountId: 'owner', displayName: 'Owner', role: 'owner' },
        { accountId: 'staff', displayName: 'Staff <script>', role: 'cosmetologist' },
        { accountId: 'admin', displayName: 'Admin', role: 'salon_admin' },
      ],
      catalog: [{ id: 's', staffId: 'staff', name: 'Test service' }],
    },
    posts = [];
  const actions = {
    mountClientNotificationSettings() {},
    markSettingsSaved() {},
    confirmAction: async () => true,
    $: (s) => w.document.querySelector(s),
    esc: (v) =>
      String(v).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
      ),
    settingsSectionHtml: (title, id, body) =>
      `<details><summary>${title}</summary><div id="${id}">${body}</div></details>`,
    request: async (url, options) => {
      if (options) {
        const values = JSON.parse(options.body);
        posts.push(values);
        saved = { ...saved, ...values, revision: saved.revision + 1 };
        // Actual POST omits GET-only publication and catalog fields.
        const { publication, catalog, ...rules } = saved;
        return structuredClone(rules);
      }
      return structuredClone(saved);
    },
  };
  actions.mountBookingRequests = () => {};
  actions.mountBookingPublication = () => {};
  actions.renderBookingHealth = () => {};
  actions.refreshBookingHealth = async () => {};
  Object.assign(actions, w.eval('createSettingsHelp')(state, actions));
  const module = w.eval('createOnlineBookingSettings')(state, actions);
  w.document.querySelector('main').innerHTML = module.onlineBookingSettingsHtml();
  module.bindOnlineBookingSettingsEvents();
  return { w, state, module, posts, actions };
}
test('booking lead periods include quarter hours, all hours and days, preserving nonstandard values', async (t) => {
  for (const current of [60, 93, 0, 20160]) {
    const f = fixture(t, true, current);
    await f.module.loadOnlineBookingSettings();
    const select = f.actions.$('[name=minimumLeadMinutes]');
    assert.equal(Number(select.value), current);
    const values = [...select.options].map((option) => Number(option.value));
    for (const minute of [15, 30, 45, 60]) assert.ok(values.includes(minute));
    for (let hour = 2; hour <= 24; hour++) assert.ok(values.includes(hour * 60));
    for (let day = 2; day <= 7; day++) assert.ok(values.includes(day * 1440));
    assert.ok(values.includes(20160));
    assert.equal(select.querySelector('[value="20160"]').textContent, '14 дней');
    assert.equal(
      f.actions.$('label[for="booking-settings-lead"]').textContent,
      'За сколько до начала закрывать запись',
    );
    assert.equal(new Set(values).size, values.length);
    assert.ok(values.includes(current));
    select.value = '20160';
    select.form.dispatchEvent(new f.w.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => f.posts.length === 1);
    assert.equal(f.posts[0].minimumLeadMinutes, 20160);
  }
});
for (const width of [390, 1440])
  test('booking controls save rules without duplicate personal catalogs at ' + width, async (t) => {
    const f = fixture(t);
    Object.defineProperty(f.w, 'innerWidth', { value: width });
    await f.module.loadOnlineBookingSettings();
    const $ = f.actions.$;
    const sections = [...$('#online-booking-settings').children].map((el) => el.id);
    assert.ok(
      $('#online-booking-settings').firstElementChild.matches('[data-booking-health-panel]'),
    );
    assert.equal(sections[1], 'booking-publication');
    assert.equal($('#staff-notifications'), null);
    assert.equal($('#booking-requests-panel'), null);
    assert.equal($('[name=minimumLeadMinutes]').value, '60');
    assert.equal($('[name=reservationMinutes]').value, '30');
    assert.equal($('[name=showPrices]').checked, true);
    $('[name=showPrices]').checked = false;
    assert.equal($('[data-booking-permission]').checked, true);
    assert.equal($('#booking-service-assignments'), null);
    assert.equal(f.w.document.querySelectorAll('script').length, 0);
    $('[data-booking-enabled="staff"]').checked = false;
    $('[data-booking-enabled="staff"]').dispatchEvent(new f.w.Event('change', { bubbles: true }));
    assert.equal($('#booking-service-assignments'), null);
    assert.equal($('[data-booking-service]'), null);
    assert.ok($('.online-booking-members').textContent.includes('Staff <script>'));
    assert.equal($('#booking-settings-mode').type, 'hidden');
    assert.equal($('[data-booking-time-mode="any"]').getAttribute('aria-pressed'), 'true');
    assert.equal($('[data-booking-time-mode="sequential"]').getAttribute('aria-pressed'), 'false');
    $('[data-booking-time-mode="sequential"]').click();
    assert.equal($('[name=mode]').value, 'sequential');
    assert.equal($('[data-booking-time-mode="any"]').getAttribute('aria-pressed'), 'false');
    assert.equal($('[data-booking-time-mode="sequential"]').getAttribute('aria-pressed'), 'true');
    assert.equal($('[name=bookingMode]').value, 'approval');
    assert.equal(f.posts.length, 0);
    f.state.busy = true;
    $('[data-booking-time-mode="any"]').click();
    assert.equal($('[name=mode]').value, 'sequential');
    f.state.busy = false;
    $('[data-booking-time-mode="any"]').click();
    assert.equal($('[name=mode]').value, 'any');
    $('[data-booking-time-mode="sequential"]').click();
    $('[name=reservationMinutes]').value = '45';
    $('[data-booking-permission]').checked = false;
    const form = $('#online-booking-settings-form');
    const permissions = form.querySelector('details');
    permissions.open = true;
    const selectAll = form.querySelectorAll.bind(form);
    let memberQueries = 0;
    form.querySelectorAll = (selector) => {
      if (['[data-booking-enabled]', '[data-booking-permission]'].includes(selector))
        memberQueries++;
      return selectAll(selector);
    };
    $('#online-booking-settings-form').dispatchEvent(
      new f.w.Event('submit', { bubbles: true, cancelable: true }),
    );
    await until(() => !f.state.busy && f.posts.length === 1);
    assert.equal(f.posts[0].mode, 'sequential');
    assert.equal($('[data-booking-time-mode="sequential"]').getAttribute('aria-pressed'), 'true');
    assert.equal(f.posts[0].reservationMinutes, 45);
    assert.equal(f.posts[0].staff.staff.manageOwnRequests, false);
    assert.equal(memberQueries, 2);
    assert.equal(f.posts[0].staff.owner.enabled, true);
    assert.equal(f.posts[0].staff.archived.enabled, false);
    assert.deepEqual(f.posts[0].services, { s: ['staff', 'archived'] });
    assert.equal(f.posts[0].showPrices, false);
    assert.equal($('[name=showPrices]').checked, false);
    assert.equal($('#booking-settings-result').textContent, 'Правила сохранены');
    assert.equal($('#online-booking-settings-form'), form);
    assert.equal(form.hidden, false);
    assert.equal(permissions.isConnected, true);
    assert.equal(permissions.open, true);
    const savedButton = $('#online-booking-settings-form button[type="submit"]');
    assert.equal(savedButton.textContent, 'Сохранено');
    assert.equal(savedButton.dataset.saveState, 'saved');
    assert.equal(savedButton.disabled, true);
    $('[data-booking-time-mode="any"]').click();
    assert.equal(savedButton.textContent, 'Сохранить правила');
    assert.equal(savedButton.dataset.saveState, undefined);
    assert.equal(savedButton.disabled, false);
    assert.equal($('#booking-settings-result').textContent, '');
    assert.equal(f.posts[0].staff.archived.manageOwnRequests, false);
    assert.ok(f.posts[0].services.s.includes('archived'));
    f.state.account.organizationId = 'other';
    $('#online-booking-settings-form').dispatchEvent(
      new f.w.Event('submit', { bubbles: true, cancelable: true }),
    );
    await delay(20);
    assert.equal(f.posts.length, 1);
  });
test('ordinary staff has no settings form and stale account response cannot replace another organization', async (t) => {
  const f = fixture(t, false);
  await f.module.loadOnlineBookingSettings();
  assert.equal(f.actions.$('form'), null);
  let resolve;
  f.actions.request = () => new Promise((r) => (resolve = r));
  const loading = f.module.loadOnlineBookingSettings();
  f.state.account.organizationId = 'other';
  resolve({ canManage: true, members: [], catalog: [] });
  await loading;
  assert.equal(f.actions.$('form'), null);
});
test('save feedback allows retry after failure and preserves edits made during delivery', async (t) => {
  const f = fixture(t);
  await f.module.loadOnlineBookingSettings();
  const $ = f.actions.$;
  const form = $('#online-booking-settings-form');
  const button = form.querySelector('button[type="submit"]');
  const originalRequest = f.actions.request;
  f.actions.request = async () => {
    throw new Error('Синтетический отказ');
  };
  form.dispatchEvent(new f.w.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(button.textContent, 'Сохраняем…');
  assert.equal(button.disabled, true);
  await until(() => !f.state.busy);
  assert.equal(button.textContent, 'Сохранить правила');
  assert.equal(button.disabled, false);
  assert.equal(button.dataset.saveState, undefined);
  assert.equal($('#booking-settings-result').textContent, 'Синтетический отказ');
  let deliver;
  f.actions.request = (url, options) =>
    options
      ? new Promise((resolve) => {
          deliver = async () => resolve(await originalRequest(url, options));
        })
      : originalRequest(url);
  form.dispatchEvent(new f.w.Event('submit', { bubbles: true, cancelable: true }));
  $('[name=reservationMinutes]').value = '75';
  $('[name=reservationMinutes]').dispatchEvent(new f.w.Event('input', { bubbles: true }));
  await deliver();
  await until(() => !f.state.busy);
  assert.equal($('#online-booking-settings-form'), form);
  assert.equal($('[name=reservationMinutes]').value, '75');
  assert.equal(f.posts[0].reservationMinutes, 30);
  assert.equal(button.textContent, 'Сохранить правила');
  assert.equal(button.disabled, false);
  assert.match($('#booking-settings-result').textContent, /Новые изменения ещё не сохранены/);
  f.actions.request = originalRequest;
  form.dispatchEvent(new f.w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !f.state.busy && f.posts.length === 2);
  assert.equal(f.posts[1].revision, 1);
  assert.equal(f.posts[1].reservationMinutes, 75);
  assert.equal($('#online-booking-settings-form button[type="submit"]').textContent, 'Сохранено');
});

test('classic selector preserves time selection rules and hidden reservation when switching back', async (t) => {
  const f = fixture(t);
  let confirmations = 0;
  f.actions.confirmAction = async () => {
    confirmations++;
    return false;
  };
  await f.module.loadOnlineBookingSettings();
  const $ = f.actions.$;
  assert.equal($('[name=bookingMode]').value, 'approval');
  $('[name=reservationMinutes]').value = '45';
  $('[name=bookingMode]').value = 'classic';
  $('[name=bookingMode]').dispatchEvent(new f.w.Event('change', { bubbles: true }));
  assert.equal($('[data-booking-reservation-field]').hidden, true);
  $('#online-booking-settings-form').dispatchEvent(
    new f.w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await until(() => !f.state.busy && f.posts.length === 1);
  assert.equal(f.posts[0].bookingMode, 'classic');
  assert.equal(confirmations, 0);
  assert.equal(f.posts[0].mode, 'any');
  assert.equal(f.posts[0].reservationMinutes, 45);
  assert.equal($('[name=bookingMode]').value, 'classic');
  $('[name=bookingMode]').value = 'approval';
  $('[name=bookingMode]').dispatchEvent(new f.w.Event('change', { bubbles: true }));
  assert.equal($('[data-booking-reservation-field]').hidden, false);
  assert.equal($('[name=reservationMinutes]').value, '45');
});
