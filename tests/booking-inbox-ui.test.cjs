const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { setTimeout: delay } = require('node:timers/promises');
const source = (name) =>
  fs.readFileSync(path.join(__dirname, '../src/client/modules', name + '.js'), 'utf8');
const until = async (fn) => {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await delay(5);
  }
  throw Error('UI timeout');
};
const record = (id, extra = {}) => ({
  id,
  revision: 0,
  status: 'pending',
  kind: 'reserve',
  createdAt: 100,
  firstName: 'Synthetic',
  phone: '+79990000000',
  date: '2030-01-01',
  time: '09:00',
  duration: 30,
  staffId: 'a',
  services: [{ name: 'Synthetic service' }],
  ...extra,
});
const settings = { revision: 0, canManage: true, members: [] };
function fixture(t) {
  const w = new JSDOM(
    '<button data-view="services"><span data-booking-request-count hidden></span></button><main></main>',
    { runScripts: 'outside-only', pretendToBeVisual: true },
  ).window;
  t.after(() => w.close());
  w.scrollBy = () => {};
  [
    'booking-inbox',
    'booking-request-list',
    'booking-request-view',
    'booking-time',
    'booking-requests',
  ].forEach((name) => w.eval(source(name)));
  const state = {
    account: { id: 'a', organizationId: 'o' },
    currentView: 'services',
    multiUser: true,
    busy: false,
  };
  let rows = [record('r')],
    version = 'v1',
    calls = [],
    offline = false;
  const actions = {
    $: (s) => w.document.querySelector(s),
    esc: (v) =>
      String(v).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
      ),
    formatDate: (v) => v,
    formatMinutes: (v) => v + ' мин',
    invalidateCalendarRead() {},
    invalidateDirectory() {},
    request: async (url, options) => {
      calls.push(url);
      if (offline) throw Error('Synthetic offline');
      if (url.endsWith('/summary'))
        return { count: rows.length, version, checkedAt: Date.now(), settingsRevision: 0 };
      if (url.endsWith('/settings')) return settings;
      if (url.includes('/contacts')) return { items: [], needsAdministrator: false };
      if (url.endsWith('/time-options')) return { times: ['10:00', '11:00'] };
      if (options) throw Error('Unexpected mutation');
      return { items: rows, cursor: null, version, settingsRevision: 0 };
    },
  };
  actions.readBackground = (url) => actions.request(url);
  for (const name of [
    'BookingInbox',
    'BookingRequestList',
    'BookingRequestView',
    'BookingTime',
    'BookingRequests',
  ])
    Object.assign(actions, w.eval('create' + name)(state, actions));
  w.document.querySelector('main').innerHTML = actions.bookingRequestsPanelHtml();
  actions.mountBookingRequests(settings);
  return {
    w,
    state,
    actions,
    calls,
    setRows(next) {
      rows = next;
      version += 'x';
    },
    offline(value) {
      offline = value;
    },
  };
}

test('auto refresh preserves the editor, chosen time and existing row while inserting new requests', async (t) => {
  const f = fixture(t);
  await until(() => f.actions.$('[data-booking-request-action=choose]'));
  f.actions.$('[data-booking-request-action=choose]').click();
  await until(() => f.actions.$('[data-request-time="10:00"]'));
  f.actions.$('[data-request-time="10:00"]').click();
  const editor = f.actions.$('.booking-time-editor'),
    date = f.actions.$('[data-request-date]');
  f.setRows([record('new', { createdAt: 200 }), record('r')]);
  await f.actions.refreshBookingInbox({ force: true });
  assert.equal(f.actions.$('.booking-time-editor'), editor);
  assert.equal(f.actions.$('[data-request-date]'), date);
  assert.equal(f.actions.$('[data-request-time="10:00"]').getAttribute('aria-pressed'), 'true');
  assert.equal(f.actions.$('[data-request-time-save]').disabled, false);
  assert.equal(f.w.document.querySelectorAll('[data-booking-request-row]').length, 2);
  assert.equal(f.actions.$('[data-booking-request-count]').textContent, '2');
});

test('a remotely processed request preserves the draft, blocks new acceptance and disappears on close', async (t) => {
  const f = fixture(t);
  await until(() => f.actions.$('[data-booking-request-action=choose]'));
  f.actions.$('[data-booking-request-action=choose]').click();
  await until(() => f.actions.$('[data-request-time="10:00"]'));
  f.actions.$('[data-request-time="10:00"]').click();
  const editor = f.actions.$('.booking-time-editor');
  f.setRows([]);
  await f.actions.refreshBookingInbox({ force: true });
  assert.equal(f.actions.$('.booking-time-editor'), editor);
  assert.match(f.actions.$('[data-booking-request-warning]').textContent, /обработана/);
  assert.equal(f.actions.$('[data-request-time-save]').disabled, true);
  assert.equal(f.actions.$('[data-booking-request-count]').hidden, true);
  f.actions.$('[data-request-time-close]').click();
  assert.equal(f.actions.$('.booking-request'), null);
});

test('reserve expiry warns without resetting date/time or changing acceptance rules', async (t) => {
  const f = fixture(t);
  await until(() => f.actions.$('[data-booking-request-action=choose]'));
  f.actions.$('[data-booking-request-action=choose]').click();
  await until(() => f.actions.$('[data-request-time="10:00"]'));
  f.actions.$('[data-request-time="10:00"]').click();
  f.setRows([record('r', { status: 'expired' })]);
  await f.actions.refreshBookingInbox({ force: true });
  assert.match(f.actions.$('[data-booking-reserve-expired]').textContent, /проверено заново/);
  assert.equal(f.actions.$('[data-request-time="10:00"]').getAttribute('aria-pressed'), 'true');
  assert.equal(f.actions.$('[data-request-time-save]').disabled, false);
});

test('offline leaves rows visible, backs off, stops hidden polling and reads only summary elsewhere', async (t) => {
  const f = fixture(t);
  await until(() => f.actions.$('.booking-request'));
  await f.actions.refreshBookingInbox({ force: true });
  f.offline(true);
  await f.actions.refreshBookingInbox({ force: true });
  assert.ok(f.actions.$('.booking-request'));
  assert.equal(f.actions.bookingInboxInterval(), 30000);
  assert.match(f.actions.$('[data-booking-request-sync]').textContent, /Не удалось обновить/);
  await f.actions.refreshBookingInbox({ force: true });
  assert.equal(f.actions.bookingInboxInterval(), 60000);
  Object.defineProperty(f.w.document, 'hidden', { value: true, configurable: true });
  const total = f.calls.length;
  await f.actions.refreshBookingInbox({ force: true });
  assert.equal(f.calls.length, total);
  Object.defineProperty(f.w.document, 'hidden', { value: false, configurable: true });
  f.offline(false);
  f.state.currentView = 'calendar';
  f.setRows([record('new')]);
  const before = f.calls.length;
  await f.actions.refreshBookingInbox({ force: true });
  assert.deepEqual(f.calls.slice(before), ['/api/online-booking/requests/summary']);
  assert.equal(f.actions.bookingInboxInterval(), 30000);
});

test('pending summaries are joined and stale responses cannot replace another organization badge', async (t) => {
  const f = fixture(t);
  await until(() => f.actions.$('.booking-request'));
  await f.actions.refreshBookingInbox({ force: true });
  let resolve;
  f.actions.readBackground = () => new Promise((r) => (resolve = r));
  const first = f.actions.refreshBookingInbox({ force: true }),
    second = f.actions.refreshBookingInbox({ force: true });
  assert.equal(first, second);
  await Promise.resolve();
  f.state.account = { id: 'other', organizationId: 'other' };
  f.actions.renderBookingInbox();
  resolve({ count: 99, version: 'old', checkedAt: Date.now(), settingsRevision: 0 });
  await first;
  assert.equal(f.actions.$('[data-booking-request-count]').hidden, true);
});

test('refresh reads through the oldest loaded anchor and keeps an interrupted page load atomic', async (t) => {
  const f = fixture(t);
  await until(() => f.actions.$('.booking-request'));
  await f.actions.refreshBookingInbox({ force: true });
  const previous = [record('old', { createdAt: 100 })],
    page1 = [record('new', { createdAt: 300 }), record('middle', { createdAt: 200 })];
  let reads = 0;
  f.actions.readBackground = async () =>
    ++reads === 1
      ? { items: page1, cursor: { createdAt: 200, id: 'middle' }, version: 'same' }
      : { items: previous, cursor: null, version: 'same' };
  const result = await f.actions.readBookingRequestWindow(previous, false, null, () => true);
  assert.deepEqual(
    Array.from(result.items, (r) => r.id),
    ['new', 'middle', 'old'],
  );
  assert.equal(reads, 2);
  reads = 0;
  f.actions.readBackground = async () =>
    ++reads === 1
      ? { items: page1, cursor: { createdAt: 200, id: 'middle' }, version: 'first' }
      : { items: previous, cursor: null, version: 'changed' };
  await assert.rejects(
    f.actions.readBookingRequestWindow(previous, false, null, () => true),
    /изменился/,
  );
  assert.ok(f.actions.$('.booking-request'));
});
