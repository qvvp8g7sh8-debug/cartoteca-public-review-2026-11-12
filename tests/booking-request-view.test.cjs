const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

test('booking view is read-only, escapes every projection and respects status/rights', (t) => {
  const w = new JSDOM('<main></main>', {
    runScripts: 'outside-only',
    url: 'https://synthetic.test/',
  }).window;
  t.after(() => w.close());
  w.eval(
    fs.readFileSync(path.join(__dirname, '../src/client/modules/booking-request-view.js'), 'utf8'),
  );
  const esc = (v) =>
    String(v).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const view = w.eval('createBookingRequestView')(
    {},
    { esc, formatDate: (v) => v, formatMinutes: (v) => v + ' мин' },
  );
  const name = '<img src=x onerror=evil>';
  const record = {
    id: 'r',
    status: 'requested',
    kind: 'other-time',
    firstName: name,
    phone: '+79990000000',
    date: '2030-01-01',
    time: '10:00',
    duration: 30,
    staffId: 'staff',
    services: [{ name }],
    comment: name,
    originalWish: { date: '2030-01-01', time: '09:00' },
  };
  const settings = { canManage: true, members: [{ accountId: 'staff', displayName: name }] };
  const candidates = new Map([['r', [{ id: 'p', name, phone: '+79990000000' }]]]);
  const links = new Map([['r', '/booking.html#reply=synthetic']]);
  const baseline = JSON.stringify({
    record,
    settings,
    candidates: [...candidates],
    links: [...links],
  });
  const main = w.document.querySelector('main');
  for (const status of ['pending', 'requested', 'expired', 'accepted', 'rejected', 'cancelled']) {
    const current = { ...record, status };
    main.innerHTML = view.bookingRequestsHtml([current], settings, candidates, links, null);
    assert.equal(main.querySelectorAll('img,script').length, 0);
    assert.equal(
      Boolean(main.querySelector('[data-booking-request-action=accept]')),
      ['pending', 'requested', 'expired'].includes(status),
    );
    assert.equal(main.querySelector('[data-booking-request-more]'), null);
  }
  main.innerHTML = view.bookingRequestsHtml(
    [{ ...record, proposal: { state: 'waiting' } }],
    settings,
    candidates,
    links,
    { id: 'r' },
  );
  assert.ok(main.querySelector('[data-booking-request-action=accept]'));
  assert.ok(main.querySelector('[data-booking-request-action=choose]'));
  assert.equal(main.querySelector('[data-booking-request-action=copy]'), null);
  assert.ok(main.querySelector('[data-booking-request-more]'));
  assert.equal(main.querySelector('[data-proposal-link]'), null);
  main.innerHTML = view.bookingRequestsHtml(
    [{ ...record, status: 'expired', proposal: { state: 'waiting' } }],
    settings,
    candidates,
    links,
    null,
  );
  assert.match(main.textContent, /Срок ожидания истёк/);
  assert.doesNotMatch(main.textContent, /Резерв истёк|ожидает ответа клиента/);
  assert.equal(main.querySelector('[data-booking-request-action=copy]'), null);
  assert.equal(main.querySelector('[data-booking-request-action=propose]'), null);
  assert.equal(main.querySelector('[data-proposal-link]'), null);
  main.innerHTML = view.bookingRequestsHtml(
    [{ ...record, status: 'expired', kind: 'reserve' }],
    settings,
    candidates,
    links,
    null,
  );
  assert.match(main.textContent, /Резерв истёк/);
  main.innerHTML = view.bookingRequestsHtml(
    [{ ...record, status: 'requested', proposal: { state: 'agreed' } }],
    settings,
    candidates,
    links,
    null,
  );
  assert.equal(main.querySelector('article').dataset.requestState, 'agreed');
  assert.equal(main.querySelector('.booking-request-schedule strong').textContent, '10:00');
  assert.equal(main.querySelector('.booking-request-comment').textContent, name);
  assert.equal(main.querySelectorAll('img,script').length, 0);
  main.innerHTML = view.bookingRequestsHtml(
    [{ ...record, status: 'expired', proposal: { state: 'agreed' } }],
    settings,
    candidates,
    links,
    null,
  );
  assert.equal(main.querySelector('article').dataset.requestState, 'expired');
  main.innerHTML = view.bookingRequestsHtml(
    [record],
    { ...settings, canManage: false, canManageOwnRequests: false },
    candidates,
    new Map(),
    null,
  );
  assert.equal(main.querySelector('button'), null);
  main.innerHTML = view.bookingRequestsHtml([], settings, new Map(), new Map(), null);
  assert.match(main.textContent, /Новых заявок пока нет/);
  assert.equal(
    JSON.stringify({ record, settings, candidates: [...candidates], links: [...links] }),
    baseline,
  );
});
