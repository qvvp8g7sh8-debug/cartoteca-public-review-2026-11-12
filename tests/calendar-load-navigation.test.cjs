const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { calendarLoadDates } = require('../src/shared/calendar-load.cjs');
const root = path.resolve(__dirname, '..');

function fixture(t, mobile = true) {
  const w = new JSDOM(
    '<main><button data-calendar-mode="load"><span>Загрузка</span></button>' +
      '<button data-view="calendar">Календарь</button><button data-calendar-today>Сегодня</button>' +
      '<button data-calendar-prev>Назад</button><button data-calendar-next>Вперёд</button>' +
      '<button data-load-period="day">День</button><button data-load-period="week">Неделя</button>' +
      '<button data-load-period="month">Месяц</button><input value="Черновик"></main>',
    { runScripts: 'outside-only' },
  ).window;
  t.after(() => w.close());
  const state = {
    multiUser: true,
    currentView: 'calendar',
    calendarMode: 'day',
    calendarGrouping: 'staff',
    calendarLoadPeriod: 'week',
    calendarAnchorDate: new w.Date(2030, 0, 31),
    mobileScreen: { matches: mobile },
    workspace: { rooms: [] },
    selectedScheduleStaff: 'owner',
    selectedRoomId: '',
    monthPickerOpen: false,
  };
  let renders = 0;
  const actions = {
    accountId: () => 'owner',
    accountRole: () => 'owner',
    calendarScheduleMembers: () => [
      { accountId: 'owner', displayName: 'Владелец' },
      { accountId: 'staff', displayName: 'Специалист' },
    ],
    cabinetTodayDate: () => new w.Date(2030, 1, 5),
    setView: () => {
      renders++;
    },
  };
  for (const [file, factory] of [
    ['calendar-columns', 'createCalendarColumns'],
    ['calendar-load-navigation', 'createCalendarLoadNavigation'],
  ]) {
    w.eval(fs.readFileSync(path.join(root, 'src/client/modules', file + '.js'), 'utf8'));
    Object.assign(actions, w[factory](state, actions));
  }
  w.document.addEventListener('click', (event) => {
    if (actions.handleCalendarLoadNavigation(event.target)) return;
    const mode = event.target.closest('[data-calendar-mode]');
    if (mode) {
      actions.setCalendarMode(mode.dataset.calendarMode);
      actions.setView('calendar');
    }
  });
  return { w, state, actions, $: (s) => w.document.querySelector(s), renders: () => renders };
}

for (const mode of ['day', 'week', 'month', 'list']) {
  test('load toggle restores previous calendar mode and employee filter: ' + mode, (t) => {
    const f = fixture(t);
    f.state.calendarMode = mode;
    const date = f.state.calendarAnchorDate;
    f.$('[data-calendar-mode=load] span').click();
    assert.equal(f.state.calendarMode, 'load');
    assert.equal(f.state.calendarLoadPeriod, mode === 'list' ? 'week' : mode);
    f.$('[data-calendar-mode=load]').click();
    assert.equal(f.state.calendarMode, mode);
    assert.equal(f.state.calendarAnchorDate, date);
    assert.equal(f.state.selectedScheduleStaff, 'owner');
    assert.equal(f.$('input').value, 'Черновик');
  });
}
for (const mobile of [true, false]) {
  test('bottom calendar exits load to device default: ' + mobile, (t) => {
    const f = fixture(t, mobile);
    f.$('[data-calendar-mode=load]').click();
    f.state.monthPickerOpen = true;
    f.$('[data-view=calendar]').click();
    assert.equal(f.state.calendarMode, mobile ? 'day' : 'week');
    assert.equal(f.state.monthPickerOpen, false);
  });
}
for (const period of ['day', 'week', 'month']) {
  test('period switch stays in load and Today uses organization date: ' + period, (t) => {
    const f = fixture(t);
    f.$('[data-calendar-mode=load]').click();
    f.$('[data-load-period=' + period + ']').click();
    assert.equal(f.state.calendarMode, 'load');
    assert.equal(f.state.calendarLoadPeriod, period);
    f.state.monthPickerOpen = true;
    f.$('[data-calendar-today]').click();
    assert.equal(f.state.calendarAnchorDate.getMonth(), 1);
    assert.equal(f.state.calendarAnchorDate.getDate(), 5);
    assert.equal(f.state.monthPickerOpen, false);
    assert.equal(f.state.calendarLoadPeriod, period);
    assert.equal(f.renders(), 3);
  });
}
test('period arrows advance day/week/month without January overflow into March', (t) => {
  const f = fixture(t);
  f.$('[data-calendar-mode=load]').click();
  f.$('[data-calendar-next]').click();
  assert.equal(f.state.calendarAnchorDate.getMonth(), 1);
  assert.equal(f.state.calendarAnchorDate.getDate(), 1);
  f.$('[data-load-period=week]').click();
  f.$('[data-calendar-next]').click();
  assert.equal(f.state.calendarAnchorDate.getDate(), 8);
  f.$('[data-load-period=month]').click();
  f.state.calendarAnchorDate = new f.w.Date(2030, 0, 31);
  f.$('[data-calendar-next]').click();
  assert.equal(f.state.calendarAnchorDate.getMonth(), 1);
  assert.equal(f.state.calendarAnchorDate.getDate(), 1);
  f.$('[data-calendar-prev]').click();
  assert.equal(f.state.calendarAnchorDate.getMonth(), 0);
});

test('schedule and record ranges cover every monthly date and the previous midnight boundary', (t) => {
  const f = fixture(t);
  f.state.calendarMode = 'load';
  f.state.calendarLoadPeriod = 'month';
  const actions = {
    calendarLoadDates,
    isoDate: (d) =>
      [
        d.getFullYear(),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0'),
      ].join('-'),
    weekStart: (d) => {
      const date = new f.w.Date(d);
      date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
      return date;
    },
  };
  f.w.eval(fs.readFileSync(path.join(root, 'src/client/modules/rooms.js'), 'utf8'));
  const range = f.w.createRooms(f.state, actions).calendarRange();
  assert.equal(range.from, '2030-01-01');
  assert.equal(range.to, '2030-01-31');
  f.w.eval(fs.readFileSync(path.join(root, 'src/client/core/cabinet-queries.js'), 'utf8'));
  const reads = f.w.createCabinetQueries(f.state, actions).calendarReadRange();
  assert.ok(reads.from < range.from);
  assert.ok(reads.to >= range.to);
});
