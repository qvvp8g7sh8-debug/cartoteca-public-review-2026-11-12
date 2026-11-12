const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(
  path.join(__dirname, '../src/client/modules/online-booking-settings.js'),
  'utf8',
);

async function fixture(t, patch = {}) {
  const w = new JSDOM('<main></main>', { runScripts: 'outside-only', url: 'http://localhost/' })
    .window;
  t.after(() => w.close());
  w.eval(source);
  const state = {
    account: { id: 'owner', organizationId: 'organization' },
    multiUser: true,
    currentView: 'settings',
    busy: false,
    roleNames: { owner: 'Владелец', cosmetologist: 'Сотрудник' },
  };
  let snapshot = {
    revision: 7,
    publication: { enabled: true, canManage: true },
    mode: 'any',
    bookingMode: 'approval',
    minimumLeadMinutes: 60,
    reservationMinutes: 30,
    showPrices: true,
    canManage: true,
    canManageOwnRequests: true,
    members: [
      { accountId: 'owner', displayName: 'Owner', role: 'owner' },
      { accountId: 'first', displayName: 'First <script>', role: 'cosmetologist' },
      { accountId: 'second', displayName: 'Second', role: 'cosmetologist' },
      { accountId: 'admin', displayName: 'Admin', role: 'salon_admin' },
    ],
    staff: {
      owner: { enabled: true, manageOwnRequests: false },
      first: { enabled: true, manageOwnRequests: false, mode: 'sequential' },
      second: { enabled: true, manageOwnRequests: true, bookingMode: 'classic' },
      admin: { enabled: false, manageOwnRequests: false, mode: 'sequential' },
      archived: { enabled: false, manageOwnRequests: false, bookingMode: 'classic' },
    },
    services: { service: ['first', 'archived'] },
    catalog: [{ id: 'service', staffId: 'first', name: 'Consultation' }],
    ...patch,
  };
  const posts = [];
  const calls = [];
  const actions = {
    $: (selector) => w.document.querySelector(selector),
    esc: (value) =>
      String(value).replace(
        /[&<>"']/g,
        (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
      ),
    settingsSectionHtml: (title, id, body) => `<section id="${id}">${body}</section>`,
    settingsHelpHtml: () => '',
    markSettingsSaved() {},
    mountBookingPublication() {},
    renderBookingHealth() {},
    refreshBookingHealth: async () => {},
    request: async (url, options) => {
      calls.push({ url, method: options?.method || 'GET' });
      if (!options) return structuredClone(snapshot);
      const values = JSON.parse(options.body);
      posts.push(values);
      snapshot = { ...snapshot, ...values, revision: snapshot.revision + 1 };
      const { publication, catalog, members, ...rules } = snapshot;
      return structuredClone(rules);
    },
  };
  const module = w.eval('createOnlineBookingSettings')(state, actions);
  w.document.querySelector('main').innerHTML = module.onlineBookingSettingsHtml();
  module.bindOnlineBookingSettingsEvents();
  await module.loadOnlineBookingSettings();
  const change = (selector, value) => {
    const element = actions.$(selector);
    if (typeof value === 'boolean') element.checked = value;
    else element.value = value;
    element.dispatchEvent(new w.Event('change', { bubbles: true }));
  };
  const submit = async () => {
    actions.$('form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
  };
  return { w, state, actions, calls, posts, change, submit };
}

test('staff settings show independent effective rules and explicit inheritance without another request', async (t) => {
  const f = await fixture(t);
  const $ = f.actions.$;
  assert.equal($('[data-booking-staff-mode="first"]').value, 'sequential');
  assert.equal($('[data-booking-staff-kind="first"]').value, 'inherit');
  assert.equal($('[data-booking-staff-mode="second"]').value, 'inherit');
  assert.equal($('[data-booking-staff-kind="second"]').value, 'classic');
  const first = $('[data-booking-member="first"]');
  assert.equal(
    first.querySelector('[data-booking-effective="mode"]').textContent,
    'Последовательно',
  );
  assert.equal(
    first.querySelector('[data-booking-effective="bookingMode"]').textContent,
    'С согласованием (общие правила)',
  );
  assert.match($('[data-booking-inheritance]').textContent, /выбор времени — 2; оформление — 2/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.w.document.querySelector('script'), null);
  assert.match(first.textContent, /First <script>/);
});

test('draft organization defaults update inherited options and summaries while retaining overrides and details', async (t) => {
  const f = await fixture(t);
  const $ = f.actions.$;
  const first = $('[data-booking-member="first"]');
  const details = first.querySelector('details');
  details.open = true;
  $('[data-booking-time-mode="sequential"]').click();
  $('[data-booking-kind="classic"]').click();
  assert.equal($('[data-booking-staff-mode="first"]').value, 'sequential');
  assert.equal($('[data-booking-staff-kind="second"]').value, 'classic');
  assert.equal(
    $('[data-booking-staff-mode="second"] [value="inherit"]').textContent,
    'Как в организации — Последовательно',
  );
  assert.equal(
    first.querySelector('[data-booking-effective="bookingMode"]').textContent,
    'Сразу в календарь (общие правила)',
  );
  assert.equal(details.open, true);
  assert.equal(details.isConnected, true);
  assert.equal(f.posts.length, 0);
  assert.equal(f.calls.length, 1);
});

test('staff override changes do not affect another staff or the other rule and preserve all snapshots on save', async (t) => {
  const f = await fixture(t);
  const $ = f.actions.$;
  f.change('[data-booking-staff-kind="first"]', 'classic');
  f.change('[data-booking-staff-mode="second"]', 'sequential');
  await f.submit();
  assert.equal(f.posts.length, 1);
  const saved = f.posts[0];
  assert.equal(saved.mode, 'any');
  assert.equal(saved.bookingMode, 'approval');
  assert.equal(saved.staff.owner.manageOwnRequests, false);
  assert.deepEqual(saved.staff.first, {
    enabled: true,
    manageOwnRequests: false,
    mode: 'sequential',
    bookingMode: 'classic',
  });
  assert.deepEqual(saved.staff.second, {
    enabled: true,
    manageOwnRequests: true,
    mode: 'sequential',
    bookingMode: 'classic',
  });
  assert.deepEqual(saved.staff.admin, {
    enabled: false,
    manageOwnRequests: false,
    mode: 'sequential',
  });
  assert.deepEqual(saved.staff.archived, {
    enabled: false,
    manageOwnRequests: false,
    bookingMode: 'classic',
  });
  assert.deepEqual(saved.services, { service: ['first', 'archived'] });
  assert.equal(saved.minimumLeadMinutes, 60);
  assert.equal(saved.reservationMinutes, 30);
  assert.equal($('[data-booking-staff-kind="first"]').value, 'classic');
});

test('an enabled approval override keeps the shared reservation visible under a classic default', async (t) => {
  const f = await fixture(t, { bookingMode: 'classic' });
  const $ = f.actions.$;
  assert.equal($('[data-booking-reservation-field]').hidden, true);
  f.change('[data-booking-staff-kind="first"]', 'approval');
  assert.equal($('[data-booking-reservation-field]').hidden, false);
  f.change('[data-booking-enabled="first"]', false);
  assert.equal($('[data-booking-reservation-field]').hidden, true);
  assert.equal($('[data-booking-staff-kind="first"]').value, 'approval');
  f.change('[data-booking-enabled="first"]', true);
  assert.equal($('[data-booking-reservation-field]').hidden, false);
  assert.equal($('[name="reservationMinutes"]').value, '30');
});

test('returning one rule to inheritance follows later draft defaults without clearing the second override', async (t) => {
  const f = await fixture(t);
  const $ = f.actions.$;
  f.change('[data-booking-staff-mode="first"]', 'inherit');
  f.change('[data-booking-staff-kind="first"]', 'classic');
  assert.match($('[data-booking-inheritance]').textContent, /выбор времени — 3; оформление — 1/);
  $('[data-booking-time-mode="sequential"]').click();
  assert.equal($('[data-booking-staff-mode="first"]').value, 'inherit');
  assert.equal($('[data-booking-staff-kind="first"]').value, 'classic');
  await f.submit();
  assert.equal(f.posts[0].staff.first.mode, 'inherit');
  assert.equal(f.posts[0].staff.first.bookingMode, 'classic');
});

test('ordinary employee stays read-only and a stale organization form cannot save rule changes', async (t) => {
  const readonly = await fixture(t, { canManage: false });
  assert.equal(readonly.actions.$('form'), null);
  assert.equal(readonly.actions.$('[data-booking-staff-mode]'), null);
  const f = await fixture(t);
  f.state.account.organizationId = 'another-organization';
  f.change('[data-booking-staff-kind="first"]', 'classic');
  await f.submit();
  assert.equal(f.posts.length, 0);
});
