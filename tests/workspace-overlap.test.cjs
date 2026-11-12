const test = require('node:test');
const assert = require('node:assert/strict');
const {
  defaults,
  normalizeSettings,
  validateSettings,
  assertSchedule,
  busyIntervals,
} = require('../src/server/modules/workspace/policy.cjs');
const { availableSlots } = require('../src/server/modules/booking/availability.cjs');
const { assertReservationChanges } = require('../src/server/modules/booking/reservation-guard.cjs');
const { staffBlocksOverlap } = require('../src/server/modules/workspace/overlap.cjs');
const date = '2030-01-01';
const members = ['one', 'two'].map((accountId) => ({ accountId, status: 'active' }));
const staff = new Set(['one', 'two']);
const config = () => ({
  revision: 0,
  enabled: true,
  roomLayout: 'multiple',
  mode: 'shared',
  rooms: [
    {
      id: 'protected',
      name: 'Protected',
      active: true,
      staffMode: 'multiple',
      staffIds: [...staff],
      preventOverlap: true,
    },
    {
      id: 'parallel',
      name: 'Parallel',
      active: true,
      staffMode: 'multiple',
      staffIds: [...staff],
      preventOverlap: false,
    },
  ],
});
const appointment = (id, staffId, roomId) => ({
  id,
  staffId,
  roomId,
  date,
  time: '09:00',
  duration: 30,
});
const state = (...appointments) => ({ patients: [{ id: 'synthetic', appointments }] });
const check = (settings, ...appointments) =>
  assertSchedule(settings, state(...appointments), staff, 'Europe/Moscow', 0);

test('legacy owner projection preserves stored appointments and still rejects room conflicts and foreign staff', () => {
  const settings=defaults('one'), original={id:'legacy',date,time:'09:00',duration:30};
  const input=state(original),before=structuredClone(input);
  assertSchedule(settings,input,staff,'Europe/Moscow',0,'one');assert.deepEqual(input,before);
  assert.throws(()=>assertSchedule(settings,state(original,{...original,id:'second'}),staff,'Europe/Moscow',0,'one'),{status:409});
  assert.throws(()=>assertSchedule(settings,state({...original,staffId:'foreign'}),staff,'Europe/Moscow',0,'one'),{status:409});
  assert.throws(()=>assertSchedule(settings,input,new Set(['two']),'Europe/Moscow',0,'one'),{status:409});
});

test('individual staff rules override the legacy default and remain independent of room rules', () => {
  const settings = config();
  settings.enabled = false;
  settings.rooms.forEach((room) => {
    room.preventOverlap = false;
  });
  settings.staffRules = [
    { staffId: 'one', preventOverlap: true },
    { staffId: 'two', preventOverlap: false },
  ];
  assert.throws(
    () =>
      check(settings, appointment('a', 'one', 'protected'), appointment('b', 'one', 'parallel')),
    { status: 409 },
  );
  assert.doesNotThrow(() =>
    check(settings, appointment('a', 'two', 'protected'), appointment('b', 'two', 'parallel')),
  );
  settings.enabled = true;
  assert.doesNotThrow(() =>
    check(settings, appointment('a', 'two', 'protected'), appointment('b', 'two', 'parallel')),
  );
  settings.rooms[0].preventOverlap = true;
  assert.throws(
    () =>
      check(settings, appointment('a', 'two', 'protected'), appointment('b', 'two', 'protected')),
    { status: 409 },
  );
});

test('staff rule extension is read-only compatible and legacy writes preserve explicit rules', () => {
  for (const enabled of [false, true]) {
    const saved = { ...config(), enabled },
      before = structuredClone(saved);
    const normalized = normalizeSettings(saved);
    assert.equal(staffBlocksOverlap(normalized, 'one'), enabled);
    assert.deepEqual(saved, before);
  }
  const prior = config();
  prior.staffRules = [{ staffId: 'one', preventOverlap: false }];
  const saved = validateSettings({ ...config(), enabled: false }, members, prior, state());
  assert.deepEqual(saved.staffRules, prior.staffRules);
  assert.equal(staffBlocksOverlap(saved, 'two'), false);
  for (const staffRules of [
    null,
    [{ staffId: 'foreign', preventOverlap: true }],
    [{ staffId: 'one', preventOverlap: 'true' }],
    [
      { staffId: 'one', preventOverlap: true },
      { staffId: 'one', preventOverlap: false },
    ],
    [{ staffId: 'one', preventOverlap: true, ignored: 1 }],
  ]) {
    assert.throws(() => validateSettings({ ...config(), staffRules }, members, prior, state()), {
      status: 400,
    });
  }
});

test('per-room policy permits only the unchecked room while retaining the separate staff guard', () => {
  const settings = config();
  assert.doesNotThrow(() =>
    check(settings, appointment('a', 'one', 'parallel'), appointment('b', 'two', 'parallel')),
  );
  assert.throws(
    () =>
      check(settings, appointment('a', 'one', 'protected'), appointment('b', 'two', 'protected')),
    { status: 409 },
  );
  assert.throws(
    () =>
      check(settings, appointment('a', 'one', 'protected'), appointment('b', 'one', 'parallel')),
    { status: 409 },
  );
  settings.enabled = false;
  assert.throws(
    () =>
      check(settings, appointment('a', 'one', 'protected'), appointment('b', 'two', 'protected')),
    { status: 409 },
  );
  assert.doesNotThrow(() =>
    check(settings, appointment('a', 'one', 'protected'), appointment('b', 'one', 'parallel')),
  );
});

test('single-room default is protected; old saved switches remain read-only compatible and partial writes preserve room rules', () => {
  assert.equal(defaults('owner').rooms[0].preventOverlap, true);
  for (const enabled of [false, true]) {
    const original = { ...config(), enabled };
    original.rooms.forEach((room) => delete room.preventOverlap);
    const before = structuredClone(original),
      normalized = normalizeSettings(original);
    assert.deepEqual(
      normalized.rooms.map((room) => room.preventOverlap),
      [enabled, enabled],
    );
    assert.deepEqual(original, before);
  }
  const prior = config(),
    values = { ...config(), enabled: false };
  values.rooms.forEach((room) => delete room.preventOverlap);
  assert.deepEqual(
    validateSettings(values, members, prior, state()).rooms.map((r) => r.preventOverlap),
    [true, false],
  );
  const newSingle = {
    revision: 0,
    enabled: false,
    roomLayout: 'single',
    mode: 'shared',
    rooms: [values.rooms[0]],
  };
  assert.equal(
    validateSettings(newSingle, members, { revision: 0, rooms: [] }, state()).rooms[0]
      .preventOverlap,
    true,
  );
  newSingle.rooms[0].preventOverlap = 'false';
  assert.throws(() => validateSettings(newSingle, members, { revision: 0, rooms: [] }, state()), {
    status: 400,
  });
  const single = { ...config(), roomLayout: 'single', rooms: [config().rooms[1]] };
  assert.doesNotThrow(() =>
    check(single, appointment('a', 'one', 'parallel'), appointment('b', 'two', 'parallel')),
  );
});

test('anonymous occupancy contains only rooms that prohibit overlaps, even with staff protection off', () => {
  const settings = { ...config(), enabled: false };
  const busy = busyIntervals(
    settings,
    state(
      appointment('private-a', 'two', 'protected'),
      appointment('private-b', 'two', 'parallel'),
    ),
    { role: 'cosmetologist', accountId: 'one' },
    date,
    date,
  );
  assert.deepEqual(busy, [{ roomId: 'protected', date, time: '09:00', duration: 30 }]);
});

test('online slots and temporary reservations respect each room without allowing a double booking of the same provider', () => {
  const settings = config(),
    other = appointment('other', 'two', 'parallel');
  const values = {
    date,
    duration: 30,
    staff: [members[0]],
    dayAt: () => ({ status: 'working', intervals: [['09:00', '10:00']] }),
    workspace: settings,
    roomId: 'parallel',
    appointments: [other],
    now: 0,
    minimumLeadMinutes: 0,
  };
  assert.equal(availableSlots(values)[0].time, '09:00');
  assert.ok(
    !availableSlots({ ...values, appointments: [{ ...other, staffId: 'one' }] }).some(
      (s) => s.time === '09:00',
    ),
  );
  const reserve = { ...other, status: 'pending', expiresAt: 1000 };
  assert.equal(
    availableSlots({ ...values, appointments: [], reservations: [reserve] })[0].time,
    '09:00',
  );
  const platform = {
    organizationTimeZone: () => 'Europe/Moscow',
    workspaceSettings: () => settings,
    bookingRequests: { reserves: () => [reserve] },
  };
  const next = state(appointment('new', 'one', 'parallel'));
  assert.doesNotThrow(() => assertReservationChanges(platform, 'org', state(), next, 0));
  settings.rooms[1].preventOverlap = true;
  assert.ok(!availableSlots(values).some((s) => s.time === '09:00'));
  assert.throws(() => assertReservationChanges(platform, 'org', state(), next, 0), { status: 409 });
});
