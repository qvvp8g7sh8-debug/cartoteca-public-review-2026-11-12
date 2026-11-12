const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  findAvailability,
  verifyAvailability,
} = require('../src/server/modules/assistant/actions/availability.cjs');
const {
  appointmentContext,
  resolveService,
} = require('../src/server/modules/assistant/actions/availability-context.cjs');
const { handoff } = require('../src/server/modules/assistant/actions/actions.cjs');
const { nextDate } = require('../src/shared/work-schedule.cjs');
const NOW = Date.parse('2030-01-01T00:00:00Z');
const DATE = '2030-01-02';
const rules = { policy: { commands: { calendar: true, clients: true, prepareAppointment: true } } };
function fixture({ role = 'owner', accountId = 'owner' } = {}) {
  const members = [
    { accountId: 'owner', displayName: 'Анна Иванова', status: 'active', role: 'owner' },
    { accountId: 'second', displayName: 'Вера Орлова', status: 'active', role: 'cosmetologist' },
    { accountId: 'admin', displayName: 'Администратор', status: 'active', role: 'salon_admin' },
  ];
  const services = [
    { id: 'clean', name: 'Чистка', duration: 30 },
    { id: 'massage', name: 'Массаж', duration: 60, staffId: 'second' },
  ];
  const appointments = [],
    reserves = [],
    personal = [],
    reads = [];
  const rooms = [
    {
      id: 'shared',
      name: 'Общий',
      active: true,
      staffIds: ['owner', 'second'],
      preventOverlap: true,
    },
  ];
  const day = { status: 'working', intervals: [['09:00', '12:00']] };
  const schedules = new Map(
    members.slice(0, 2).map((m) => [
      m.accountId,
      {
        days: { [DATE]: structuredClone(day) },
        closures: {},
      },
    ]),
  );
  const storage = {
    readServices: () => services,
    indexes: {
      appointments(from, to, options) {
        reads.push({ kind: 'appointments', from, to, options });
        assert.deepEqual(options, { includeNames: false });
        return appointments;
      },
    },
  };
  const c = {
    current: { organizationId: 'org', accountId, role },
    token: 'synthetic-session',
    assertCurrent() {
      reads.push({ kind: 'assertCurrent' });
    },
    tenantStore(org) {
      assert.equal(org, 'org');
      return storage;
    },
    platform: {
      organizationTimeZone: () => 'Europe/Moscow',
      workspaceMembers: () => members,
      workspaceSettings: () => ({ enabled: false, rooms }),
      workSchedules: {
        view(token, id, from, to) {
          assert.equal(token, 'synthetic-session');
          reads.push({ kind: 'schedule', id, from, to });
          return schedules.get(id);
        },
      },
      bookingRequests: {
        reserves(org, from, to, now) {
          assert.equal(org, 'org');
          assert.equal(now, NOW);
          reads.push({ kind: 'reserves', from, to });
          return reserves;
        },
      },
      personalEvents: {
        occupancy(org, from, to) {
          assert.equal(org, 'org');
          reads.push({ kind: 'personal', from, to });
          return personal;
        },
      },
      onlineBooking: {
        settings() {
          throw Error('Public booking settings are irrelevant');
        },
      },
    },
  };
  return { c, members, services, appointments, reserves, personal, rooms, schedules, reads };
}
function search(f, extra = {}) {
  return findAvailability(f.c, { from: DATE, duration: 30, staffIds: ['owner'], ...extra }, NOW);
}
test('free-window calculation reuses schedules, all occupancy kinds and shared room constraints', () => {
  const f = fixture();
  f.appointments.push({ date: DATE, time: '09:30', duration: 30, staffId: 'owner' });
  f.reserves.push({
    date: DATE,
    time: '10:00',
    duration: 30,
    staffId: 'owner',
    status: 'pending',
    expiresAt: NOW + 60000,
  });
  f.personal.push({ date: DATE, time: '11:00', duration: 30, staffId: 'owner' });
  f.appointments.push({
    date: DATE,
    time: '11:30',
    duration: 30,
    staffId: 'second',
    roomId: 'shared',
  });
  const result = search(f);
  assert.deepEqual(
    result.slots.map((s) => s.time),
    ['09:00', '10:30'],
  );
  assert.equal(result.slots[0].endTime, '09:30');
  assert.equal(result.slots[0].roomId, 'shared');
  assert.equal(result.availability.timeZone, 'Europe/Moscow');
  assert.equal(f.reads.find((r) => r.kind === 'appointments').from, '2030-01-01');
  assert.doesNotMatch(JSON.stringify(result), /patient|phone|notes|synthetic-session/);
});
test('an organization closure, unset work day and absent physical room never yield offers', () => {
  const f = fixture(),
    saved = f.schedules.get('owner');
  saved.closures[DATE] = { status: 'closed' };
  assert.equal(search(f).slots.length, 0);
  saved.closures = {};
  delete saved.days[DATE];
  assert.equal(search(f).availability.scheduleIncomplete, true);
  saved.days[DATE] = { status: 'working', intervals: [['09:00', '12:00']] };
  f.rooms.length = 0;
  assert.equal(search(f).slots.length, 0);
});
test('cancelled appointments and expired reservations do not block; a prior-day spill does', () => {
  const f = fixture();
  f.appointments.push({
    date: DATE,
    time: '09:00',
    duration: 30,
    staffId: 'owner',
    status: 'cancelled',
  });
  f.reserves.push({
    date: DATE,
    time: '09:00',
    duration: 30,
    staffId: 'owner',
    status: 'pending',
    expiresAt: NOW - 1,
  });
  assert.equal(search(f).slots[0].time, '09:00');
  f.appointments.push({ date: '2030-01-01', time: '23:30', duration: 600 });
  assert.equal(search(f).slots[0].time, '09:30');
});
test('limits cover at most 31 inclusive days and return at most 12 suggestions', () => {
  const f = fixture();
  const saved = f.schedules.get('owner');
  for (let offset = 0; offset < 31; offset++)
    saved.days[nextDate(DATE, offset)] = { status: 'working', intervals: [['09:00', '18:00']] };
  const result = search(f, { to: nextDate(DATE, 30) });
  assert.equal(result.slots.length, 12);
  assert.equal(result.availability.truncated, true);
  assert.equal(f.reads.find((r) => r.kind === 'reserves').from, '2030-01-01');
  assert.throws(() => search(f, { to: nextDate(DATE, 31) }), { status: 400 });
  assert.throws(() => search(f, { to: '2030-01-01' }), { status: 400 });
});
test('time bounds apply to both start and full duration rather than offering an overflowing slot', () => {
  const f = fixture();
  const result = search(f, { time: '10:10', endTime: '11:00' });
  assert.deepEqual(
    result.slots.map((s) => s.time),
    ['10:15', '10:30'],
  );
  assert.throws(() => search(f, { time: '11:00', endTime: '10:00' }), { status: 400 });
});
test('exact admission recomputes a non-grid time and rejects fresh occupancy changes', () => {
  const f = fixture();
  const value = {
    date: DATE,
    time: '09:10',
    duration: 30,
    staffId: 'owner',
    serviceIds: ['clean'],
    roomId: 'shared',
  };
  assert.equal(verifyAvailability(f.c, value, NOW).time, '09:10');
  f.personal.push({ date: DATE, time: '09:15', duration: 5, staffId: 'owner' });
  assert.equal(verifyAvailability(f.c, value, NOW), null);
  f.personal.length = 0;
  f.members[0].status = 'suspended';
  assert.throws(() => verifyAvailability(f.c, value, NOW), { status: 403 });
});
test('service ownership and cosmetologist scope are enforced without exposing another catalog', () => {
  const f = fixture({ role: 'cosmetologist', accountId: 'second' });
  const context = appointmentContext(f.c);
  assert.deepEqual(
    context.members.map((m) => m.accountId),
    ['second'],
  );
  assert.deepEqual(
    context.services.map((s) => s.id),
    ['massage'],
  );
  assert.throws(() => search(f), { status: 403 });
  assert.throws(
    () =>
      findAvailability(
        f.c,
        {
          from: DATE,
          duration: 30,
          staffIds: ['second'],
          serviceIds: ['clean'],
        },
        NOW,
      ),
    { status: 400 },
  );
  assert.deepEqual(
    findAvailability(
      f.c,
      {
        from: DATE,
        duration: 60,
        staffIds: ['second'],
        serviceIds: ['massage'],
      },
      NOW,
    ).slots[0].serviceIds,
    ['massage'],
  );
});
test('service name matching is complete and case/yo tolerant, with ambiguity preserved', () => {
  const f = fixture();
  assert.equal(resolveService(f.services, '  ЧИСТКА  ').length, 1);
  assert.equal(resolveService(f.services, 'Чист').length, 0);
  f.services.push({ id: 'second-clean', name: 'Чистка', staffId: 'second', duration: 30 });
  assert.equal(resolveService(f.services, 'Чистка').length, 2);
});
test('calendar modes and helper command switches use the existing permission categories', () => {
  const f = fixture();
  for (const mode of ['day', 'week', 'month'])
    assert.deepEqual(handoff(f.c, { intent: 'calendar', date: DATE, mode }, rules, {}).action, {
      type: 'calendar',
      date: DATE,
      mode,
      staffId: 'owner',
    });
  const blocked = {
    policy: { commands: { calendar: false, clients: false, prepareAppointment: true } },
  };
  assert.throws(() => handoff(f.c, { intent: 'availability' }, blocked, {}), { status: 403 });
  assert.throws(() => handoff(f.c, { intent: 'clientCard', query: 'Анна' }, blocked, {}), {
    status: 403,
  });
});
function directoryFixture(rows, role = 'owner') {
  const f = fixture({ role, accountId: role === 'cosmetologist' ? 'second' : 'owner' });
  const original = f.c.tenantStore('org');
  const storage = {
    ...original,
    filename: 'synthetic-card-directory-' + randomUUID(),
    encode: (value) => Buffer.from(JSON.stringify(value)),
    decode: (value) => JSON.parse(value.toString()),
    get: () => 1,
    transaction: (callback) => callback(),
    indexes: {
      ...original.indexes,
      summaryRows(current) {
        return rows
          .filter((r) => current.role !== 'cosmetologist' || r.createdBy === current.accountId)
          .map((r) => ({ patient_id: r.id, value: Buffer.from(JSON.stringify(r)) }));
      },
    },
  };
  f.c.tenantStore = () => storage;
  return f;
}
test('opening a card uses only a unique ACL-visible identity and keeps card contents out of the result', () => {
  const row = {
    id: randomUUID(),
    firstName: 'Анна',
    lastName: 'Иванова',
    name: 'Анна Иванова',
    notes: 'Synthetic clinical note',
    appointments: [],
    createdBy: 'second',
  };
  const f = directoryFixture([row], 'cosmetologist');
  const result = handoff(f.c, { intent: 'clientCard', query: 'Анне Ивановой' }, rules, {});
  assert.deepEqual(result.action, { type: 'clientCard', patientId: row.id });
  assert.doesNotMatch(JSON.stringify(result), /Synthetic clinical|notes|appointments/);
  const hidden = directoryFixture([{ ...row, createdBy: 'owner' }], 'cosmetologist');
  assert.equal(
    handoff(hidden.c, { intent: 'clientCard', query: 'Анна Иванова' }, rules, {}).action,
    null,
  );
});
test('ambiguous card identities require clarification without list navigation', () => {
  const rows = ['Анна', 'Сергей'].map((firstName, index) => ({
    id: randomUUID(),
    firstName,
    lastName: index ? 'Иванов' : 'Иванова',
    name: firstName + ' ' + (index ? 'Иванов' : 'Иванова'),
    appointments: [],
  }));
  const f = directoryFixture(rows);
  const result = handoff(f.c, { intent: 'clientCard', query: 'Иванова' }, rules, {});
  assert.equal(result.action, null);
  assert.match(result.text, /Уточните полное имя или телефон/u);
});
