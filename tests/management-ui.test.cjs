const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function fixture(t, wide = false) {
  const w = new JSDOM('<main id="global-view"></main>', { runScripts: 'outside-only' }).window;
  t.after(() => w.close());
  const layout = { matches: wide };
  let layoutChanged;
  w.matchMedia = () => ({
    get matches() {
      return layout.matches;
    },
    addEventListener(event, listener) {
      if (event === 'change') layoutChanged = listener;
    },
  });
  w.eval(fs.readFileSync(path.join(__dirname, '../src/client/modules/management.js'), 'utf8'));
  const state = {
    currentView: 'services',
    multiUser: true,
    busy: false,
    account: { id: 'a', organizationId: 'o' },
  };
  const counts = { schedules: 0, requests: 0 };
  const $ = (selector) => w.document.querySelector(selector);
  const actions = {
    $,
    configureServiceView() {},
    renderBookingInbox() {},
    servicesHtml: () => '<section class="services-panel"><input id="service-search"></section>',
    workScheduleSettingsHtml: () => '<section id="work-schedules-settings"></section>',
    bookingRequestsPanelHtml: () =>
      '<section id="booking-requests-panel"><button data-open-booking-settings>Настройки записи</button></section>',
    loadWorkSchedules() {
      counts.schedules++;
    },
    mountBookingRequests() {
      counts.requests++;
    },
    async setView(view) {
      state.currentView = view;
      $('#global-view').innerHTML =
        view === 'services'
          ? api.managementHtml()
          : '<details><summary>Онлайн-запись</summary><div id="online-booking-settings"><button data-management-tab="requests">Открыть заявки</button></div></details>';
      if (view === 'services') api.mountManagement();
    },
  };
  const api = w.eval('createManagement')(state, actions);
  $('#global-view').innerHTML = api.managementHtml();
  api.bindManagementEvents();
  return { w, state, counts, $, api, actions, layout, updateLayout: () => layoutChanged() };
}

test('management mounts only the selected operation and resets navigation for another organization', async (t) => {
  const f = fixture(t);
  f.api.mountManagement();
  assert.deepEqual(f.counts, { schedules: 0, requests: 0 });
  await f.api.openManagement('schedule');
  assert.ok(f.$('#work-schedules-settings'));
  assert.equal(f.$('#booking-requests-panel'), null);
  assert.deepEqual(f.counts, { schedules: 1, requests: 0 });
  await f.api.openManagement('requests');
  assert.ok(f.$('#booking-requests-panel'));
  assert.equal(f.$('#work-schedules-settings'), null);
  assert.deepEqual(f.counts, { schedules: 1, requests: 1 });
  f.state.account.organizationId = 'another';
  await f.actions.setView('services');
  assert.ok(f.$('#service-search'));
  assert.equal(f.$('[data-management-tab="services"]').getAttribute('aria-selected'), 'true');
});

test('settings shortcut returns to requests even when it was already the remembered tab', async (t) => {
  const f = fixture(t);
  await f.api.openManagement('requests');
  f.$('[data-open-booking-settings]').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.state.currentView, 'settings');
  assert.equal(f.$('details').open, true);
  f.$('[data-management-tab="requests"]').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.state.currentView, 'services');
  assert.ok(f.$('#booking-requests-panel'));
});

test('saving blocks management navigation and legacy mode never mounts multiuser operations', async (t) => {
  const f = fixture(t);
  f.state.busy = true;
  await f.api.openManagement('schedule');
  assert.ok(f.$('#service-search'));
  assert.equal(f.counts.schedules, 0);
  f.state.busy = false;
  f.state.multiUser = false;
  await f.actions.setView('services');
  await f.api.openManagement('requests');
  assert.equal(f.w.document.querySelectorAll('[role="tab"]').length, 1);
  assert.equal(f.counts.requests, 0);
});

test('desktop navigation stays horizontal and preserves arrow-key navigation on resize', async (t) => {
  const f = fixture(t, true);
  assert.equal(f.$('.management-tabs').getAttribute('aria-orientation'), 'horizontal');
  assert.equal(f.$('#management-tab-services .management-tab-copy > span').textContent, 'Услуги');
  f.$('#management-tab-services').dispatchEvent(
    new f.w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.$('#management-tab-schedule').getAttribute('aria-selected'), 'true');
  assert.equal(
    f.$('#management-tab-schedule .management-tab-copy > span').textContent,
    'Рабочее время',
  );
  f.layout.matches = false;
  f.updateLayout();
  assert.equal(f.$('.management-tabs').getAttribute('aria-orientation'), 'horizontal');
});
