const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { JSDOM } = require('jsdom');
const read = (file) => fs.readFileSync(path.join(__dirname, '../src/client', file), 'utf8');
const until = async (condition) => {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await delay(10);
  }
  throw Error('UI timeout');
};
function pageFixture(t, url) {
  const w = new JSDOM('<main id="public-booking"></main>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url,
  }).window;
  t.after(() => w.close());
  for (const file of ['phone', 'flow', 'receipt', 'view', 'page'])
    w.eval(read('public/' + file + '.js'));
  const info = {
    organization: { organizationId: 'synthetic-org', name: 'Synthetic', timeZone: 'UTC' },
    selectedStaffId: 'staff-a',
    services: [{ id: 'service', name: 'Service', duration: 30, staffIds: ['staff-a', 'staff-b'] }],
    members: [
      { id: 'staff-a', name: 'First' },
      { id: 'staff-b', name: 'Second' },
    ],
    challenge: 'synthetic-key',
    reservationMinutes: 30,
  };
  const calls = [];
  const request = async (value, options) => {
    calls.push({ url: value, options });
    const url = new URL(value, w.location.origin);
    if (url.pathname.endsWith('/info')) return info;
    if (url.pathname.endsWith('/dates')) return { dates: ['2030-01-01'] };
    if (url.pathname.endsWith('/availability')) return { slots: [], requestedTimes: [] };
    throw Error('Unexpected synthetic request');
  };
  const $ = (selector) => w.document.querySelector(selector);
  const change = (element) => element.dispatchEvent(new w.Event('change', { bubbles: true }));
  const page = w.eval('createPublicBookingPage')(
    $('main'),
    w.eval('createPublicBookingView'),
    request,
  );
  return { w, $, change, page, calls, info };
}
test('short link resolves organization and staff from server, ignoring target query overrides', async (t) => {
  const f = pageFixture(t, 'https://booking.example/b/a1b2c3d4?organization=wrong&staff=staff-b');
  await f.page.initialize();
  assert.equal(f.calls[0].url, '/api/public-booking/info?link=a1b2c3d4');
  f.$('#booking-month').value = '2030-01';
  f.$('[data-booking-service]').checked = true;
  f.change(f.$('[data-booking-service]'));
  await until(() => f.$('[data-booking-date]'));
  assert.equal(f.$('#booking-staff').value, 'staff-a');
  const dates = new URL(f.calls[1].url, f.w.location.origin);
  assert.equal(dates.searchParams.get('organization'), 'synthetic-org');
  assert.equal(dates.searchParams.get('staffId'), 'staff-a');
  assert.equal(dates.searchParams.has('link'), false);
  assert.equal(
    f.$('.booking-legal a').getAttribute('href'),
    '/consent.html?organization=synthetic-org#booking',
  );
  assert.equal(f.$('.booking-legal a:last-child').getAttribute('href'), '/privacy.html');
  f.$('[data-booking-date]').click();
  await until(() => f.calls.length === 3);
  assert.equal(
    new URL(f.calls[2].url, f.w.location.origin).searchParams.get('organization'),
    'synthetic-org',
  );
  assert.equal(JSON.parse(f.calls[2].options.body).staffId, 'staff-a');
  f.$('#booking-staff').value = 'staff-b';
  f.change(f.$('#booking-staff'));
  await until(() => f.calls.length === 4);
  assert.equal(new URL(f.calls[3].url, f.w.location.origin).searchParams.get('staffId'), 'staff-b');
});
test('organization short link has no staff hint from a query and missing resolution fails closed', async (t) => {
  const f = pageFixture(t, 'https://booking.example/b/a1b2c3d4?organization=wrong&staff=staff-b');
  delete f.info.selectedStaffId;
  await f.page.initialize();
  f.$('[data-booking-service]').checked = true;
  f.change(f.$('[data-booking-service]'));
  assert.equal(f.$('#booking-staff').value, '');
  assert.equal(f.calls.length, 1);
  delete f.info.organization.organizationId;
  await f.page.initialize();
  assert.equal(f.calls[1].url, '/api/public-booking/info?link=a1b2c3d4');
  assert.equal(f.$('#booking-flow'), null);
  assert.match(f.$('main').textContent, /Не удалось загрузить онлайн-запись/);
});
test('legacy organization and staff links still work', async (t) => {
  const f = pageFixture(
    t,
    'https://booking.example/booking.html?organization=legacy-org&staff=staff-b',
  );
  await f.page.initialize();
  assert.equal(f.calls[0].url, '/api/public-booking/info?organization=legacy-org');
  f.$('#booking-month').value = '2030-01';
  f.$('[data-booking-service]').checked = true;
  f.change(f.$('[data-booking-service]'));
  await until(() => f.$('[data-booking-date]'));
  assert.equal(f.$('#booking-staff').value, 'staff-b');
  assert.equal(
    new URL(f.calls[1].url, f.w.location.origin).searchParams.get('organization'),
    'legacy-org',
  );
});
test('booking assets are root absolute for nested short routes', (t) => {
  const w = new JSDOM(read('public/booking.html'), { url: 'https://booking.example/b/a1b2c3d4' })
    .window;
  t.after(() => w.close());
  assert.deepEqual(
    [...w.document.querySelectorAll('link,script')].map((node) => node.href || node.src),
    [
      'https://booking.example/style.css',
      'https://booking.example/booking.css',
      'https://booking.example/booking.js',
    ],
  );
});
test('short route preserves reply fragment handling without sending it in the request URL', async (t) => {
  const w = new JSDOM('<main></main>', {
    runScripts: 'outside-only',
    url: 'https://booking.example/b/a1b2c3d4#reply=synthetic-secret',
  }).window;
  t.after(() => w.close());
  w.eval(read('public/reply.js'));
  const calls = [];
  const page = w.eval('createBookingReplyPage')(
    w.document.querySelector('main'),
    async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return {
        organization: { name: 'Synthetic' },
        date: '2030-01-01',
        time: '10:00',
        duration: 30,
        services: [],
        state: 'waiting',
      };
    },
  );
  await page.initialize();
  assert.deepEqual(calls, [
    { url: '/api/public-booking/proposal', body: { secret: 'synthetic-secret' } },
  ]);
  assert.equal(w.location.hash, '#reply=synthetic-secret');
});
test('close skips short booking entries together with legacy entries without redirecting to referrer', (t) => {
  const w = new JSDOM('<main></main>', { runScripts: 'outside-only' }).window;
  t.after(() => w.close());
  w.eval(read('public/flow.js'));
  const offset = w.eval('publicBookingReturnOffset');
  const browser = {
    history: { length: 4 },
    document: { referrer: 'https://booking.example/b/a1b2c3d4?organization=ignored' },
    navigation: {
      currentEntry: { index: 3 },
      entries: () => [
        { index: 0, url: 'https://source.example/service' },
        { index: 1, url: 'https://booking.example/b/a1b2c3d4' },
        { index: 2, url: 'https://booking.example/booking.html?organization=legacy' },
        { index: 3, url: 'https://booking.example/b/e5f6g7h8' },
      ],
    },
  };
  assert.equal(offset(browser), -3);
  browser.navigation = undefined;
  assert.equal(offset(browser), 0);
  browser.document.referrer = 'https://source.example/service';
  assert.equal(offset(browser), -1);
});
test('publication uses short staff links for copy, share and open and refreshes paths without a new revision', async (t) => {
  const w = new JSDOM('<div id="booking-publication"></div>', {
    runScripts: 'outside-only',
    url: 'https://booking.example/',
  }).window;
  t.after(() => w.close());
  w.eval(read('modules/booking-publication.js'));
  const $ = (selector) => w.document.querySelector(selector);
  const copied = [],
    shared = [],
    opened = [],
    calls = [];
  Object.defineProperty(w.navigator, 'clipboard', {
    value: { writeText: async (value) => copied.push(value) },
  });
  w.navigator.share = async (value) => shared.push(value.url);
  w.open = (value) => opened.push(value);
  const actions = {
    $,
    esc: String,
    settingsHelpHtml: () => '',
    request: async (url) => {
      calls.push(url);
      return { dataUrl: 'data:image/png;base64,c3ludGhldGlj' };
    },
  };
  const api = w.eval('createBookingPublication')(
    { account: { id: 'owner', organizationId: 'synthetic-org' }, currentView: 'settings' },
    actions,
  );
  const publication = {
    enabled: true,
    revision: 1,
    path: '/b/a1b2c3d4',
    staffPaths: { owner: '/b/m3n4o5p6', 'staff-a': '/b/e5f6g7h8' },
    canManage: true,
  };
  api.mountBookingPublication({
    publication,
    members: [
      { accountId: 'owner', role: 'owner', displayName: 'Owner' },
      { accountId: 'staff-a', role: 'staff', displayName: 'Staff' },
      { accountId: 'admin', role: 'salon_admin', displayName: 'Admin' },
    ],
    staff: { admin: { enabled: true } },
  });
  assert.equal($('[data-booking-link-staff] option[value="admin"]'), null);
  assert.equal($('[data-booking-public-link]').value, 'https://booking.example/b/a1b2c3d4');
  $('[data-booking-link-staff]').value = 'staff-a';
  $('[data-booking-link-staff]').dispatchEvent(new w.Event('change', { bubbles: true }));
  const expected = 'https://booking.example/b/e5f6g7h8';
  assert.equal($('[data-booking-public-link]').value, expected);
  for (const action of ['copy', 'share', 'open', 'qr'])
    $(`[data-booking-link-action="${action}"]`).click();
  await until(() => !$('[data-booking-public-qr]').hidden);
  assert.deepEqual(copied, [expected]);
  assert.deepEqual(shared, [expected]);
  assert.deepEqual(opened, [expected]);
  assert.deepEqual(calls, ['/api/online-booking/qr?staff=staff-a']);
  api.syncBookingPublication({
    ...publication,
    staffPaths: { ...publication.staffPaths, 'staff-a': '/b/i9j0k1l2' },
  });
  assert.equal($('[data-booking-link-staff]').value, 'staff-a');
  assert.equal($('[data-booking-public-link]').value, 'https://booking.example/b/i9j0k1l2');
  assert.equal($('[data-booking-public-qr]').hidden, true);
  api.syncBookingPublication({
    ...publication,
    path: '/booking.html?organization=synthetic-org',
    staffPaths: undefined,
  });
  assert.equal(
    $('[data-booking-public-link]').value,
    'https://booking.example/booking.html?organization=synthetic-org&staff=staff-a',
  );
});
