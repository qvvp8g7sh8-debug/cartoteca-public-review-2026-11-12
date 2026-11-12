const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const postcss = require('postcss');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const escape = (value) =>
  String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

test('management A rules apply only to the desktop working surface, never mobile, calendar or print', () => {
  const sheet = postcss.parse(read('src/client/styles/desktop-management.css'));
  sheet.walkRules((rule) => {
    for (const selector of rule.selectors)
      assert.ok(
        selector.replace(/\s+/g, ' ').startsWith('.workspace.workspace-designed .management-panel'),
        selector,
      );
    assert.doesNotMatch(rule.selector, /calendar-panel|time-grid|topbar|print-|#editor/);
    const media = [];
    for (let parent = rule.parent; parent; parent = parent.parent)
      if (parent.type === 'atrule' && parent.name === 'media') media.push(parent.params);
    assert.ok(
      media.some((value) => /^screen\s+and\s+\(min-width:\s*981px\)$/.test(value)),
      rule.selector,
    );
  });
  const manifest = JSON.parse(read('src/client/manifest.json')).styles;
  const target = manifest.indexOf('src/client/styles/desktop-management.css');
  assert.ok(target > manifest.indexOf('src/client/styles/services-calm.css'));
  assert.ok(target > manifest.indexOf('src/client/styles/management-details-design.css'));
});

test('compact request rows retain contact, schedule, reserve state, comments and every decision', (t) => {
  const window = new JSDOM('<main></main>', { runScripts: 'outside-only' }).window;
  t.after(() => window.close());
  window.eval(read('src/client/modules/booking-request-view.js'));
  const renderer = window.eval('createBookingRequestView')(
    {},
    {
      esc: escape,
      formatDate: (value) => value,
      formatMinutes: (value) => `${value} минут`,
    },
  );
  const item = {
    id: 'synthetic-request',
    revision: 1,
    status: 'pending',
    staffId: 'synthetic-staff',
    firstName: 'Анна',
    middleName: 'Тестовая',
    lastName: 'Примерова',
    phone: '+7 000 000-00-00',
    date: '2030-10-13',
    time: '11:15',
    duration: 45,
    services: [{ name: 'Тестовая услуга' }],
    comment: '<Тестовый комментарий>',
    originalWish: { date: '2030-10-12', time: '10:00' },
  };
  const main = window.document.querySelector('main');
  main.innerHTML = renderer.bookingRequestsHtml(
    [item],
    {
      canManage: true,
      members: [{ accountId: 'synthetic-staff', displayName: 'Тестовый специалист' }],
    },
    new Map([[item.id, [{ id: 'synthetic-client', name: 'Тестовая карточка', phone: '' }]]]),
    new Map(),
    'next',
  );
  const row = main.querySelector('.booking-request');
  assert.equal(row.querySelector('.booking-request-schedule strong').textContent, '11:15');
  assert.match(row.querySelector('.booking-request-status').textContent, /зарезервировано/);
  for (const text of [
    'Тестовая услуга',
    'Тестовый специалист',
    '<Тестовый комментарий>',
    '2030-10-12',
    '10:00',
  ])
    assert.ok(row.textContent.includes(text), text);
  assert.deepEqual(
    [...row.querySelectorAll('[data-booking-request-action]')].map(
      (button) => button.dataset.bookingRequestAction,
    ),
    ['accept', 'choose', 'reject'],
  );
  assert.ok(row.querySelector('[data-booking-contact]'));
  assert.ok(main.querySelector('[data-booking-request-more]'));
  assert.equal(row.querySelector('тестовый'), null);
  main.innerHTML = renderer.bookingRequestsHtml(
    [item],
    { canManage: false, members: [] },
    new Map(),
    new Map(),
    '',
  );
  assert.equal(main.querySelector('[data-booking-request-action]'), null);
});

test('working calendar keeps date selection and permission boundaries for the compact desktop layout', (t) => {
  const window = new JSDOM('<main></main>', { runScripts: 'outside-only' }).window;
  t.after(() => window.close());
  window.eval(read('src/client/modules/work-schedule-view.js'));
  const renderer = window.eval('createWorkScheduleView')(
    {},
    {
      esc: escape,
      accountRole: () => 'owner',
      formatDate: (value) => value,
      monthTitle: () => 'Октябрь 2030',
      cabinetTimeZoneLabel: () => 'Тестовое время',
    },
  );
  const view = {
    staffId: 'synthetic-staff',
    members: [{ accountId: 'synthetic-staff', displayName: 'Тестовый специалист' }],
    days: {
      '2030-10-13': {
        status: 'working',
        intervals: [
          ['09:00', '12:00'],
          ['13:00', '18:00'],
        ],
      },
    },
    closures: {},
    canEdit: false,
    canManagePermission: false,
    canManageCalendar: false,
    calendarHiddenUntil: '09:00',
  };
  const main = window.document.querySelector('main');
  main.innerHTML = renderer.workScheduleMonthHtml(view, '2030-10', ['2030-10-13']);
  assert.equal(main.querySelectorAll('[data-work-date]').length, 31);
  assert.equal(main.querySelectorAll('[data-work-weekday]').length, 7);
  assert.equal(
    main.querySelector('[data-work-date="2030-10-13"]').getAttribute('aria-pressed'),
    'true',
  );
  assert.match(
    main.querySelector('[data-work-date="2030-10-13"]').getAttribute('aria-label'),
    /09:00–12:00, 13:00–18:00/,
  );
  assert.equal(main.querySelector('[data-work-edit]').disabled, true);
  assert.equal(main.querySelector('#work-schedule-permission'), null);
  assert.equal(main.querySelector('#calendar-hidden-until'), null);
});
