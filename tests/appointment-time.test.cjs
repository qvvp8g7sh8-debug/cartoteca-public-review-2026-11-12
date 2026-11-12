const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { bookingWarning } = require('../src/shared/work-schedule.cjs');
const { createScheduleBooking } = require('../src/server/modules/schedules/booking.cjs');
const { fail } = require('../src/shared/errors.cjs');
const source = fs.readFileSync(
  require.resolve('../src/client/modules/appointment-availability.js'),
  'utf8',
);
const date = '2030-01-07';
const appointment = (time, duration = 60) => ({
  date,
  time,
  duration,
  staffId: 'owner',
  roomId: 'main',
});
const working = {
  status: 'working',
  intervals: [
    ['09:00', '12:00'],
    ['13:00', '18:00'],
  ],
};

test('interval hints distinguish beginning, ending, enclosure and exact boundaries', () => {
  const context = vm.createContext({ Date });
  vm.runInContext(source, context);
  const { appointmentIntervalConflict: conflict } = context.createAppointmentAvailability({}, {});
  const other = appointment('10:00');
  assert.match(conflict(appointment('10:30'), other), /Начало/);
  assert.match(conflict(appointment('09:30'), other), /Окончание/);
  assert.match(conflict(appointment('10:15', 15), other), /интервал попадает/);
  assert.match(conflict(appointment('09:30', 120), other), /включает другую/);
  assert.equal(conflict(appointment('09:00'), other), '');
  assert.equal(conflict(appointment('11:00'), other), '');
  assert.match(
    conflict(appointment('00:15'), { ...appointment('23:45'), date: '2030-01-06' }),
    /Начало/,
  );
});

test('manual schedule warnings cover the complete interval, unset days and midnight', () => {
  const warning = (a, day = working, closure = null) =>
    bookingWarning(
      a,
      () => day,
      () => closure,
      { warnUnset: true },
    );
  assert.equal(warning(appointment('11:00')), '');
  assert.match(warning(appointment('11:30')), /рабочие часы.*перерыв/);
  assert.match(warning(appointment('08:45')), /рабочие часы/);
  assert.match(warning(appointment('10:00'), { status: 'closed' }), /выходной/);
  assert.match(warning(appointment('10:00'), null), /не настроен/);
  assert.match(warning(appointment('10:00'), working, { status: 'closed' }), /Организация закрыта/);
  assert.equal(
    bookingWarning(
      appointment('10:00'),
      () => null,
      () => null,
    ),
    '',
  );
  const night = { status: 'working', intervals: [['00:00', '24:00']] };
  assert.match(
    bookingWarning(
      appointment('23:45'),
      (d) => (d === date ? night : null),
      () => null,
      { warnUnset: true },
    ),
    /не настроен/,
  );
});

test('unset-day acknowledgement remains actor-bound and restricted to owner/admin', () => {
  const store = { authorize() {}, day: () => null, profile: () => ({ revision: 1 }) };
  const policy = createScheduleBooking(
    { key: Buffer.alloc(32, 1), fail, organizationTimeZone: () => 'Europe/Moscow' },
    store,
  );
  const before = { patients: [] },
    after = {
      patients: [{ appointments: [{ ...appointment('10:00'), id: 'a', status: 'scheduled' }] }],
    };
  for (const role of ['owner', 'salon_admin']) {
    const current = { role, accountId: role, organizationId: 'synthetic-org' };
    const check = policy.check(current, after.patients[0].appointments[0]);
    assert.match(check.warning, /не настроен/);
    assert.equal(check.canOverride, true);
    assert.throws(() => policy.assertChanges(current, before, after), /Подтвердите/);
    assert.doesNotThrow(() => policy.assertChanges(current, before, after, check.acknowledgement));
  }
  const staff = { role: 'cosmetologist', accountId: 'owner', organizationId: 'synthetic-org' };
  assert.equal(policy.check(staff, after.patients[0].appointments[0]).canOverride, false);
  assert.throws(() => policy.assertChanges(staff, before, after), /администратору/);
});

test('live hint turns green/red without discarding selected time; overlap blocks preflight', async (t) => {
  const w = new JSDOM(
    '<form id="editor-form"><input name="staffId" value="owner">' +
      '<input name="roomId" id="appointment-room" value="main"><input name="date" value="' +
      date +
      '">' +
      '<select name="time"><option value="09:30" selected>09:30</option></select>' +
      '<input name="duration" value="30"></form><p id="appointment-room-status"></p>',
    { runScripts: 'outside-only' },
  ).window;
  t.after(() => w.close());
  const state = {
    multiUser: true,
    lazyReads: false,
    account: {},
    editorMode: { kind: 'appointment' },
    data: [{ appointments: [{ ...appointment('10:00'), id: 'other', status: 'scheduled' }] }],
  };
  const reads = [],
    actions = {
      $: (selector) => w.document.querySelector(selector),
      accountId: () => 'owner',
      appointmentOverlapRules: () => ({ staff: true, room: true }),
      appointmentRoomId: (a) => a.roomId,
      isActiveAppointment: (a) => a.status === 'scheduled',
      parseDate: (value) => new Date(value + 'T12:00:00Z'),
      isoDate: (value) => value.toISOString().slice(0, 10),
      readBackground: async (url) => {
        reads.push(url);
        return { busy: [] };
      },
    };
  w.eval(source);
  Object.assign(actions, w.createAppointmentAvailability(state, actions));
  await actions.refreshAppointmentRooms();
  const root = actions.$('#appointment-room-status');
  assert.ok(root.classList.contains('is-valid'));
  actions.$('[name=duration]').value = '60';
  await actions.refreshAppointmentRooms();
  assert.equal(root.textContent, 'Время занято');
  assert.match(root.title, /Окончание.*другую дату и время/);
  assert.ok(root.classList.contains('is-warning'));
  assert.equal(new w.FormData(actions.$('#editor-form')).get('time'), '09:30');
  await assert.rejects(actions.assertAppointmentAvailability(appointment('09:30')), /Окончание/);
  assert.match(reads[0], /from=2030-01-06&to=2030-01-08/);
  assert.equal(state.data[0].appointments.length, 1);
});
