const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findAvailability,
  verifyAvailability,
  MAX_DATE_DAYS,
} = require('../src/server/modules/assistant/actions/availability.cjs');
const { nextDate } = require('../src/shared/work-schedule.cjs');
const DATE = '2030-01-02';
const NOW = Date.parse('2030-01-01T00:00:00Z');
function fixture({ role = 'owner', accountId = 'owner' } = {}) {
  const members = [
    { accountId: 'owner', displayName: 'Первый специалист', status: 'active', role: 'owner' },
    {
      accountId: 'second',
      displayName: 'Второй специалист',
      status: 'active',
      role: 'cosmetologist',
    },
  ];
  const services = [{ id: 'clean', name: 'Синтетическая услуга', duration: 30, staffId: 'owner' }];
  const appointments = [],
    reserves = [],
    personal = [],
    reads = [];
  const schedule = { days: {}, closures: {} };
  for (let offset = 0; offset < 31; offset++)
    schedule.days[nextDate(DATE, offset)] = { status: 'working', intervals: [['09:00', '18:00']] };
  const rooms = [
    {
      id: 'shared',
      name: 'Кабинет',
      active: true,
      staffIds: ['owner', 'second'],
      preventOverlap: true,
    },
  ];
  const c = {
    current: { organizationId: 'org', accountId, role },
    token: 'synthetic',
    assertCurrent() {},
    tenantStore() {
      return {
        readServices: () => services,
        indexes: {
          appointments(from, to, options) {
            assert.deepEqual(options, { includeNames: false });
            reads.push({ kind: 'appointments', from, to });
            return appointments;
          },
        },
      };
    },
    platform: {
      organizationTimeZone: () => 'Europe/Moscow',
      workspaceMembers: () => members,
      workspaceSettings() {
        reads.push({ kind: 'workspace' });
        return { enabled: false, rooms };
      },
      workSchedules: {
        view(token, id, from, to) {
          reads.push({ kind: 'schedule', id, from, to });
          return schedule;
        },
      },
      bookingRequests: {
        reserves(org, from, to) {
          reads.push({ kind: 'reserves', from, to });
          return reserves;
        },
      },
      personalEvents: {
        occupancy(org, from, to) {
          reads.push({ kind: 'personal', from, to });
          return personal;
        },
      },
    },
  };
  return { c, members, services, schedule, rooms, appointments, reserves, personal, reads };
}
function search(f, values = {}) {
  return findAvailability(
    f.c,
    { from: DATE, duration: 30, staffIds: ['owner'], serviceIds: ['clean'], ...values },
    NOW,
  );
}
function oneContext(reads, to = DATE) {
  for (const kind of ['appointments', 'reserves', 'personal', 'schedule', 'workspace'])
    assert.equal(reads.filter((row) => row.kind === kind).length, 1, kind);
  for (const kind of ['appointments', 'reserves', 'personal'])
    assert.deepEqual(
      reads.find((row) => row.kind === kind),
      { kind, from: '2030-01-01', to },
    );
  assert.deepEqual(
    reads.find((row) => row.kind === 'schedule'),
    { kind: 'schedule', id: 'owner', from: DATE, to },
  );
}

test('representative availability distributes the full valid day before truncation in one bounded read context', () => {
  const f = fixture();
  const result = search(f, { strategy: 'representative' });
  assert.deepEqual(
    result.slots.map((slot) => slot.time),
    ['09:00', '13:15', '17:30'],
  );
  assert.equal(result.availability.truncated, true);
  assert.equal(result.availability.from, DATE);
  assert.equal(result.availability.to, DATE);
  assert.equal(result.availability.timeZone, 'Europe/Moscow');
  for (const slot of result.slots) {
    assert.equal(slot.date, DATE);
    assert.deepEqual(slot.serviceIds, ['clean']);
    assert.equal(slot.roomId, 'shared');
  }
  assert.doesNotMatch(JSON.stringify(result), /patient|phone|synthetic/);
  oneContext(f.reads);
});

test('period bounds fit the complete appointment and more never repeats neighboring grid ticks', () => {
  const f = fixture();
  const first = search(f, { strategy: 'representative', time: '10:00', endTime: '12:00' });
  assert.deepEqual(
    first.slots.map((slot) => slot.time),
    ['10:00', '11:30'],
  );
  assert.equal(first.availability.truncated, false);
  const next = search(f, {
    strategy: 'representative',
    time: '10:00',
    endTime: '12:00',
    shownSlots: first.slots,
  });
  assert.deepEqual(next.slots, []);
  assert.equal(next.availability.truncated, false);
  assert.equal(
    search(f, { strategy: 'representative', time: '10:00', endTime: '11:00', duration: 90 }).slots
      .length,
    0,
  );
});

test('representative candidates respect appointments, reserves, personal time and shared rooms', () => {
  const f = fixture();
  f.schedule.days[DATE].intervals = [['09:00', '12:00']];
  f.appointments.push({ date: DATE, time: '09:30', duration: 30, staffId: 'owner' });
  f.reserves.push({
    date: DATE,
    time: '10:00',
    duration: 30,
    staffId: 'owner',
    status: 'pending',
    expiresAt: NOW + 1000,
  });
  f.personal.push({ date: DATE, time: '11:00', duration: 30, staffId: 'owner' });
  f.appointments.push({
    date: DATE,
    time: '11:30',
    duration: 30,
    staffId: 'second',
    roomId: 'shared',
  });
  const result = search(f, { strategy: 'representative' });
  assert.deepEqual(
    result.slots.map((slot) => slot.time),
    ['09:00', '10:30'],
  );
  assert.equal(result.availability.truncated, false);
  oneContext(f.reads);
});

test('fresh selection rechecks occupancy and exact admission remains valid for off-grid values and ignores display history', () => {
  const f = fixture();
  const before = search(f, { strategy: 'representative' });
  f.personal.push({ date: DATE, time: before.slots[0].time, duration: 30, staffId: 'owner' });
  const value = { ...before.slots[0], strategy: 'representative', shownSlots: before.slots };
  assert.equal(verifyAvailability(f.c, value, NOW), null);
  f.personal.length = 0;
  assert.equal(verifyAvailability(f.c, value, NOW).time, value.time);
  const nonGrid = { ...value, time: '09:10', endTime: '09:40' };
  assert.equal(verifyAvailability(f.c, nonGrid, NOW).time, '09:10');
  assert.equal(
    search(f, { strategy: 'representative', shownSlots: before.slots }).slots.some((slot) =>
      before.slots.some((old) => old.time === slot.time),
    ),
    false,
  );
});

test('date strategy returns distinct actual free dates instead of twelve starts on the first day', () => {
  const f = fixture();
  const to = nextDate(DATE, MAX_DATE_DAYS - 1);
  f.schedule.days[DATE].status = 'closed';
  f.schedule.closures[nextDate(DATE, 1)] = { status: 'closed' };
  const result = search(f, { strategy: 'dates', to });
  assert.deepEqual(
    result.slots.map((slot) => slot.date),
    [2, 3, 4].map((offset) => nextDate(DATE, offset)),
  );
  assert.deepEqual(
    result.slots.map((slot) => slot.time),
    ['09:00', '09:00', '09:00'],
  );
  assert.equal(result.availability.truncated, true);
  oneContext(f.reads, to);
});

test('date strategy respects full-fit period, duration and the seven-day horizon without an implicit next date', () => {
  const f = fixture();
  const to = nextDate(DATE, 6);
  for (let offset = 0; offset < 6; offset++)
    f.schedule.days[nextDate(DATE, offset)].intervals = [['09:00', '10:00']];
  const result = search(f, {
    strategy: 'dates',
    to,
    time: '10:00',
    endTime: '12:00',
    duration: 90,
  });
  assert.deepEqual(
    result.slots.map((slot) => [slot.date, slot.time, slot.endTime]),
    [[to, '10:00', '11:30']],
  );
  assert.equal(result.availability.truncated, false);
  oneContext(f.reads, to);
  assert.deepEqual(search(f, { strategy: 'representative', duration: 90 }).slots, []);
});

test('malformed strategies, long date scans and oversized history fail before occupancy reads', () => {
  const invalid = [
    { strategy: 'representative', to: nextDate(DATE) },
    { strategy: 'dates', to: nextDate(DATE, 7) },
    { strategy: 'unknown' },
    {
      strategy: 'representative',
      shownSlots: Array(13).fill({ date: DATE, time: '09:00', staffId: 'owner' }),
    },
    { strategy: 'representative', shownSlots: [{ date: DATE, time: '25:00', staffId: 'owner' }] },
  ];
  for (const values of invalid) {
    const f = fixture();
    assert.throws(() => search(f, values), { status: 400 });
    assert.deepEqual(f.reads, []);
  }
  const f = fixture({ role: 'cosmetologist', accountId: 'second' });
  assert.throws(() => search(f, { strategy: 'representative' }), { status: 403 });
  assert.deepEqual(f.reads, []);
});

test('default availability keeps the existing 31-day and twelve-start contract', () => {
  const f = fixture();
  const result = search(f, { to: nextDate(DATE, 30) });
  assert.equal(result.slots.length, 12);
  assert.equal(result.availability.truncated, true);
  assert.deepEqual(
    result.slots.slice(0, 3).map((slot) => slot.time),
    ['09:00', '09:15', '09:30'],
  );
  assert.ok(result.slots.every((slot) => slot.date === DATE));
});

test('nearest proposal respects the selected day, full service window and current occupancy', () => {
  const f = fixture();
  f.personal.push({ date: DATE, time: '10:00', duration: 30, staffId: 'owner' });
  const result = search(f, {
    strategy: 'representative',
    limit: 1,
    preferredTime: '10:15',
    time: '10:00',
    endTime: '12:00',
  });
  assert.deepEqual(
    result.slots.map((slot) => [slot.date, slot.time, slot.endTime]),
    [[DATE, '10:30', '11:00']],
  );
  const last = search(f, {
    strategy: 'representative',
    limit: 1,
    preferredTime: '17:00',
    time: '10:00',
    endTime: '12:00',
  });
  assert.deepEqual(
    last.slots.map((slot) => slot.time),
    ['11:30'],
  );
});

test('read-only day metadata distinguishes working, closed and missing days without listing grid starts', () => {
  const f = fixture();
  const result = search(f, { strategy: 'day' });
  assert.deepEqual(result.slots, []);
  assert.deepEqual(result.availability.dayInfo, {
    date: DATE,
    staffId: 'owner',
    status: 'working',
    workingIntervals: [['09:00', '18:00']],
    freeRanges: [['09:00', '18:00']],
    empty: true,
    remainingOnly: false,
  });
  oneContext(f.reads);
  f.schedule.closures[DATE] = { status: 'closed' };
  assert.equal(search(f, { strategy: 'day' }).availability.dayInfo.status, 'closed');
  assert.deepEqual(search(f, { strategy: 'day' }).availability.dayInfo.freeRanges, []);
  delete f.schedule.closures[DATE];
  f.schedule.days[DATE].status = 'closed';
  assert.equal(search(f, { strategy: 'day' }).availability.dayInfo.status, 'closed');
  delete f.schedule.days[DATE];
  const missing = search(f, { strategy: 'day' });
  assert.equal(missing.availability.dayInfo.status, 'missing');
  assert.equal(missing.availability.scheduleIncomplete, true);
  assert.deepEqual(missing.availability.dayInfo.freeRanges, []);
});

test('day ranges retain non-grid occupancy boundaries and never round a real gap to fifteen minutes', () => {
  const f = fixture();
  f.schedule.days[DATE].intervals = [['09:00', '10:00']];
  f.appointments.push({ date: DATE, time: '09:00', duration: 5, staffId: 'owner' });
  let day = search(f, { strategy: 'day' }).availability.dayInfo;
  assert.deepEqual(day.freeRanges, [['09:05', '10:00']]);
  assert.equal(day.empty, false);
  f.appointments[0].time = '09:05';
  day = search(f, { strategy: 'day', duration: 5 }).availability.dayInfo;
  assert.deepEqual(day.freeRanges, [
    ['09:00', '09:05'],
    ['09:10', '10:00'],
  ]);
});

test('day overview omits every gap shorter than the entire chosen service and respects explicit range', () => {
  const f = fixture();
  f.schedule.days[DATE].intervals = [['09:00', '12:00']];
  f.appointments.push(
    { date: DATE, time: '09:30', duration: 30, staffId: 'owner' },
    { date: DATE, time: '11:00', duration: 30, staffId: 'owner' },
  );
  assert.deepEqual(
    search(f, { strategy: 'day', duration: 90 }).availability.dayInfo.freeRanges,
    [],
  );
  assert.deepEqual(search(f, { strategy: 'day', duration: 60 }).availability.dayInfo.freeRanges, [
    ['10:00', '11:00'],
  ]);
  assert.deepEqual(
    search(f, { strategy: 'day', duration: 30, time: '10:15', endTime: '10:45' }).availability
      .dayInfo.freeRanges,
    [['10:15', '10:45']],
  );
  assert.deepEqual(
    search(f, { strategy: 'day', duration: 45, time: '10:15', endTime: '10:45' }).availability
      .dayInfo.freeRanges,
    [],
  );
});

test('day empty status includes personal time, pending reserves and another specialist in the shared room', () => {
  const f = fixture();
  f.schedule.days[DATE].intervals = [['09:00', '12:00']];
  f.personal.push({ date: DATE, time: '09:00', duration: 30, staffId: 'owner' });
  f.reserves.push({
    date: DATE,
    time: '10:00',
    duration: 30,
    staffId: 'owner',
    status: 'pending',
    expiresAt: NOW + 1000,
  });
  f.appointments.push({
    date: DATE,
    time: '11:00',
    duration: 30,
    staffId: 'second',
    roomId: 'shared',
  });
  const info = search(f, { strategy: 'day' }).availability.dayInfo;
  assert.equal(info.empty, false);
  assert.deepEqual(info.freeRanges, [
    ['09:30', '10:00'],
    ['10:30', '11:00'],
    ['11:30', '12:00'],
  ]);
  oneContext(f.reads);
});

test('cancelled bookings, expired reserves and another specialist personal events do not make the day busy', () => {
  const f = fixture();
  f.appointments.push({
    date: DATE,
    time: '09:00',
    duration: 60,
    staffId: 'owner',
    status: 'cancelled',
  });
  f.reserves.push({
    date: DATE,
    time: '09:00',
    duration: 60,
    staffId: 'owner',
    status: 'pending',
    expiresAt: NOW - 1,
  });
  f.personal.push({ date: DATE, time: '09:00', duration: 60, staffId: 'second' });
  const info = search(f, { strategy: 'day' }).availability.dayInfo;
  assert.equal(info.empty, true);
  assert.deepEqual(info.freeRanges, [['09:00', '18:00']]);
});

test('partly overlapping free rooms are not fused into a continuous room that cannot fit a longer visit', () => {
  const f = fixture();
  f.schedule.days[DATE].intervals = [['09:00', '11:00']];
  f.rooms.push({ ...f.rooms[0], id: 'other' });
  f.appointments.push(
    { date: DATE, time: '10:00', duration: 60, staffId: 'second', roomId: 'shared' },
    { date: DATE, time: '09:00', duration: 45, staffId: 'second', roomId: 'other' },
  );
  assert.deepEqual(search(f, { strategy: 'day' }).availability.dayInfo.freeRanges, [
    ['09:00', '10:00'],
    ['09:45', '11:00'],
  ]);
  assert.deepEqual(
    search(f, { strategy: 'day', duration: 90 }).availability.dayInfo.freeRanges,
    [],
  );
});

test('schedule breaks and adjacent separate work intervals are preserved rather than joined into a longer offer', () => {
  const f = fixture();
  f.schedule.days[DATE].intervals = [
    ['09:00', '10:00'],
    ['10:00', '11:00'],
    ['12:00', '14:00'],
  ];
  assert.deepEqual(search(f, { strategy: 'day' }).availability.dayInfo.freeRanges, [
    ['09:00', '10:00'],
    ['10:00', '11:00'],
    ['12:00', '14:00'],
  ]);
  assert.deepEqual(search(f, { strategy: 'day', duration: 90 }).availability.dayInfo.freeRanges, [
    ['12:00', '14:00'],
  ]);
  f.rooms.length = 0;
  const emptyRoom = search(f, { strategy: 'day' }).availability.dayInfo;
  assert.equal(emptyRoom.empty, false);
  assert.deepEqual(emptyRoom.freeRanges, []);
});

test('today overview clips elapsed organization time and marks that only the remainder is being shown', () => {
  const f = fixture();
  const values = {
    from: DATE,
    duration: 30,
    staffIds: ['owner'],
    serviceIds: ['clean'],
    strategy: 'day',
  };
  const info = findAvailability(f.c, values, Date.parse(DATE + 'T07:10:20Z')).availability.dayInfo;
  assert.equal(info.remainingOnly, true);
  assert.equal(info.empty, true);
  assert.deepEqual(info.freeRanges, [['10:11', '18:00']]);
  const past = findAvailability(f.c, values, Date.parse('2030-01-03T00:00:00Z')).availability
    .dayInfo;
  assert.deepEqual(past.freeRanges, []);
});

test('a DST spring gap is not announced as a real free hour and exact admission keeps its existing validation', () => {
  const f = fixture();
  const date = '2030-03-31';
  f.c.platform.organizationTimeZone = () => 'Europe/Berlin';
  f.schedule.days[date] = { status: 'working', intervals: [['00:00', '05:00']] };
  const values = {
    from: date,
    duration: 30,
    staffIds: ['owner'],
    serviceIds: ['clean'],
    strategy: 'day',
  };
  const info = findAvailability(f.c, values, NOW).availability.dayInfo;
  assert.deepEqual(info.freeRanges, [
    ['00:00', '02:00'],
    ['03:00', '05:00'],
  ]);
  assert.equal(
    verifyAvailability(
      f.c,
      { date, time: '02:30', duration: 30, staffId: 'owner', serviceIds: ['clean'] },
      NOW,
    ),
    null,
  );
});

test('read-only status never overrides strict closed-day or outside-working-hours admission', () => {
  const f = fixture();
  const value = {
    date: DATE,
    time: '09:30',
    duration: 30,
    staffId: 'owner',
    serviceIds: ['clean'],
  };
  f.schedule.closures[DATE] = { status: 'closed' };
  assert.equal(search(f, { strategy: 'day' }).availability.dayInfo.status, 'closed');
  assert.equal(verifyAvailability(f.c, value, NOW), null);
  delete f.schedule.closures[DATE];
  delete f.schedule.days[DATE];
  assert.equal(verifyAvailability(f.c, value, NOW), null);
  f.schedule.days[DATE] = { status: 'working', intervals: [['10:00', '12:00']] };
  assert.equal(verifyAvailability(f.c, value, NOW), null);
});

test('invalid read-only day context and preferred-time inputs fail before occupancy reads', () => {
  for (const values of [
    { strategy: 'day', to: nextDate(DATE) },
    { strategy: 'day', staffIds: ['owner', 'second'] },
    { strategy: 'representative', preferredTime: '25:00' },
  ]) {
    const f = fixture();
    assert.throws(() => search(f, values), { status: 400 });
    assert.deepEqual(f.reads, []);
  }
});

test('explicit closed-day draft confirmation admits only owner or salon administrator and never changes the stored graph', () => {
  for (const role of ['owner', 'salon_admin'])
    for (const cause of ['missing', 'closed', 'organization']) {
      const f = fixture({ role, accountId: role === 'owner' ? 'owner' : 'admin' });
      if (cause === 'missing') delete f.schedule.days[DATE];
      if (cause === 'closed') f.schedule.days[DATE].status = 'closed';
      if (cause === 'organization') f.schedule.closures[DATE] = { status: 'closed' };
      const before = structuredClone(f.schedule);
      const value = {
        date: DATE,
        time: '09:30',
        duration: 30,
        staffId: 'owner',
        serviceIds: ['clean'],
      };
      assert.equal(verifyAvailability(f.c, value, NOW), null);
      const result = verifyAvailability(f.c, { ...value, allowClosedDay: true }, NOW);
      assert.equal(result.time, '09:30');
      assert.equal(result.roomId, 'shared');
      assert.deepEqual(f.schedule, before);
      assert.throws(() => search(f, { strategy: 'day', allowClosedDay: true }), { status: 403 });
    }
  const employee = fixture({ role: 'cosmetologist', accountId: 'second' });
  assert.throws(
    () =>
      verifyAvailability(
        employee.c,
        { date: DATE, time: '09:30', duration: 30, staffId: 'second', allowClosedDay: true },
        NOW,
      ),
    { status: 403 },
  );
});

test('confirmed closed-day draft still rejects staff, personal, reserve and shared-room conflicts', () => {
  for (const cause of ['appointment', 'personal', 'reserve', 'room']) {
    const f = fixture();
    f.schedule.days[DATE].status = 'closed';
    const value = {
      date: DATE,
      time: '09:30',
      duration: 60,
      staffId: 'owner',
      serviceIds: ['clean'],
      allowClosedDay: true,
    };
    assert.ok(verifyAvailability(f.c, value, NOW));
    const block = { date: DATE, time: '09:45', duration: 15, staffId: 'owner' };
    if (cause === 'appointment') f.appointments.push(block);
    if (cause === 'personal') f.personal.push(block);
    if (cause === 'reserve')
      f.reserves.push({ ...block, status: 'pending', expiresAt: NOW + 1000 });
    if (cause === 'room') f.appointments.push({ ...block, staffId: 'second', roomId: 'shared' });
    assert.equal(verifyAvailability(f.c, value, NOW), null, cause);
  }
});

test('explicit schedule consent persists when a closed day gets working hours; ordinary admission follows fresh hours', () => {
  const f = fixture();
  delete f.schedule.days[DATE];
  const value = {
    date: DATE,
    time: '09:30',
    duration: 30,
    staffId: 'owner',
    serviceIds: ['clean'],
    allowClosedDay: true,
  };
  assert.ok(verifyAvailability(f.c, value, NOW));
  f.schedule.days[DATE] = { status: 'working', intervals: [['10:00', '12:00']] };
  assert.equal(verifyAvailability(f.c, value, NOW).time, '09:30');
  assert.equal(verifyAvailability(f.c, { ...value, allowClosedDay: false }, NOW), null);
  assert.equal(verifyAvailability(f.c, { ...value, time: '10:15' }, NOW).time, '10:15');
  f.members[0].status = 'suspended';
  assert.throws(() => verifyAvailability(f.c, value, NOW), { status: 403 });
});

test('confirmed closed-day drafts remain inside the chosen civil day, future time and available rooms', () => {
  const f = fixture();
  delete f.schedule.days[DATE];
  const value = {
    date: DATE,
    time: '23:30',
    duration: 30,
    staffId: 'owner',
    serviceIds: ['clean'],
    allowClosedDay: true,
  };
  assert.equal(verifyAvailability(f.c, value, NOW).endTime, '24:00');
  assert.equal(verifyAvailability(f.c, { ...value, time: '23:50' }, NOW), null);
  assert.equal(
    verifyAvailability(f.c, { ...value, time: '09:00' }, Date.parse(DATE + 'T12:00:00Z')),
    null,
  );
  f.rooms.length = 0;
  assert.equal(verifyAvailability(f.c, value, NOW), null);
});
