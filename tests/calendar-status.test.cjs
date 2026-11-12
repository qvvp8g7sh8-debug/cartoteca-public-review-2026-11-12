const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { JSDOM } = require('jsdom'),
  { zonedClock } = require('../src/shared/time-zone.cjs');
const { normalizePatientPhoneText } = require('../src/shared/patient-names.cjs');
const root = path.resolve(__dirname, '..');
test('status styles stay top-level on desktop as well as mobile, outside legacy cross-file media blocks', (t) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/client/manifest.json'), 'utf8'));
  const w = new JSDOM(
    '<style>' +
      manifest.styles.map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('') +
      '</style>',
  ).window;
  t.after(() => w.close());
  const rules = Array.from(w.document.styleSheets[0].cssRules);
  for (const state of ['scheduled', 'confirmed', 'unfiled', 'completed', 'cancelled', 'no-show'])
    assert.ok(rules.some((rule) => rule.selectorText === '.appointment-state-' + state));
  assert.ok(rules.some((rule) => rule.selectorText === '.calendar-status-legend'));
});
function fixture(t, { mode = 'day', clock = { date: '2026-10-05', hour: 11, minute: 0 } } = {}) {
  const w = new JSDOM('<main id="root"></main><input id="draft" value="Не терять">', {
    runScripts: 'outside-only',
  }).window;
  t.after(() => w.close());
  const state = {
    currentView: 'calendar',
    calendarMode: mode,
    calendarAnchorDate: new w.Date(2026, 9, 5),
    showEarlyHours: false,
    multiUser: true,
    monthPickerOpen: false,
    calendarGrouping: 'staff',
    selectedScheduleStaff: '',
    selectedRoomId: '',
    workspace: { rooms: [{ id: 'main', active: true, staffIds: ['staff'] }], members: [{ accountId: 'staff', displayName: 'Тестовый сотрудник' }] },
  };
  let records = [];
  const actions = {
    normalizePatientPhoneText,
    $: (s) => w.document.querySelector(s),
    esc: (x) =>
      String(x).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
      ),
    calendarEvents: () => records,
    calendarWorkingRanges: () => null,
    cabinetClock: () => clock,
    cabinetToday: () => clock.date,
    cabinetTimeZoneLabel: () => 'UTC+03:00',
    calendarHiddenUntil: () => 420,
    roomName: () => '',
    roomFilterHtml: () => '',
    calendarWorkScheduleHtml: () => '',
    scheduleSlotStyle: () => '',
    scheduleDayKind: () => 'unset',
    scheduleDayLabel: () => '',
    plural: (v, a, b, c) => (v === 1 ? a : c),
    accountId: () => 'staff',
    accountRole: () => 'cosmetologist',
    calendarScheduleMembers: () => [{ accountId: 'staff', displayName: 'Тестовый сотрудник' }],
  };
  for (const [file, name] of [
    ['src/client/shared/format.js', 'createFormat'],
    ['src/shared/appointment-status.cjs', 'createAppointmentStatuses'],
    ['src/client/modules/manual-confirmation.js', 'createManualConfirmation'],
    ['src/client/modules/calendar-gaps.js', 'createCalendarGaps'],
    ['src/client/modules/calendar-columns.js', 'createCalendarColumns'],
    ['src/client/modules/calendar-time-grid.js', 'createCalendarTimeGrid'],
    ['src/client/modules/calendar-week-scroll.js', 'createCalendarWeekScroll'],
    ['src/client/modules/calendar-load-view.js', 'createCalendarLoadView'],
    ['src/client/modules/calendar.js', 'createCalendar'],
  ]) {
    w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
    Object.assign(actions, w[name](state, actions));
  }
  function render(values = records) {
    records = values;
    w.document.querySelector('#root').innerHTML = actions.calendarHtml();
    actions.positionCalendarEvents();
    actions.updateCurrentTime();
    return w.document.querySelector('#root');
  }
  const a = {
    id: 'a',
    patientId: 'p',
    patientName: 'Тестовый клиент',
    date: '2026-10-05',
    time: '12:00',
    duration: 60,
    service: 'Тестовая услуга',
  };
  return { w, state, actions, clock, a, render, $: (s) => w.document.querySelector(s) };
}

// Online origin is separate from status and must not leak through anonymous busy rows.
for (const mode of ['day', 'week', 'list']) {
  test('online origin remains identifiable through confirmation and periodic refresh: ' + mode, (t) => {
    const f = fixture(t, { mode }),
      selector = mode === 'list' ? '.agenda-event' : '.calendar-event';
    const record = { ...f.a, bookingSource: 'online', manualConfirmedAt: 1 };
    f.render([record]);
    assert.equal(f.$(selector).dataset.calendarSource, 'online');
    assert.equal(f.$(selector).dataset.calendarState, 'confirmed');
    assert.match(f.$(selector).getAttribute('aria-label'), /Онлайн-запись/);
    delete record.bookingSource;
    f.actions.updateCurrentTime();
    assert.equal(f.$(selector).dataset.calendarSource, 'manual');
    assert.doesNotMatch(f.$(selector).title, /Онлайн-запись/);
    f.render([{ ...f.a, bookingSource: 'online', busy: true }]);
    assert.equal(f.$(selector).hasAttribute('data-calendar-source'), false);
  });
}

// CALENDAR-PHONE cases are prepared for the next explicitly requested test stage.
for (const mode of ['day', 'week', 'list']) {
  test('phone-only client uses a single phone label instead of an absent name: ' + mode, (t) => {
    const f = fixture(t, { mode });
    for (const duration of [15, 30, 60]) {
      f.render([{ ...f.a, patientName: '', patientPhone: '89001234567', duration }]);
      const card = f.$(mode === 'list' ? '.agenda-event' : '.calendar-event');
      assert.equal(card.querySelector('strong').textContent, '+7 (900) 123-45-67');
      assert.equal(card.querySelector('.agenda-client-phone, .calendar-event-phone'), null);
      assert.equal(card.getAttribute('aria-label').split('+7 (900) 123-45-67').length, 2);
      assert.doesNotMatch(card.textContent, /Имя не указано/);
    }
    f.render([{ ...f.a, busy: true, patientName: '', patientPhone: '89001234567' }]);
    assert.doesNotMatch(f.$('#root').textContent, /900|123-45/);
  });
}

for (const mode of ['day', 'week', 'list']) {
  test('calendar contact row follows card height without exposing busy contacts: ' + mode, (t) => {
    const f = fixture(t, { mode });
    for (const duration of [5, 15, 30, 45]) {
      f.render([{ ...f.a, duration, patientPhone: '89001234567' }]);
      const row = f.$(mode === 'list' ? '.agenda-client-phone' : '.calendar-event-phone');
      assert.equal(Boolean(row), mode === 'list' || duration >= 30);
      if (row) assert.equal(row.textContent, '+7 (900) 123-45-67');
    }
    f.render([{ ...f.a, patientPhone: '' }]);
    assert.equal(f.$('.calendar-event-phone, .agenda-client-phone'), null);
    f.render([{ ...f.a, busy: true, patientName: 'PRIVATE NAME', patientPhone: '89001234567' }]);
    assert.doesNotMatch(f.$('#root').innerHTML, /PRIVATE NAME|900|calendar-event-phone|agenda-client-phone/);
  });
}

for (const role of ['owner', 'admin']) {
  for (const mode of ['day', 'week', 'month', 'list']) {
    test('compact team controls retain selection and no legend: ' + role + '/' + mode, (t) => {
      const f = fixture(t, { mode });
      f.actions.accountRole = () => role;
      f.actions.calendarScheduleMembers = () => [
        { accountId: 'staff', displayName: 'Первый сотрудник' },
        { accountId: 'second', displayName: 'Второй сотрудник' },
      ];
      f.state.workspace.rooms.push({ id: 'other', active: true, name: 'Второй кабинет' });
      f.render([f.a]);
      assert.equal(f.$('.calendar-status-legend'), null);
      assert.equal(f.$('.calendar-selection').querySelectorAll('label').length, 2);
      assert.equal(f.$('#calendar-grouping').value, 'staff');
      assert.equal(f.$('#calendar-schedule-staff').options.length, mode === 'week' ? 2 : 3);
      assert.equal(f.$('#root').querySelectorAll('.calendar-period-caption').length, 1);
      if (mode === 'day' || mode === 'week') {
        assert.ok(f.$('.calendar-day-tools .calendar-period-caption'));
        assert.equal(f.$('#root').querySelectorAll('[data-toggle-early-hours]').length, 1);
        assert.match(f.$('[data-toggle-early-hours]').getAttribute('aria-label'), /07:00/);
        assert.match(f.$('.early-hours-short').textContent, /Показать до 07:00/);
      }
      assert.equal(f.$('#draft').value, 'Не терять');
    });
  }
}
test('calendar cards show room names only with multiple active rooms in staff day and week', (t) => {
  const f = fixture(t);
  f.actions.roomName = (id) => id === 'main' ? 'Единственный кабинет' : 'Второй кабинет';
  f.actions.calendarScheduleMembers = () => [
    { accountId: 'staff', displayName: 'Тестовый сотрудник' },
    { accountId: 'other-staff', displayName: 'Другой сотрудник' },
  ];
  const appointment = { ...f.a, staffId: 'staff', roomId: 'main' };
  const busy = { ...appointment, id: 'busy', busy: true, time: '14:00' };
  for (const mode of ['day', 'week']) {
    f.state.calendarMode = mode;
    for (const active of [false, true]) {
      f.state.workspace.rooms = [
        { id: 'main', active: true, staffIds: ['staff'] },
        { id: 'other', active, staffIds: ['staff'] },
      ];
      f.render([appointment, busy]);
      assert.equal(f.$('.calendar-event-context')?.textContent || '', active ? 'Единственный кабинет' : '');
      assert.equal(f.$('.calendar-busy').textContent.includes('Единственный кабинет'), active);
      assert.equal(appointment.roomId, 'main');
    }
  }
});
test('day omits duplicate working hours; week and month keep the hours', async (t) => {
  const f = fixture(t);
  Object.assign(f.state, { account: { id: 'staff', organizationId: 'org' } });
  Object.assign(f.actions, {
    accountId: () => 'staff',
    accountRole: () => 'owner',
    calendarRange: () => ({ from: '2026-10-01', to: '2026-10-31' }),
    readBackground: async () => ({
      from: '2026-10-01',
      to: '2026-10-31',
      staffId: 'staff',
      members: [{ accountId: 'staff' }],
      closures: {},
      days: { '2026-10-05': { status: 'working', intervals: [['09:00', '18:00']] } },
    }),
    setView() {},
    workDayLabel: () => '09:00–18:00',
  });
  f.w.eval(fs.readFileSync(path.join(root, 'src/client/modules/work-schedules.js'), 'utf8'));
  Object.assign(f.actions, f.w.createWorkSchedules(f.state, f.actions));
  await f.actions.loadCalendarSchedule();
  for (const mode of ['day', 'week']) {
    f.state.calendarMode = mode;
    f.render();
    assert.equal(f.$('#root').querySelectorAll('.calendar-work-hours').length, mode === 'day' ? 0 : 1);
    if (mode === 'week')
      assert.equal(f.$('.calendar-day-tools .calendar-work-hours').textContent, '09:00–18:00');
    assert.ok(f.$('.calendar-day-tools [data-toggle-early-hours]'));
  }
  f.state.calendarMode = 'month';
  f.render();
  assert.equal(f.$('.calendar-work-hours').textContent, '09:00–18:00');
  assert.equal(f.$('#draft').value, 'Не терять');
});

test('rolling week and availability use the selected day and include its last day across month and year boundaries', (t) => {
  const f = fixture(t, { mode: 'week' });
  f.w.eval(fs.readFileSync(path.join(root, 'src/client/modules/rooms.js'), 'utf8'));
  f.w.eval(fs.readFileSync(path.join(root, 'src/client/core/cabinet-queries.js'), 'utf8'));
  const rooms = f.w.createRooms(f.state, f.actions);
  const queries = f.w.createCabinetQueries(f.state, f.actions);
  for (const [date, end] of [
    ['2023-10-31', '2023-11-06'],
    ['2026-12-31', '2027-01-06'],
  ]) {
    f.state.calendarAnchorDate = f.actions.parseDate(date);
    f.render();
    const dates = f.$('.time-grid').dataset.dates.split(',');
    assert.equal(dates.length, 7);
    assert.equal(dates[0], date);
    assert.equal(dates.at(-1), end);
    assert.equal(rooms.calendarRange().from, date);
    assert.equal(rooms.calendarRange().to, end);
    assert.ok(queries.calendarReadRange().from <= date);
    assert.ok(queries.calendarReadRange().to >= end);
    assert.ok(
      (Date.parse(queries.calendarReadRange().to) - Date.parse(queries.calendarReadRange().from)) /
        86400000 <=
        42,
    );
  }
});

test('early hours use one textual toggle above the grid with an explicit expanded state', (t) => {
  const f = fixture(t);
  f.render();
  assert.equal(f.$('[data-toggle-early-hours] .early-hours-full').textContent, 'Показать время до 07:00');
  assert.equal(f.$('[data-toggle-early-hours]').getAttribute('aria-pressed'), 'false');
  assert.equal(f.$('.mobile-hours'), null);
  f.state.showEarlyHours = true;
  f.render();
  assert.equal(f.$('[data-toggle-early-hours] .early-hours-full').textContent, 'Свернуть время до 07:00');
  assert.equal(f.$('[data-toggle-early-hours]').getAttribute('aria-pressed'), 'true');
  assert.equal(f.$('.time-grid').dataset.firstMinute, '0');
});

test('configured early-hours boundary changes the calendar start and toggle label', (t) => {
  const f = fixture(t);
  f.actions.calendarHiddenUntil = () => 540;
  f.render();
  assert.equal(f.$('[data-toggle-early-hours] .early-hours-full').textContent, 'Показать время до 09:00');
  assert.equal(f.$('.time-grid').dataset.firstMinute, '540');
  f.actions.calendarHiddenUntil = () => 0;
  f.render();
  assert.equal(f.$('[data-toggle-early-hours]'), null);
  assert.equal(f.$('.time-grid').dataset.firstMinute, '0');
});

test('work days shortcut stays in primary controls on desktop and the compact top row on phones in every calendar mode', (t) => {
  for (const mode of ['day', 'week', 'month', 'list']) {
    const f = fixture(t, { mode });
    f.render();
    const mobile = f.$('.mobile-calendar-heading [data-open-work-schedule]');
    const desktop = f.$('.calendar-actions [data-open-work-schedule]');
    assert.equal(mobile.textContent, 'Рабочие дни');
    assert.equal(desktop.textContent, 'Рабочие дни');
    assert.equal(mobile.getAttribute('aria-label'), 'Рабочие дни и время');
    assert.ok(mobile.querySelector('svg[aria-hidden="true"]'));
    assert.equal(desktop.nextElementSibling.id, 'calendar-new');
    assert.equal(desktop.parentElement.className, 'calendar-booking-tools');
    assert.equal(f.$('.calendar-work-schedule [data-open-work-schedule]'), null);
    assert.equal(f.$('.mobile-calendar-heading strong'), null);
    f.state.multiUser = false;
    f.render();
    assert.equal(f.$('[data-open-work-schedule]'), null);
    assert.equal(f.$('.mobile-calendar-heading strong').textContent, 'Записи');
  }
});
for (const mode of ['day', 'week'])
  test('working backgrounds use CSSOM instead of CSP-blocked HTML styles in ' + mode, (t) => {
    const f = fixture(t, { mode });
    f.actions.scheduleSlotStyle = (date, start) =>
      date === '2026-10-05'
        ? start >= 840 && start < 1080
          ? 'var(--calendar-work-grid),#fafbfc'
          : '#e8f3ec'
        : date === '2026-10-06'
          ? '#e4e7eb'
          : '';
    f.$('#root').innerHTML = f.actions.calendarHtml();
    assert.equal(f.$('#root').querySelectorAll('.time-slot[style]').length, 0);
    f.actions.positionCalendarEvents();
    for (const time of ['14:00', '15:00', '16:00', '17:00'])
      assert.ok(
        f
          .$('[data-slot-date="2026-10-05"][data-slot-time="' + time + '"]')
          .style.background.includes('--calendar-work-grid'),
      );
    for (const time of ['13:00', '18:00'])
      assert.equal(
        f.$('[data-slot-date="2026-10-05"][data-slot-time="' + time + '"]').style.backgroundColor,
        'rgb(232, 243, 236)',
      );
    if (mode === 'week') {
      assert.equal(
        f.$('[data-slot-date="2026-10-06"][data-slot-time="13:00"]').style.backgroundColor,
        'rgb(228, 231, 235)',
      );
      assert.equal(
        f.$('[data-slot-date="2026-10-07"][data-slot-time="13:00"]').style.backgroundColor,
        '',
      );
    }
    assert.match(
      fs.readFileSync(path.join(root, 'src/server/http/security.cjs'), 'utf8'),
      /style-src 'self';/,
    );
  });
test('work and closed dates carry separate classes in month, mini month, mobile strip and week headings', (t) => {
  const f = fixture(t, { mode: 'month' });
  f.actions.scheduleDayKind = (date) =>
    date === '2026-10-05' ? 'working' : date === '2026-10-06' ? 'closed' : 'unset';
  f.render();
  assert.ok(f.$('[data-overview-date="2026-10-05"].calendar-day-working'));
  assert.ok(f.$('[data-overview-date="2026-10-06"].calendar-day-closed'));
  assert.ok(f.$('[data-overview-date="2026-10-07"].calendar-day-unset'));
  f.state.calendarMode = 'week';
  f.render();
  assert.ok(f.$('.month-day[data-calendar-date="2026-10-05"].calendar-day-working'));
  assert.ok(f.$('.date-chip[data-calendar-date="2026-10-06"].calendar-day-closed'));
  assert.ok(f.$('.time-day-heading.calendar-day-working'));
  assert.ok(f.$('.time-day-heading.calendar-day-closed'));
  assert.equal(f.$('.overview-day[style]'), null);
});

test('status priority: only completed is blue; elapsed confirmed/unconfirmed appointments require filing', (t) => {
  const f = fixture(t),
    appearance = (changes, clock = f.clock) =>
      f.actions.calendarAppointmentAppearance({ ...f.a, ...changes }, clock);
  assert.equal(appearance({}).state, 'scheduled');
  assert.equal(appearance({ telegramConfirmedAt: 123 }).state, 'confirmed');
  assert.equal(appearance({ confirmedAt: 123 }).state, 'confirmed');
  assert.equal(appearance({ manualConfirmedAt: 123 }).state, 'confirmed');
  for (const confirmation of [{}, { manualConfirmedAt: 123 }, { telegramConfirmedAt: 123 }]) {
    assert.equal(appearance({ ...confirmation, time: '09:00' }).state, 'unfiled');
    assert.equal(
      appearance({ ...confirmation, time: '10:00' }, { ...f.clock, hour: 10, minute: 59 }).state,
      confirmation.manualConfirmedAt || confirmation.telegramConfirmedAt
        ? 'confirmed'
        : 'scheduled',
    );
    assert.equal(appearance({ ...confirmation, time: '10:00' }).state, 'unfiled');
  }
  for (const [status, kind] of [
    ['completed', 'completed'],
    ['cancelled', 'cancelled'],
    ['no_show', 'no-show'],
  ])
    for (const time of ['09:00', '12:00'])
      assert.equal(appearance({ status, time, telegramConfirmedAt: 123 }).state, kind);
  assert.equal(
    appearance({ busy: true, status: 'completed', telegramConfirmedAt: 123 }).state,
    'busy',
  );
  assert.equal(appearance({ date: 'invalid' }).state, 'scheduled');
});
for (const mode of ['day', 'week', 'list'])
  test(
    'calendar ' +
      mode +
      ' uses states, readable labels and anonymous busy time without rewriting data',
    (t) => {
      const f = fixture(t, { mode }),
        records = [
          { ...f.a, id: 'scheduled' },
          { ...f.a, id: 'confirmed', time: '13:00', manualConfirmedAt: 123 },
          { ...f.a, id: 'unfiled', time: '09:00', telegramConfirmedAt: 123 },
          { ...f.a, id: 'completed', time: '08:00', status: 'completed' },
          { ...f.a, id: 'cancelled', time: '14:00', status: 'cancelled' },
          { ...f.a, id: 'no-show', time: '07:00', status: 'no_show' },
          {
            ...f.a,
            busy: true,
            id: 'private-busy',
            time: '15:00',
            patientName: 'PRIVATE NAME',
            service: 'PRIVATE SERVICE',
            telegramConfirmedAt: 123,
          },
        ];
      const before = JSON.stringify(records);
      f.render(records);
      for (const a of records.filter((a) => !a.busy)) {
        const event = f.$('[data-appointment-id="' + a.id + '"]');
        assert.equal(event.dataset.calendarState, a.id);
        assert.ok(event.classList.contains('appointment-state-' + a.id));
        assert.ok(
          event
            .getAttribute('aria-label')
            .includes(event.querySelector('[data-calendar-status]').textContent.replace(' · ', '')),
        );
        assert.equal(event.className.includes('appointment-color-'), false);
      }
      assert.equal(f.$('.calendar-status-legend'), null);
      assert.equal(f.$('.calendar-busy').hasAttribute('data-calendar-state'), false);
      assert.doesNotMatch(f.$('#root').innerHTML, /PRIVATE NAME|PRIVATE SERVICE|private-busy/);
      assert.equal(JSON.stringify(records), before);
      assert.equal(f.$('#draft').value, 'Не терять');
    },
  );
test('time tick updates colour, caption and accessible name at end boundary without replacing nodes or drafts', (t) => {
  const f = fixture(t, { mode: 'list' }),
    records = [
      { ...f.a, id: 'shared', patientId: 'p', time: '10:30', duration: 45, manualConfirmedAt: 1 },
      { ...f.a, id: 'shared', patientId: 'other', time: '13:00' },
      { ...f.a, id: 'completed', time: '09:00', status: 'completed' },
    ];
  f.render(records);
  const event = f.$('[data-calendar-patient="p"][data-appointment-id="shared"]'),
    other = f.$('[data-calendar-patient="other"]'),
    rootNode = f.$('#root').firstElementChild;
  assert.equal(event.dataset.calendarState, 'confirmed');
  f.clock.minute = 14;
  f.actions.updateCurrentTime();
  assert.equal(event.dataset.calendarState, 'confirmed');
  f.clock.minute = 15;
  f.actions.updateCurrentTime();
  assert.equal(event.dataset.calendarState, 'unfiled');
  assert.match(event.title, /Посещение не оформлено/);
  assert.match(event.querySelector('[data-calendar-status]').textContent, /Посещение не оформлено/);
  assert.equal(event.getAttribute('aria-label'), event.title);
  assert.equal(other.dataset.calendarState, 'scheduled');
  assert.equal(f.$('[data-appointment-id="completed"]').dataset.calendarState, 'completed');
  assert.equal(f.$('[data-calendar-patient="p"][data-appointment-id="shared"]'), event);
  assert.equal(f.$('#root').firstElementChild, rootNode);
  assert.equal(f.$('#draft').value, 'Не терять');
  assert.equal(records[0].status, undefined);
  records[1].manualConfirmedAt = 1;
  f.actions.updateCurrentTime();
  assert.equal(other.dataset.calendarState, 'confirmed');
  records[1].telegramConfirmedAt = 2;
  f.actions.updateCurrentTime();
  assert.match(other.title, /клиентом/);
  records[1].manualConfirmedAt = null;
  records[1].telegramConfirmedAt = null;
  f.actions.updateCurrentTime();
  assert.equal(other.dataset.calendarState, 'scheduled');
});
test('midnight and different device zones respect the cabinet clock, not browser local time or startsAt/upcoming', (t) => {
  const f = fixture(t),
    a = {
      ...f.a,
      date: '2026-10-05',
      time: '23:30',
      duration: 60,
      manualConfirmedAt: 1,
      startsAt: 1,
      upcoming: false,
    };
  const old = process.env.TZ;
  try {
    for (const device of ['Asia/Yerevan', 'America/New_York', 'Asia/Tokyo']) {
      process.env.TZ = device;
      assert.equal(
        f.actions.calendarAppointmentAppearance(
          a,
          zonedClock(Date.parse('2026-10-05T21:15:00Z'), 'Europe/Moscow'),
        ).state,
        'confirmed',
      );
      assert.equal(
        f.actions.calendarAppointmentAppearance(
          a,
          zonedClock(Date.parse('2026-10-05T21:30:00Z'), 'Europe/Moscow'),
        ).state,
        'unfiled',
      );
      assert.equal(
        f.actions.calendarAppointmentAppearance(
          a,
          zonedClock(Date.parse('2026-10-05T21:15:00Z'), 'Europe/Samara'),
        ).state,
        'unfiled',
      );
    }
  } finally {
    if (old === undefined) delete process.env.TZ;
    else process.env.TZ = old;
  }
});
test('calendar refresh skips unchanged rebuilds, protects open forms and drops stale account responses', async (t) => {
  const f = fixture(t),
    state = { ...f.state, lazyReads: true, account: { id: 'owner' }, calendarRecords: [] };
  let draws = 0,
    ticks = 0,
    reply = { appointments: [] },
    finish;
  const editor = f.w.document.createElement('dialog');
  editor.id = 'editor';
  f.w.document.body.append(editor);
  const actions = {
    ...f.actions,
    request: async () => reply,
    setView() {
      draws++;
    },
    updateCurrentTime() {
      ticks++;
    },
  };
  actions.readBackground = (url) => actions.request(url);
  f.w.eval(fs.readFileSync(path.join(root, 'src/client/core/cabinet-queries.js'), 'utf8'));
  const queries = f.w.createCabinetQueries(state, actions);
  await queries.loadCalendarRecords({ force: true });
  // Initial empty response establishes readiness and removes the loading state.
  assert.equal(queries.calendarRecordsReady(), true);
  assert.equal(draws, 1);
  reply = { appointments: [f.a] };
  await queries.loadCalendarRecords({ force: true });
  assert.equal(draws, 2);
  await queries.loadCalendarRecords({ force: true });
  assert.equal(draws, 2);
  editor.open = true;
  reply = { appointments: [{ ...f.a, manualConfirmedAt: 1 }] };
  await queries.loadCalendarRecords({ force: true });
  assert.equal(draws, 2);
  assert.equal(ticks, 1);
  assert.equal(editor.open, true);
  assert.equal(f.$('#draft').value, 'Не терять');
  actions.request = () =>
    new Promise((r) => {
      finish = r;
    });
  const pending = queries.loadCalendarRecords({ force: true });
  state.account.id = 'other';
  finish({ appointments: [{ ...f.a, patientName: 'wrong account' }] });
  await pending;
  assert.equal(state.calendarRecords[0].patientName, f.a.patientName);
});
