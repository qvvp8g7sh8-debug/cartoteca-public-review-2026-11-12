// Prepared only; run during the next explicitly requested verification stage.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { validateState } = require('../src/server/modules/cabinet/validation.cjs');
const { bookingFixture } = require('./helpers/booking-fixture.cjs');
const { saveMutation } = require('../src/server/modules/cabinet/mutations.cjs');
const root = path.join(__dirname, '..');
const load = (name) => fs.readFileSync(path.join(root, 'src/client/modules', name + '.js'), 'utf8');
const timeLabel = (minute) =>
  String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
function ui() {
  const state = {
    multiUser: true,
    calendarMode: 'day',
    calendarGrouping: 'staff',
    selectedScheduleStaff: 'owner',
    selectedRoomId: '',
    calendarAnchorDate: new Date(2030, 0, 1),
    account: { id: 'owner' },
    workspace: { rooms: [{ id: 'main', active: true, staffIds: ['owner'] }] },
  };
  const actions = {
    accountId: () => 'owner',
    accountRole: () => 'owner',
    timeLabel,
    isoDate: () => '2030-01-01',
    parseDate: (date) => new Date(date + 'T00:00:00Z'),
    esc: (text) => String(text),
    formatMinutes: (minutes) => minutes + ' мин',
    cabinetClock: () => ({ date: '2029-12-01', hour: 0, minute: 0 }),
    appointmentConfirmationStatus: () => '',
    calendarScheduleMembers: () => [{ accountId: 'owner', displayName: 'Test' }],
    calendarEvents: () => [],
    roomName: () => '',
    scheduleDayLabel: () => '09:00–18:00',
    scheduleDayKind: () => 'working',
    scheduleSlotStyle: () => '',
  };
  const context = vm.createContext({ state, actions });
  for (const [name, factory] of [
    ['calendar-columns', 'createCalendarColumns'],
    ['calendar-week-scroll', 'createCalendarWeekScroll'],
    ['calendar', 'createCalendar'],
    ['calendar-time-grid', 'createCalendarTimeGrid'],
    ['appointments', 'createAppointments'],
  ]) {
    vm.runInContext(load(name) + '\nthis.feature=' + factory + '(state,actions);', context);
    Object.assign(actions, context.feature);
  }
  Object.assign(actions, require('../src/shared/patient-names.cjs').createPatientNames());
  vm.runInContext(load('form-validation') + '\nthis.validation=createFormValidation(state,actions);', context);
  return { state, actions, validation: context.validation, context };
}
test('a clicked hour offers twelve five-minute starts; other entry points retain the whole day', () => {
  const { actions } = ui();
  const draft = actions.calendarNewAppointment({
    dataset: { slotDate: '2030-01-01', slotTime: '11:00', slotStaff: 'owner' },
  });
  assert.equal(draft.timeHour, '11');
  assert.equal(draft.time, '11:00');
  assert.equal(draft.staffId, 'owner');
  const window = new JSDOM(
    '<select>' + actions.timeOptions(draft.time, draft.timeHour) + '</select>',
  ).window;
  try {
    assert.deepEqual(
      [...window.document.querySelectorAll('option')].map((o) => o.value),
      Array.from({ length: 12 }, (_, i) => timeLabel(660 + i * 5)),
    );
    assert.equal(window.document.querySelector('select').value, '11:00');
    const all = new JSDOM('<select>' + actions.timeOptions('23:55') + '</select>').window;
    try {
      assert.equal(all.document.querySelectorAll('option').length, 288);
      assert.equal(all.document.querySelector('select').value, '23:55');
    } finally {
      all.close();
    }
    const durations = new JSDOM('<select>' + actions.durationOptions(10) + '</select>').window;
    try {
      assert.deepEqual(
        [...durations.document.querySelectorAll('option')].map((o) => Number(o.value)),
        Array.from({ length: 36 }, (_, index) => (index + 1) * 5),
      );
      assert.equal(durations.document.querySelector('select').value, '10');
    } finally {
      durations.close();
    }
    assert.equal(actions.calendarNewAppointment().timeHour, undefined);
  } finally {
    window.close();
  }
});
test('calendar phones format domestic numbers without changing foreign contacts or exposing anonymous occupancy', () => {
  const { actions } = ui();
  for (const phone of ['89001234567', '+7 900 123 45 67', '9001234567'])
    assert.equal(actions.calendarClientPhone({ patientPhone: phone }), '+7 (900) 123-45-67');
  assert.equal(actions.calendarClientPhone({ patientPhone: '+374 99 123456' }), '+374 99 123456');
  assert.equal(actions.calendarClientPhone({}), '');
  assert.equal(actions.calendarClientPhone({ busy: true, patientPhone: '89001234567' }), '');
});

test('short cards keep actual duration and readable lanes without changing occupied time', () => {
  const { state, actions } = ui();
  const events = [5, 10, 15, 30, 60].map((duration, i) => ({
    id: 'a' + duration,
    patientId: 'p',
    patientName: 'Synthetic Name',
    patientPhone: '89001234567',
    staffId: 'owner',
    date: '2030-01-01',
    time: timeLabel(660 + i * 60),
    duration,
  }));
  const html = actions.calendarTimeGridHtml([state.calendarAnchorDate], events, 420);
  const window = new JSDOM(html).window;
  try {
    for (const duration of [5, 10, 15, 30, 60]) {
      const card = window.document.querySelector('[data-appointment-id=a' + duration + ']');
      assert.equal(Number(card.dataset.minutes), duration);
      assert.match(card.title, /\+7 \(900\) 123-45-67/);
      const phone = card.querySelector('.calendar-event-phone');
      assert.equal(Boolean(phone), duration >= 30);
      if (phone) assert.equal(phone.textContent, '+7 (900) 123-45-67');
      assert.equal(
        card.dataset.cardSize,
        duration < 15 ? 'micro' : duration < 30 ? 'tiny' : duration < 45 ? 'short' : 'roomy',
      );
      assert.equal(card.querySelector('.calendar-event-duration').textContent, duration + ' мин');
      assert.equal(
        card.querySelector('.calendar-event-short-duration').textContent,
        duration + ' мин',
      );
    }
    assert.match(
      window.document.querySelector('[data-appointment-id=a5] .calendar-event-time').textContent,
      /11:00–11:05/,
    );
    const adjacent = actions.layoutAppointments([
      { time: '11:00', duration: 5 },
      { time: '11:05', duration: 10 },
    ]);
    assert.equal(adjacent[0].end, 665);
    assert.equal(adjacent[1].end, 675);
    assert.notEqual(adjacent[0].lane, adjacent[1].lane);
    const css = fs.readFileSync(path.join(root, 'src/client/styles/calendar-columns.css'), 'utf8');
    assert.match(css, /data-card-size='micro'.*calendar-event-service/);
    assert.match(css, /data-card-size='tiny'.*calendar-event-short-duration/);
  } finally {
    window.close();
  }
});
test('micro-card centering follows the actual interval without changing its occupied height', () => {
  const { actions, context } = ui();
  const w = new JSDOM(
    '<section class="calendar-entity-board"><div class="time-head"></div><div class="calendar-entity-grid" data-first-minute="420"><div class="time-row"><div data-slot-time="10:00"><button class="calendar-event-positioned" data-card-size="micro" data-offset="10" data-minutes="5" data-lane="1" data-lanes="2"></button></div></div></div></section>',
  ).window;
  try {
    context.document = w.document;
    actions.$ = (selector) => w.document.querySelector(selector);
    actions.renderCalendarGaps = () => {};
    w.document.querySelector('.time-row').getBoundingClientRect = () => ({ height: 96 });
    actions.positionCalendarEvents();
    const card = w.document.querySelector('button');
    assert.equal(card.style.top, '11px');
    assert.equal(card.style.height, '8px');
    assert.equal(Number.parseFloat(card.style.top) + 18 / 2, (10 + 5 / 2) * 1.6);
  } finally {
    w.close();
  }
});

test('five-minute durations preserve service snapshots and completion links', () => {
  const { validation } = ui();
  const appointment = {
    id: 'a',
    date: '2030-01-01',
    time: '11:05',
    duration: 5,
    service: 'Synthetic',
  };
  const patient = { id: 'p', name: 'Synthetic', visits: [], appointments: [appointment] };
  const state = { revision: 0, services: [], patients: [patient] };
  for (const duration of [5, 10, 15, 20, 25, 30, 80, 1440]) {
    const values = { ...appointment, duration: String(duration) };
    assert.equal(validation.validateAppointmentValues(values), '');
    assert.equal(validation.validateVisitDuration(values), '');
    validateState({
      ...state,
      patients: [{ ...patient, appointments: [{ ...appointment, duration }] }],
    });
  }
  for (const duration of [0, 7, 21, 1441]) {
    assert.ok(validation.validateAppointmentValues({ ...appointment, duration: String(duration) }));
    assert.throws(
      () =>
        validateState({
          ...state,
          patients: [{ ...patient, appointments: [{ ...appointment, duration }] }],
        }),
      {
        status: 400,
        message: 'Длительность должна быть от 5 до 1440 минут с шагом 5 минут.',
      },
    );
  }
  assert.throws(
    () =>
      validateState({
        ...state,
        patients: [{ ...patient, appointments: [{ ...appointment, time: '11:03' }] }],
      }),
    { status: 400 },
  );
  for (const duration of [5, 10, 20, 80]) {
    assert.equal(
      validation.validateServiceValues({
        name: 'Synthetic',
        duration: String(duration),
        price: '0',
      }),
      '',
    );
    validateState({
          ...state,
          services: [{ id: 's', name: 'Synthetic', duration: duration + ' минут', price: 0 }],
        });
  }
  validateState({
    ...state,
    patients: [
      {
        ...patient,
        appointments: [{ ...appointment, status: 'completed', completedVisitId: 'v' }],
        visits: [
          {
            id: 'v',
            appointmentId: 'a',
            date: appointment.date,
            time: appointment.time,
            duration: 5,
            procedure: 'Synthetic',
            photos: [],
          },
        ],
      },
    ],
  });
});
test('the real manual mutation persists a five-minute appointment at a five-minute start', async (t) => {
  const f = await bookingFixture();
  t.after(f.close);
  const patient = {
    id: 'manual-short',
    name: 'Synthetic',
    createdBy: f.owner.accountId,
    visits: [],
    appointments: [
      {
        id: 'manual-short-a',
        date: f.date,
        time: '11:05',
        duration: 5,
        service: 'Тестовая услуга',
        staffId: f.owner.accountId,
        roomId: f.platform.workspaceSettings(f.org).rooms[0].id,
        status: 'scheduled',
      },
    ],
  };
  const current = f.platform.session(f.token);
  await saveMutation(
    {
      current,
      platform: f.platform,
      token: f.token,
      tenantStore: () => f.storage,
      assertCurrent() {
        assert.ok(f.platform.session(f.token));
      },
    },
    {
      revision: f.storage.read().revision,
      patients: [{ id: patient.id, before: null, after: patient }],
      services: [],
    },
    { partial: true },
  );
  const saved = f.storage.readSelected([patient.id]).patients[0].appointments[0];
  assert.equal(saved.time, '11:05');
  assert.equal(saved.duration, 5);
});
