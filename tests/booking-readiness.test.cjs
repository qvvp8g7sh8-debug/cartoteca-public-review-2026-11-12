const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createFutureDays } = require('../src/server/modules/schedules/future-days.cjs');
const {
  bookingReadiness,
  privateBookingHealth,
  publicBookingHealth,
} = require('../src/server/modules/booking/readiness.cjs');
const { catalogProviders } = require('../src/server/modules/services/catalog.cjs');
const now = Date.parse('2030-01-01T00:00:00Z');
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(
    'CREATE TABLE work_schedule_days(organization_id TEXT,staff_id TEXT,date TEXT,value TEXT,PRIMARY KEY(organization_id,staff_id,date))',
  );
  const data = {
    members: [{ accountId: 'owner' }],
    services: [{ id: 's', duration: 30 }],
    settings: { mode: 'any', minimumLeadMinutes: 60, services: {} },
    workspace: { rooms: [{ id: 'main', active: true, preventOverlap: true, staffIds: ['owner'] }] },
    appointments: [],
    reservations: [],
    enabled: true,
    canManage: true,
  };
  const platform = {
    serviceCatalog: () => ({ ownerId: 'owner' }),
    withWriteLock: (fn) => fn(),
    withReadOnlySnapshot: (fn) => fn(),
    onlineBooking: {
      settings: () => data.settings,
      providers: (org, ids, catalog = data.services) =>
        catalogProviders(data.members, catalog, ids, 'owner'),
    },
    bookingPublication: {
      view: () => ({ canManage: data.canManage, enabled: data.enabled }),
      inspectView: () => ({
        publication: { canManage: data.canManage, enabled: data.enabled },
        needsLinks: false,
        needsReconcile: false,
      }),
      reconcileInTransaction: () => ({ canManage: data.canManage, enabled: data.enabled }),
    },
    workspaceSettings: () => data.workspace,
    organizationTimeZone: () => 'Europe/Moscow',
    workSchedules: { futureDays: createFutureDays({ db, open: JSON.parse }) },
    bookingRequests: { reserves: () => data.reservations },
  };
  const storage = {
    readServices: () => data.services,
    indexes: { appointments: () => data.appointments },
  };
  const context = {
    platform,
    token: 'synthetic',
    current: { organizationId: 'o' },
    tenantStore: () => storage,
  };
  const day = (
    date,
    staff = 'owner',
    status = 'working',
    intervals = [['09:00', '10:00']],
    org = 'o',
  ) =>
    db
      .prepare('INSERT OR REPLACE INTO work_schedule_days VALUES(?,?,?,?)')
      .run(org, staff, date, JSON.stringify({ status, intervals }));
  const health = () => bookingReadiness(platform, 'o', storage, now);
  const reason = () => health().issues.map((p) => p.code);
  return { data, context, platform, storage, day, health, reason };
}
test('no days is diagnostic only; adding a future day clears it without toggling publication', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.reason(), ['no_working_days']);
  assert.equal(privateBookingHealth(f.context, now).enabled, true);
  f.day('2030-01-02');
  assert.equal(f.health().available, true);
  assert.equal(f.health().nextDate, '2030-01-02');
  assert.equal(f.data.enabled, true);
});
test('distant explicit dates have no artificial horizon; other organizations and closed days are excluded', (t) => {
  const f = fixture(t);
  f.day('2030-01-01', 'owner', 'working', [['09:00', '10:00']], 'another');
  f.day('2030-01-01', 'hidden-staff');
  f.day('2030-01-02');
  f.day('2030-01-02', 'organization', 'closed', []);
  assert.deepEqual(f.reason(), ['no_working_days']);
  f.day('2040-02-03');
  assert.equal(f.health().nextDate, '2040-02-03');
});
test('busy, reserved, too short and lead-limited days are no_slots rather than missing schedule', (t) => {
  const f = fixture(t);
  f.day('2030-01-01');
  f.data.appointments = [
    { id: 'a', staffId: 'owner', roomId: 'main', date: '2030-01-01', time: '09:00', duration: 60 },
  ];
  assert.deepEqual(f.reason(), ['no_slots']);
  f.data.appointments = [];
  f.data.reservations = [
    {
      status: 'pending',
      expiresAt: now + 60000,
      staffId: 'owner',
      roomId: 'main',
      date: '2030-01-01',
      time: '09:00',
      duration: 60,
    },
  ];
  assert.deepEqual(f.reason(), ['no_slots']);
  f.data.reservations[0].expiresAt = now;
  assert.equal(f.health().available, true);
  f.day('2030-01-01', 'owner', 'working', [['09:00', '09:15']]);
  assert.deepEqual(f.reason(), ['no_slots']);
  f.day('2030-01-01');
  f.data.settings.minimumLeadMinutes = 1440;
  assert.deepEqual(f.reason(), ['no_slots']);
});
test('shared room and previous-day spillover still block admission-sized slots', (t) => {
  const f = fixture(t);
  f.day('2030-01-01', 'owner', 'working', [['04:00', '05:00']]);
  f.data.appointments = [
    { staffId: 'other', roomId: 'main', date: '2029-12-31', time: '23:00', duration: 360 },
  ];
  assert.deepEqual(f.reason(), ['no_slots']);
  f.data.appointments[0].status = 'cancelled';
  assert.equal(f.health().available, true);
});
test('multiple providers respect personal catalogs and rooms, without requiring every service to fit', (t) => {
  const f = fixture(t);
  f.data.members.push({ accountId: 'staff' });
  f.day('2030-01-02', 'staff');
  f.data.members = [{ accountId: 'staff' }];
  assert.deepEqual(f.reason(), ['no_assignments']);
  f.data.services[0].staffId = 'staff';
  assert.deepEqual(f.reason(), ['no_rooms']);
  f.data.workspace.rooms[0].staffIds.push('staff');
  f.data.services.push({ id: 'long', staffId: 'staff', duration: 120 });
  assert.equal(f.health().available, true);
  f.data.settings.mode = 'sequential';
  assert.equal(f.health().available, true);
});
test('disabled publication and employee access avoid reading cabinet contents; public health has no internal diagnostics', (t) => {
  const f = fixture(t);
  f.context.tenantStore = () => {
    throw Error('Must not read cabinet');
  };
  f.data.enabled = false;
  assert.deepEqual(privateBookingHealth(f.context, now).issues, []);
  f.data.enabled = true;
  f.data.canManage = false;
  assert.deepEqual(privateBookingHealth(f.context, now), { canManage: false });
  const publicHealth = publicBookingHealth(f.health());
  assert.deepEqual(Object.keys(publicHealth).sort(), [
    'available',
    'checkedAt',
    'nextDate',
    'reason',
  ]);
  assert.doesNotMatch(
    JSON.stringify(publicHealth),
    /staff|room|appointment|phone|intervals|target/,
  );
  f.data.members = [];
  f.data.services = [];
  assert.deepEqual(f.reason(), ['no_staff', 'no_services']);
});

test('a scheduled provider without a room is not misreported as missing working days', (t) => {
  const f = fixture(t);
  f.data.members.push({ accountId: 'staff' });
  f.data.services.push({ id: 'staff-service', staffId: 'staff', duration: 30 });
  f.day('2030-01-02', 'staff');
  assert.deepEqual(f.reason(), ['no_rooms']);
  f.day('2030-01-02', 'owner');
  f.data.appointments = [
    { staffId: 'owner', roomId: 'main', date: '2030-01-02', time: '09:00', duration: 60 },
  ];
  assert.deepEqual(f.reason(), ['no_slots', 'no_rooms']);
  f.data.workspace.rooms[0].staffIds.push('staff');
  f.data.workspace.rooms.push({ id: 'separate', active: true, staffIds: ['staff'] });
  assert.equal(f.health().available, true);
});
