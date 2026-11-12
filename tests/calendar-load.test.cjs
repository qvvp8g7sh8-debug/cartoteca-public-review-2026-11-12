const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { calendarLoadDay, calendarLoadDates } = require('../src/shared/calendar-load.cjs');
const date = '2030-01-07';
const work = {
  status: 'working',
  intervals: [
    ['09:00', '12:00'],
    ['13:00', '17:00'],
  ],
};
const record = (id, time, duration, extra = {}) => ({ id, date, time, duration, ...extra });

test('unioned occupancy excludes breaks and double counting overlapping records', () => {
  const day = calendarLoadDay(date, work, [record('a', '10:00', 180), record('b', '11:00', 180)]);
  assert.equal(day.capacity, 420);
  assert.equal(day.occupied, 240);
  assert.equal(day.booked, 180);
  assert.equal(day.outside, 60);
  assert.equal(day.free, 240);
  assert.equal(day.count, 2);
});

test('unknown graph is not zero occupancy or a personal day off', () => {
  const day = calendarLoadDay(date, null, [record('a', '10:00', 60)]);
  assert.equal(day.status, 'unset');
  assert.equal(day.capacity, null);
  assert.equal(day.free, null);
  assert.equal(day.percent, null);
  assert.equal(day.count, 1);
  assert.equal(day.occupied, 60);
});

test('common day off overrides shifts but keeps existing appointments visible', () => {
  const day = calendarLoadDay(date, work, [record('a', '10:00', 60)], true);
  assert.equal(day.status, 'common');
  assert.equal(day.capacity, 0);
  assert.equal(day.count, 1);
  assert.equal(day.outside, 60);
});

test('midnight appointments are clipped to the civil day; cancelled and no-show excluded', () => {
  const day = calendarLoadDay(date, { status: 'working', intervals: [['00:00', '01:00']] }, [
    record('a', '23:30', 90, { date: '2030-01-06' }),
    record('b', '00:00', 30, { status: 'cancelled' }),
    record('c', '00:30', 30, { status: 'no_show' }),
  ]);
  assert.equal(day.booked, 60);
  assert.equal(day.count, 1);
  assert.equal(day.percent, 100);
});

test('team totals ignore personal filters, weight working hours and respect authorized members', () => {
  const context = vm.createContext({ Date, Map, Set });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../src/client/modules/calendar-load-data.js'), 'utf8'),
    context,
  );
  const members = [
    { accountId: 'owner', role: 'owner' },
    { accountId: 'staff', role: 'cosmetologist' },
  ];
  const state = {
    calendarAnchorDate: new Date(2030, 0, 7),
    calendarLoadGrouping: 'staff',
    selectedScheduleStaff: 'owner',
    selectedRoomId: 'room1',
    lazyReads: true,
    workspace: { rooms: [] },
    calendarRecords: [
      record('a', '09:00', 60, { staffId: 'owner' }),
      record('b', '09:00', 120, { staffId: 'staff' }),
      record('hidden', '09:00', 60, { staffId: 'unauthorized' }),
    ],
  };
  const days = { owner: {}, staff: {} };
  for (let i = 7; i <= 13; i++)
    for (const id of ['owner', 'staff'])
      days[id]['2030-01-' + String(i).padStart(2, '0')] =
        i === 7
          ? { status: 'working', intervals: [['09:00', id === 'owner' ? '10:00' : '13:00']] }
          : { status: 'closed' };
  const actions = {
    calendarLoadSchedule: () => ({ from: date, to: '2030-01-13', staffDays: days }),
    calendarRecordsReady: () => true,
    calendarScheduleMembers: () => members,
    accountRole: () => 'owner',
    accountId: () => 'owner',
    isoDate: (d) => '2030-01-' + String(d.getDate()).padStart(2, '0'),
    calendarLoadDay,
    calendarLoadDates,
  };
  const model = context.createCalendarLoadData(state, actions).calendarLoadModel();
  assert.equal(model.rows.length, 2);
  assert.equal(model.totals.capacity, 300);
  assert.equal(model.totals.booked, 180);
  assert.equal(model.totals.count, 2);
  assert.equal(Math.round((model.totals.booked / model.totals.capacity) * 100), 60);
});

test('load periods use one civil day, rolling seven days and complete leap/calendar months', () => {
  const anchor = new Date(2032, 1, 18);
  const day = calendarLoadDates(anchor, 'day');
  assert.equal(day.length, 1);
  assert.equal(day[0].getDate(), 18);
  const week = calendarLoadDates(new Date(2031, 11, 29), 'week');
  assert.equal(week.length, 7);
  assert.equal(week.at(-1).getFullYear(), 2032);
  assert.equal(week.at(-1).getDate(), 4);
  const month = calendarLoadDates(anchor, 'month');
  assert.equal(month.length, 29);
  assert.equal(month[0].getDate(), 1);
  assert.equal(month.at(-1).getDate(), 29);
  assert.equal(calendarLoadDates(new Date(2031, 1, 18), 'month').length, 28);
  assert.equal(calendarLoadDates(new Date(2030, 3, 18), 'month').length, 30);
  assert.equal(calendarLoadDates(new Date(2030, 0, 18), 'month').length, 31);
  assert.equal(anchor.getDate(), 18);
});

for (const period of ['day', 'week', 'month']) {
  test('load date cells show only percentages in month, details otherwise: ' + period, (t) => {
    const { JSDOM } = require('jsdom');
    const cells = [
      calendarLoadDay(date, work, []),
      calendarLoadDay(date, work, [record('full', '09:00', 480)]),
      calendarLoadDay(date, { status: 'closed', intervals: [] }, []),
      calendarLoadDay(date, null, []),
    ];
    const total = { booked: 480, capacity: 960, free: 480, count: 1, unknown: 1, outside: 0 };
    const model = {
      ready: true,
      dates: [date],
      canGroup: false,
      roomMode: false,
      totals: total,
      daily: [total],
      rows: cells.map((cell, index) => ({
        id: 'staff-' + index,
        name: 'Специалист',
        cells: [cell],
      })),
    };
    const context = vm.createContext({ Intl });
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, '../src/client/modules/calendar-load-view.js'), 'utf8'),
      context,
    );
    const view = context.createCalendarLoadView(
      { calendarLoadPeriod: period },
      {
        calendarLoadModel: () => model,
        calendarControlsHtml: () => '',
        cabinetTimeZoneLabel: () => 'UTC+03:00',
        monthCalendarHtml: () => '',
        formatDate: (value) => value,
        parseDate: (value) => new Date(value + 'T12:00:00Z'),
        esc: (value) => String(value),
        plural: () => 'записей',
      },
    );
    const dom = new JSDOM(view.calendarLoadHtml());
    t.after(() => dom.window.close());
    const document = dom.window.document;
    const buttons = [...document.querySelectorAll('tbody .load-cell')];
    if (period === 'month') {
      assert.deepEqual(
        buttons.map((button) => button.textContent),
        ['0%', '100%', '—', '—'],
      );
      assert.ok(document.querySelector('.load-table-month'));
      assert.equal(
        document.querySelectorAll('tbody td small, tbody td meter, tfoot td small').length,
        0,
      );
      assert.match(buttons[2].getAttribute('aria-label'), /Выходной/);
      assert.match(buttons[3].getAttribute('aria-label'), /График не задан/);
      assert.equal(document.querySelector('tfoot td').textContent, '50%');
    } else {
      assert.match(buttons[0].textContent, /Свободно/);
      assert.ok(buttons[0].querySelector('meter'));
      assert.ok(document.querySelector('tfoot td small'));
    }
  });
}
