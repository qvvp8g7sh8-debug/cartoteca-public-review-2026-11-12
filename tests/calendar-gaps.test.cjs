const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  { JSDOM } = require('jsdom');
const source = fs.readFileSync(
  path.join(__dirname, '../src/client/modules/calendar-gaps.js'),
  'utf8',
);
const date = '2030-01-03',
  clock = { date: '2030-01-02', hour: 10, minute: 7 };
function fixture(t) {
  const w = new JSDOM('<main></main><input id="draft" value="Сохранить">', {
    runScripts: 'outside-only',
  }).window;
  t.after(() => w.close());
  let events = [],
    working = [[540, 1080]];
  const state = { currentView: 'calendar' };
  const actions = {
    $: (s) => w.document.querySelector(s),
    appointmentStart: (a) => Number(a.time.slice(0, 2)) * 60 + Number(a.time.slice(3)),
    cabinetClock: () => clock,
    calendarEvents: () => events,
    calendarWorkingRanges: () => working,
    parseDate: (value) => new w.Date(value + 'T00:00:00'),
    isoDate: (value) => value.getFullYear() + '-' + String(value.getMonth() + 1).padStart(2, '0') + '-' + String(value.getDate()).padStart(2, '0'),
    timeLabel: (n) =>
      String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0'),
  };
  w.eval(source);
  w.eval(fs.readFileSync(path.join(__dirname, '../src/client/modules/calendar-columns.js'), 'utf8'));
  Object.assign(actions, w.createCalendarColumns(state, actions));
  Object.assign(actions, w.createCalendarGaps(state, actions));
  return {
    w,
    state,
    actions,
    setEvents: (value) => {
      events = value;
    },
    setWorking: (value) => {
      working = value;
    },
  };
}
const event = (time, duration = 60, extra = {}) => ({ date, time, duration, ...extra });
const plain = (value) => JSON.parse(JSON.stringify(value));
test('free windows subtract overlapping visits and anonymous occupancy without treating cancellations as busy', (t) => {
  const f = fixture(t),
    records = [
      event('10:00'),
      event('10:30', 90),
      event('13:00', 30, { busy: true }),
      event('12:00', 60, { status: 'cancelled' }),
      event('14:00', 60, { status: 'no_show' }),
      event('15:00', 60, { status: 'completed' }),
    ];
  const before = JSON.stringify(records);
  assert.deepEqual(plain(f.actions.calendarFreeGaps(date, records, [[540, 1080]], clock)), [
    { start: 540, end: 600 },
    { start: 720, end: 780 },
    { start: 810, end: 900 },
    { start: 960, end: 1080 },
  ]);
  assert.equal(JSON.stringify(records), before);
});
test('an unset day labels only space between records; closed dates and short gaps have no labels', (t) => {
  const { actions } = fixture(t);
  const records = [event('09:00'), event('11:00')];
  assert.deepEqual(plain(actions.calendarFreeGaps(date, records, null, clock)), [
    { start: 600, end: 660 },
  ]);
  assert.deepEqual(plain(actions.calendarFreeGaps(date, [records[0]], null, clock)), []);
  assert.deepEqual(plain(actions.calendarFreeGaps(date, records, [], clock)), []);
  assert.deepEqual(
    plain(actions.calendarFreeGaps(date, [event('09:00'), event('10:10')], null, clock)),
    [],
  );
  assert.deepEqual(plain(actions.calendarFreeGaps('2030-01-01', records, [[0, 1440]], clock)), []);
});
test('working breaks, midnight and current organization time bound the visible windows', (t) => {
  const { actions } = fixture(t);
  assert.deepEqual(
    plain(
      actions.calendarFreeGaps(
        date,
        [],
        [
          [540, 720],
          [780, 1020],
        ],
        clock,
      ),
    ),
    [
      { start: 540, end: 720 },
      { start: 780, end: 1020 },
    ],
  );
  assert.deepEqual(
    plain(
      actions.calendarFreeGaps(
        date,
        [event('23:30', 120, { date: '2030-01-02' })],
        [[0, 240]],
        clock,
      ),
    ),
    [{ start: 90, end: 240 }],
  );
  assert.deepEqual(
    plain(actions.calendarFreeGaps(date, [event('11:00')], [[540, 780]], { ...clock, date })),
    [
      { start: 615, end: 660 },
      { start: 720, end: 780 },
    ],
  );
  assert.deepEqual(plain(actions.calendarFreeGaps(date, [], [[0, 480]], clock, 420)), [
    { start: 420, end: 480 },
  ]);
  assert.equal(actions.calendarGapDuration(90), '1 ч 30 мин');
  assert.equal(actions.calendarGapDuration(45), '45 мин');
  assert.equal(actions.calendarGapDuration(120), '2 ч');
});
test('annotations start near the window, reuse DOM nodes and stay outside inactive cards', (t) => {
  const f = fixture(t),
    { w, actions } = f;
  w.document.querySelector('main').innerHTML =
    '<div class="time-grid day-mode" data-dates="' +
    date +
    '" data-first-minute="540">' +
    Array.from(
      { length: 10 },
      (_, i) =>
        '<div data-slot-date="' +
        date +
        '" data-slot-time="' +
        actions.timeLabel((i + 9) * 60) +
        '"></div>',
    ).join('') +
    '</div>';
  f.setEvents([event('10:00'), event('13:00')]);
  actions.renderCalendarGaps();
  const labels = [...w.document.querySelectorAll('.calendar-gap')];
  assert.deepEqual(
    labels.map((n) => n.textContent),
    ['Свободно · 1 ч', 'Свободно · 2 ч', 'Свободно · 4 ч'],
  );
  assert.equal(labels[2].parentElement.dataset.slotTime, '14:00');
  assert.equal(labels[2].style.top, '36px');
  actions.renderCalendarGaps();
  assert.equal(w.document.querySelector('.calendar-gap'), labels[0]);
  assert.equal(w.document.querySelector('#draft').value, 'Сохранить');
  f.setEvents([event('09:00', 120, { status: 'cancelled' }), event('12:00')]);
  actions.renderCalendarGaps();
  const leading = w.document.querySelector('[data-calendar-gap="' + date + '|540|720"]');
  assert.equal(leading.textContent, 'Свободно · 3 ч');
  assert.equal(leading.parentElement.dataset.slotTime, '11:00');
  assert.match(leading.title, /09:00–12:00/);
  f.setWorking([]);
  actions.renderCalendarGaps();
  assert.equal(w.document.querySelector('.calendar-gap'), null);
});
test('a quarter-hour gap has a separate nonwrapping duration and keeps the full accessible interval', (t) => {
  const f = fixture(t);
  f.w.document.querySelector('main').innerHTML =
    `<div class="time-grid" data-dates="${date}" data-first-minute="540"><div data-slot-date="${date}" data-slot-time="11:00"></div></div>`;
  f.setEvents([event('10:00'), event('11:15')]);
  f.actions.renderCalendarGaps();
  const gap = f.w.document.querySelector('.calendar-gap');
  assert.ok(gap.classList.contains('is-short'));
  assert.equal(gap.querySelector('.calendar-gap-duration').textContent, '15 мин');
  assert.equal(gap.textContent, 'Свободно · 15 мин');
  assert.equal(gap.style.top, '9px');
  assert.equal(gap.getAttribute('aria-label'), 'Записать в свободный промежуток: 11:00–11:15 · 15 мин');
  f.actions.renderCalendarGaps();
  assert.equal(f.w.document.querySelector('.calendar-gap'), gap);
});

test('a clickable 45-minute gap after short appointments keeps its actual start across refreshes', (t) => {
  const f = fixture(t);
  Object.assign(f.state, { workspace: { rooms: [] }, selectedScheduleStaff: 'staff' });
  Object.assign(f.actions, { accountRole: () => 'owner', accountId: () => 'owner' });
  f.w.document.querySelector('main').innerHTML =
    `<div class="time-grid" data-dates="${date}" data-first-minute="600"><div data-slot-date="${date}" data-slot-time="10:00"></div></div>`;
  f.setWorking([[600, 660]]);
  f.setEvents([event('10:00', 5), event('10:10', 5)]);
  f.actions.renderCalendarGaps();
  const gap = f.w.document.querySelector('.calendar-gap');
  assert.equal(gap.tagName, 'BUTTON');
  assert.equal(gap.type, 'button');
  assert.equal(gap.dataset.slotTime, '10:15');
  assert.equal(gap.dataset.gapDuration, '45');
  assert.equal(gap.textContent, 'Свободно · 45 мин');
  const draft = f.actions.calendarNewAppointment(gap);
  assert.equal(draft.time, '10:15');
  assert.equal(draft.duration, 45);
  assert.equal(draft.timeHour, '10');
  const slot = gap.parentElement;
  slot.getBoundingClientRect = () => ({ top: 100, height: 96 });
  const emptyArea = f.actions.calendarNewAppointment(slot, { clientY: 148 });
  assert.equal(emptyArea.time, '10:15');
  assert.equal(emptyArea.duration, 45);
  assert.equal(emptyArea.timeHour, '10');
  const occupiedArea = f.actions.calendarNewAppointment(slot, { clientY: 103 });
  assert.equal(occupiedArea.time, '10:00');
  assert.equal(occupiedArea.gapDuration, undefined);
  for (let i = 0; i < 3; i++) f.actions.renderCalendarGaps();
  assert.equal(f.w.document.querySelector('.calendar-gap'), gap);
  assert.equal(gap.parentElement.tagName, 'DIV');
  assert.equal(gap.parentElement.dataset.slotTime, '10:00');
});

test('gap calculations keep the selected staff busy in another room without displaying that appointment', (t) => {
  const f = fixture(t),
    { state, actions, w } = f;
  Object.assign(state, {
    lazyReads: true,
    selectedRoomId: 'r1',
    selectedScheduleStaff: 'staff',
    workspace: {
      enabled: false,
      rooms: [
        { id: 'r1', active: true },
        { id: 'r2', active: true },
      ],
    },
    calendarRecords: [
      event('10:00', 60, { id: 'other-room', staffId: 'staff', roomId: 'r2' }),
      event('12:00', 60, { id: 'own-room', staffId: 'staff', roomId: 'r1' }),
      event('14:00', 60, { id: 'other-staff', staffId: 'other', roomId: 'r1' }),
    ],
  });
  Object.assign(actions, {
    accountId: () => 'staff',
    filterScheduleCalendarEvents: (records) =>
      records.filter((a) => a.staffId === state.selectedScheduleStaff),
  });
  w.eval(fs.readFileSync(path.join(__dirname, '../src/client/modules/rooms.js'), 'utf8'));
  Object.assign(actions, w.createRooms(state, actions));
  assert.deepEqual(plain(actions.calendarEvents().map((a) => a.id)), ['own-room']);
  const busy = actions.calendarEvents({ forGaps: true });
  assert.deepEqual(plain(busy.map((a) => a.id)), ['other-room', 'own-room']);
  assert.deepEqual(plain(actions.calendarFreeGaps(date, busy, [[540, 900]], clock)), [
    { start: 540, end: 600 },
    { start: 660, end: 720 },
    { start: 780, end: 900 },
  ]);
});
