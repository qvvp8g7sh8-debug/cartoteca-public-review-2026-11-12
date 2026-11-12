// Prepared coverage; run only in the next user-authorized verification stage.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { normalizePatientPhoneText } = require('../src/shared/patient-names.cjs');
const { calendarLoadDay, calendarLoadDates } = require('../src/shared/calendar-load.cjs');
const root = path.resolve(__dirname, '..');
const day = '2030-01-07';

function fixture(t, mode = 'day') {
  const w = new JSDOM('<main id="root"></main>', { runScripts: 'outside-only' }).window;
  t.after(() => w.close());
  const members = [
    { accountId: 'owner', displayName: 'Тестовый владелец', role: 'owner' },
    { accountId: 'staff', displayName: 'Тестовый сотрудник', role: 'cosmetologist' },
  ];
  const state = {
    multiUser: true,
    currentView: 'calendar',
    calendarMode: mode,
    calendarAnchorDate: new w.Date(2030, 0, 7),
    showEarlyHours: false,
    calendarGrouping: 'staff',
    calendarLoadGrouping: 'staff',
    calendarLoadPeriod: 'day',
    selectedScheduleStaff: '',
    selectedRoomId: '',
    account: { id: 'owner' },
    lazyReads: true,
    calendarRecords: [],
    calendarOverview: null,
    personalRevision: 1,
    personalEvents: [
      {
        id: 'personal-one',
        date: day,
        time: '10:00',
        duration: 20,
        staffId: 'owner',
        notes: 'Забрать документы <script>alert(1)</script>',
      },
    ],
    workspace: {
      enabled: false,
      staffRules: [],
      members,
      rooms: [{ id: 'room', name: 'Тестовый кабинет', active: true, staffIds: ['owner', 'staff'] }],
    },
    roomBusy: [],
  };
  const clock = { date: day, hour: 8, minute: 0 };
  const actions = {
    normalizePatientPhoneText,
    $: (selector) => w.document.querySelector(selector),
    accountId: () => 'owner',
    accountRole: () => 'owner',
    calendarScheduleMembers: () => members,
    filterScheduleCalendarEvents: (records) =>
      records.filter(
        (record) =>
          !state.selectedScheduleStaff ||
          record.busy ||
          record.staffId === state.selectedScheduleStaff,
      ),
    calendarWorkingRanges: () => [[9 * 60, 12 * 60]],
    cabinetClock: () => clock,
    cabinetToday: () => day,
    cabinetTimeZoneLabel: () => 'UTC+03:00',
    calendarHiddenUntil: () => 420,
    calendarWorkScheduleHtml: () => '',
    scheduleSlotStyle: () => '',
    scheduleDayKind: () => 'unset',
    scheduleDayLabel: () => '',
    appointmentConfirmationStatus: () => 'Ждём подтверждения клиента',
    plural: (number, single, two, many) => (number === 1 ? single : many),
    patientNameParts: (patient) => ({ lastFirst: patient.name }),
    setView() {},
    calendarLoadDay,
    calendarLoadDates,
    calendarRecordsReady: () => true,
    calendarLoadSchedule: () => ({
      from: day,
      to: day,
      staffDays: {
        owner: { [day]: { status: 'working', intervals: [['09:00', '12:00']] } },
        staff: { [day]: { status: 'working', intervals: [['09:00', '12:00']] } },
      },
    }),
  };
  for (const [file, factory] of [
    ['shared/format.js', 'createFormat'],
    ['modules/rooms.js', 'createRooms'],
    ['modules/calendar-gaps.js', 'createCalendarGaps'],
    ['modules/calendar-columns.js', 'createCalendarColumns'],
    ['modules/calendar-personal.js', 'createCalendarPersonal'],
    ['modules/calendar-time-grid.js', 'createCalendarTimeGrid'],
    ['modules/calendar-week-scroll.js', 'createCalendarWeekScroll'],
    ['modules/calendar-load-data.js', 'createCalendarLoadData'],
    ['modules/calendar-load-view.js', 'createCalendarLoadView'],
    ['modules/calendar.js', 'createCalendar'],
  ]) {
    w.eval(fs.readFileSync(path.join(root, 'src/client', file), 'utf8'));
    Object.assign(actions, w[factory](state, actions));
  }
  return {
    w,
    state,
    actions,
    members,
    clock,
    render() {
      w.document.querySelector('#root').innerHTML = actions.calendarHtml();
      return w.document.querySelector('#root');
    },
  };
}

for (const mode of ['day', 'week', 'list']) {
  test(
    'personal time is separate from client controls, starts with time and escapes notes: ' + mode,
    (t) => {
      const f = fixture(t, mode);
      const rendered = f.render();
      const card = rendered.querySelector('[data-personal-event-id="personal-one"]');
      assert.ok(card);
      assert.match(card.getAttribute('aria-label'), /^10:00–10:20, Личное/);
      assert.match(card.textContent, /Забрать документы <script>alert\(1\)<\/script>/);
      assert.equal(card.querySelector('script'), null);
      assert.equal(card.querySelector('[data-calendar-status]'), null);
      assert.equal(card.hasAttribute('data-appointment-id'), false);
      assert.equal(card.hasAttribute('data-calendar-patient'), false);
      assert.doesNotMatch(
        card.innerHTML,
        /calendar-event-phone|agenda-client-phone|Подтвердить|не оформлено/,
      );
      f.clock.hour = 23;
      f.actions.updateCurrentTime();
      assert.match(card.className, /calendar-personal/);
      assert.doesNotMatch(card.textContent, /подтверждения|не оформлено/);
    },
  );
}

test('personal projection never invents the specialist’s single physical room', (t) => {
  const f = fixture(t);
  const event = f.actions.calendarEvents()[0];
  assert.equal(event.personal, true);
  assert.equal(event.kind, 'personal');
  assert.equal(event.roomId, undefined);
  assert.equal(event.patientId, undefined);
  assert.equal(f.actions.calendarClientPhone({ ...event, patientPhone: '89001234567' }), '');
  assert.equal(f.actions.calendarEventPeople({ ...event, roomId: 'room' }), 'Тестовый владелец');
});

test('personal reservations split employee gaps, while a shared room remains free for another employee', (t) => {
  const f = fixture(t);
  const records = f.actions.calendarEvents({ forGaps: true });
  const ownColumn = { date: day, staffId: 'owner', staffIds: ['owner'] };
  const ownEvents = f.actions.calendarColumnEvents(records, ownColumn, true);
  const gaps = f.actions.calendarFreeGaps(day, ownEvents, [[540, 720]], f.clock);
  assert.deepEqual(JSON.parse(JSON.stringify(gaps)), [
    { start: 540, end: 600 },
    { start: 620, end: 720 },
  ]);
  const sharedColumn = { date: day, roomId: 'room', staffIds: ['owner', 'staff'] };
  assert.equal(f.actions.calendarColumnEvents(records, sharedColumn).length, 1);
  assert.equal(f.actions.calendarColumnEvents(records, sharedColumn, true).length, 0);
  const singleColumn = { ...sharedColumn, staffIds: ['owner'] };
  assert.equal(f.actions.calendarColumnEvents(records, singleColumn, true).length, 1);
  assert.equal(
    f.actions.calendarColumnEvents(records, { ...ownColumn, staffId: 'staff' }).length,
    0,
  );
});

test('selected room includes personal time of assigned specialists without storing a room id', (t) => {
  const f = fixture(t);
  f.state.selectedRoomId = 'room';
  assert.equal(f.actions.calendarEvents().length, 1);
  f.state.workspace.rooms.push({ id: 'other', active: true, staffIds: ['staff'] });
  f.state.selectedRoomId = 'other';
  assert.equal(f.actions.calendarEvents().length, 0);
});

test('month shows personal counts separately from client appointments, without exposing notes', (t) => {
  const f = fixture(t, 'month');
  f.state.calendarOverview = [{ date: day, staffId: 'owner', count: 2 }];
  f.state.calendarPersonalOverview = [{ date: day, staffId: 'owner', count: 3 }];
  const cell = f.render().querySelector('[data-overview-date="' + day + '"]');
  assert.match(cell.getAttribute('aria-label'), /записей: 2, личных событий: 3/);
  assert.equal(cell.querySelector('.month-personal-count').textContent, '3 личных');
  assert.doesNotMatch(cell.innerHTML, /Забрать документы|script/);
});

test('employee load reserves personal minutes and counts clients separately; room load excludes personal time', (t) => {
  const f = fixture(t);
  f.state.calendarRecords = [
    { id: 'appointment', date: day, time: '11:00', duration: 60, staffId: 'owner', roomId: 'room' },
  ];
  let model = f.actions.calendarLoadModel();
  assert.equal(model.rows[0].cells[0].booked, 80);
  assert.equal(model.rows[0].cells[0].free, 100);
  assert.equal(model.rows[0].cells[0].count, 1);
  assert.equal(model.rows[0].cells[0].personalCount, 1);
  assert.equal(model.totals.count, 1);
  assert.equal(model.totals.personalCount, 1);
  f.state.workspace.rooms.push({ id: 'second', active: true, staffIds: ['staff'] });
  f.state.calendarLoadGrouping = 'rooms';
  model = f.actions.calendarLoadModel();
  assert.equal(model.roomMode, true);
  assert.equal(model.rows[0].cells[0].booked, 60);
  assert.equal(model.totals.personalCount, 0);
});

test('personal time outside working hours is still visible and counted outside the shift', (t) => {
  const f = fixture(t);
  f.state.personalEvents[0].time = '21:00';
  assert.ok(f.render().querySelector('[data-personal-event-id]'));
  const cell = f.actions.calendarLoadModel().rows[0].cells[0];
  assert.equal(cell.booked, 0);
  assert.equal(cell.free, 180);
  assert.equal(cell.outside, 20);
  assert.equal(cell.personalCount, 1);
});

test('23:30 personal reservation continues at 00:00 next day with the same id and unchanged source', (t) => {
  const f = fixture(t, 'week');
  const original = {
    id: 'overnight',
    date: day,
    time: '23:30',
    duration: 60,
    staffId: 'owner',
    notes: 'Ночное личное дело',
  };
  f.state.personalEvents = [original];
  f.state.showEarlyHours = true;
  const cards = [...f.render().querySelectorAll('[data-personal-event-id="overnight"]')].sort(
    (left, right) => left.closest('[data-slot-date]').dataset.slotDate.localeCompare(
      right.closest('[data-slot-date]').dataset.slotDate,
    ),
  );
  assert.equal(cards.length, 2);
  assert.equal(cards[0].closest('[data-slot-date]').dataset.slotDate, day);
  assert.match(cards[0].querySelector('.calendar-event-time').textContent, /^23:30–24:00/);
  assert.equal(cards[1].closest('[data-slot-date]').dataset.slotDate, '2030-01-08');
  assert.match(cards[1].querySelector('.calendar-event-time').textContent, /^00:00–00:30/);
  assert.match(cards[1].getAttribute('aria-label'), /Личное, продолжение/);
  f.state.calendarMode = 'day';
  f.state.calendarAnchorDate = new f.w.Date(2030, 0, 8);
  assert.equal(f.render().querySelectorAll('[data-personal-event-id="overnight"]').length, 1);
  f.state.showEarlyHours = false;
  assert.match(f.render().querySelector('[data-toggle-early-hours]').textContent, /· 1/);
  const records = f.actions.calendarEvents();
  const room = { date: '2030-01-08', roomId: 'room', staffIds: ['owner', 'staff'] };
  assert.equal(f.actions.calendarColumnEvents(records, room).length, 1);
  assert.equal(f.actions.calendarColumnEvents(records, { ...room, staffIds: ['staff'] }).length, 0);
  f.state.calendarLoadPeriod = 'week';
  f.state.calendarAnchorDate = new f.w.Date(2030, 0, 7);
  assert.equal(f.actions.calendarLoadModel().totals.personalCount, 1);
  assert.equal(f.state.personalEvents[0], original);
  assert.equal(original.date, day);
  assert.equal(original.time, '23:30');
  assert.equal(original.duration, 60);
});

test('calendar refresh detects only-personal changes and keeps the scroll while recording its revision', async (t) => {
  const f = fixture(t);
  f.w.document.querySelector('#root').innerHTML = '<div class="time-scroll"></div>';
  f.w.document.querySelector('.time-scroll').scrollTop = 125;
  let renders = 0;
  let reply = {
    appointments: [],
    personalEvents: [],
    personalRevision: 0,
    overview: [],
    personalOverview: [],
    version: 'first',
    validUntil: 1,
  };
  f.actions.readBackground = async () => reply;
  f.actions.setView = () => {
    renders++;
  };
  f.actions.rememberLoadedPatient = () => {};
  f.w.eval(fs.readFileSync(path.join(root, 'src/client/core/cabinet-queries.js'), 'utf8'));
  const queries = f.w.createCabinetQueries(f.state, f.actions);
  await queries.loadCalendarRecords();
  const before = renders;
  reply = {
    ...reply,
    personalEvents: [
      {
        id: 'changed',
        date: day,
        time: '10:00',
        duration: 30,
        staffId: 'owner',
        notes: 'Только личное изменение',
      },
    ],
    personalRevision: 2,
  };
  await queries.loadCalendarRecords({ force: true });
  assert.equal(renders, before + 1);
  assert.equal(f.state.personalEvents[0].notes, 'Только личное изменение');
  assert.equal(f.state.personalRevision, 2);
  assert.equal(f.w.document.querySelector('.time-scroll').scrollTop, 125);
});
