const { authContextHeaders } = require('./helpers/account-context.cjs');
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { createPlatformStore } = require('../platform-store.cjs');
const { createStorage } = require('../storage.cjs');
const { availableSlots } = require('../src/server/modules/booking/availability.cjs');
const { bookingPreview } = require('../src/server/modules/booking/preview.cjs');
const password = 'Synthetic-online-booking-password';
const date = '2030-01-01';
const defaults = (extra) => ({
  date,
  duration: 30,
  staff: [{ accountId: 's' }],
  dayAt: () => ({
    status: 'working',
    intervals: [
      ['09:00', '12:00'],
      ['13:00', '18:00'],
    ],
  }),
  workspace: {
    enabled: false,
    rooms: [{ id: 'r', active: true, preventOverlap: true, staffIds: ['s', 'other'] }],
  },
  now: Date.parse('2030-01-01T00:00:00Z'),
  ...extra,
});
test('public availability requires explicitly opened days, excludes closures, breaks and bad values', () => {
  assert.equal(availableSlots(defaults({ dayAt: () => null })).length, 0);
  assert.equal(availableSlots(defaults({ dayAt: () => ({ status: 'closed' }) })).length, 0);
  assert.equal(availableSlots(defaults({ closure: { status: 'closed' } })).length, 0);
  const slots = availableSlots(defaults());
  assert.equal(slots[0].time, '09:00');
  assert.equal(slots.at(-1).time, '17:30');
  assert.ok(!slots.some((s) => s.time > '11:30' && s.time < '13:00'));
  for (const extra of [
    { date: '2030-02-30' },
    { duration: 0 },
    { duration: 16 },
    { minimumLeadMinutes: -1 },
    { mode: 'bad' },
  ])
    assert.throws(() => availableSlots(defaults(extra)), { status: 400 });
});
test('sequential fills first fitting gap, handles missing starts and offers one time per staff', () => {
  const appointment = (time, duration) => ({ date, time, duration, staffId: 's', roomId: 'r' });
  const appointments = [appointment('09:00', 60), appointment('11:00', 60)];
  assert.deepEqual(
    availableSlots(defaults({ mode: 'sequential', appointments })).map((s) => s.time),
    ['10:00'],
  );
  assert.deepEqual(
    availableSlots(defaults({ mode: 'sequential', duration: 90, appointments })).map((s) => s.time),
    ['13:00'],
  );
  assert.equal(availableSlots(defaults({ mode: 'sequential' }))[0].time, '09:00');
  assert.equal(
    availableSlots(defaults({ mode: 'sequential', appointments: [appointment('09:00', 45)] }))[0]
      .time,
    '09:45',
  );
  const slots = availableSlots(
    defaults({
      mode: 'sequential',
      staff: [{ accountId: 's' }, { accountId: 'other' }],
      appointments,
    }),
  );
  assert.equal(slots.length, 2);
  assert.ok(slots.every((s) => s.time === '10:00'));
});

test('fourteen-day notice is accepted and excludes slots before the exact boundary', () => {
  const now = Date.parse('2029-12-18T06:00:00Z');
  const options = defaults({ now, minimumLeadMinutes: 20160, mode: 'sequential' });
  assert.equal(availableSlots(options)[0].time, '09:00');
  assert.equal(availableSlots({ ...options, now: now + 1 })[0].time, '09:15');
  assert.throws(() => availableSlots({ ...options, minimumLeadMinutes: 20161 }), { status: 400 });
});
test('staff and physical occupancy always apply, even when manual protection is disabled', () => {
  const appointment = { date, time: '09:00', duration: 60, staffId: 'other', roomId: 'r' };
  assert.equal(
    availableSlots(defaults({ mode: 'sequential', appointments: [appointment] }))[0].time,
    '10:00',
  );
  const rooms = [
    { id: 'r', active: true, preventOverlap: true, staffIds: ['s', 'other'] },
    { id: 'r2', active: true, preventOverlap: true, staffIds: ['s'] },
  ];
  assert.equal(
    availableSlots(
      defaults({ mode: 'sequential', workspace: { rooms }, appointments: [appointment] }),
    )[0].time,
    '09:00',
  );
  const own = { ...appointment, staffId: 's' };
  assert.equal(
    availableSlots(defaults({ mode: 'sequential', workspace: { rooms }, appointments: [own] }))[0]
      .time,
    '10:00',
  );
  const ambiguous = { ...appointment, roomId: undefined, staffId: 'unknown' };
  assert.equal(
    availableSlots(
      defaults({ mode: 'sequential', workspace: { rooms }, appointments: [ambiguous] }),
    )[0].time,
    '10:00',
  );
});
test('future reserves block slots; expired and arbitrary requests never hold time', () => {
  const now = Date.parse('2030-01-01T00:00:00Z');
  const reservation = {
    date,
    time: '09:00',
    duration: 60,
    staffId: 's',
    roomId: 'r',
    status: 'pending',
    expiresAt: now + 60000,
  };
  assert.equal(
    availableSlots(defaults({ mode: 'sequential', reservations: [reservation] }))[0].time,
    '10:00',
  );
  for (const r of [
    { ...reservation, expiresAt: now },
    { ...reservation, status: 'requested' },
  ])
    assert.equal(
      availableSlots(defaults({ mode: 'sequential', reservations: [r] }))[0].time,
      '09:00',
    );
});
test('organization timezone and minimum notice do not depend on device time; midnight occupancy is clipped', () => {
  const now = Date.parse('2030-01-01T06:30:00Z');
  assert.equal(
    availableSlots(defaults({ mode: 'sequential', now, minimumLeadMinutes: 60 }))[0].time,
    '10:30',
  );
  assert.equal(
    availableSlots(defaults({ mode: 'sequential', now, minimumLeadMinutes: 0 }))[0].time,
    '09:30',
  );
  const cross = { date: '2029-12-31', time: '23:00', duration: 600, staffId: 's', roomId: 'r' };
  assert.equal(
    availableSlots(defaults({ mode: 'sequential', appointments: [cross] }))[0].time,
    '09:00',
  );
  const crossing = { ...cross, duration: 660 };
  assert.equal(
    availableSlots(defaults({ mode: 'sequential', appointments: [crossing] }))[0].time,
    '10:00',
  );
});
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-online-booking-'));
  const platform = createPlatformStore(path.join(dir, 'platform')),
    storage = createStorage(path.join(dir, 'tenant'));
  t.after(() => {
    storage.close();
    platform.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const owner = await platform.registerOwner({
    email: 'owner@booking.test',
    password,
    displayName: 'Owner',
    organizationName: 'Synthetic',
  });
  platform.verifyEmail(owner.verificationToken);
  const ownerLogin = await platform.login('owner@booking.test', password),
    ownerToken = ownerLogin.token,
    contexts = new Map([[ownerToken, authContextHeaders(ownerLogin)]]);
  storage.write({
    revision: 0,
    patients: [],
    services: [
      { id: 's1', name: 'One', category: 'other', duration: '30 минут', price: 100 },
      { id: 's2', name: 'Two', category: 'other', duration: '60 минут', price: 200 },
    ],
  });
  const staff = {};
  for (const [key, role] of [
    ['staff', 'cosmetologist'],
    ['admin', 'salon_admin'],
  ]) {
    const invite = platform.createInvitation({
      organizationId: owner.organizationId,
      invitedBy: owner.accountId,
      role,
    });
    staff[key] = await platform.acceptInvitation({
      token: invite.token,
      email: key + '@booking.test',
      password,
      displayName: key,
    });
    const login = await platform.login(key + '@booking.test', password);
    staff[key].token = login.token;
    contexts.set(login.token, authContextHeaders(login));
  }
  const settings = () => platform.onlineBooking.view(ownerToken);
  const values = (extra = {}) => {
    const { revision, mode, minimumLeadMinutes, reservationMinutes, staff, services } = settings();
    return { revision, mode, minimumLeadMinutes, reservationMinutes, staff, services, ...extra };
  };
  return { dir, platform, storage, owner, ownerToken, contexts, staff, settings, values };
}
test('administrators manage booking settings but cannot become providers even through old metadata', async (t) => {
  const f = await fixture(t),
    admin = f.staff.admin.accountId;
  f.platform.onlineBooking.save(
    f.staff.admin.token,
    f.values({ staff: { [admin]: { enabled: true, manageOwnRequests: true } } }),
    new Set(['s1', 's2']),
  );
  const oldCatalog = f.storage.readServices().map((service) => ({ ...service, staffId: admin }));
  assert.deepEqual(
    f.platform.onlineBooking.providers(f.owner.organizationId, ['s1', 's2'], oldCatalog),
    [],
  );
  assert.equal(f.platform.onlineBooking.view(f.staff.admin.token).canManage, true);
});

test('settings are encrypted, scoped, revision guarded; owner and admin can disable staff permission', async (t) => {
  const f = await fixture(t),
    org = f.owner.organizationId,
    staff = f.staff.staff.accountId;
  assert.equal(f.settings().minimumLeadMinutes, 60);
  assert.equal(f.settings().reservationMinutes, 30);
  assert.equal(f.platform.onlineBooking.view(f.staff.staff.token).canManageOwnRequests, true);
  const values = f.values({ staff: { [staff]: { enabled: true, manageOwnRequests: false } } });
  f.platform.onlineBooking.save(f.staff.admin.token, values, new Set(['s1', 's2']));
  assert.throws(
    () => f.platform.onlineBooking.assertRequestPermission(f.staff.staff.token, staff),
    { status: 403 },
  );
  assert.equal(f.platform.onlineBooking.assertRequestPermission(f.ownerToken, staff).role, 'owner');
  assert.throws(() => f.platform.onlineBooking.save(f.ownerToken, values, new Set(['s1', 's2'])), {
    status: 409,
  });
  assert.throws(
    () => f.platform.onlineBooking.save(f.staff.staff.token, f.values(), new Set(['s1', 's2'])),
    { status: 403 },
  );
  assert.throws(
    () =>
      f.platform.onlineBooking.save(
        f.ownerToken,
        f.values({ services: { s1: ['foreign'] } }),
        new Set(['s1', 's2']),
      ),
    { status: 400 },
  );
  const row = f.platform.organization(org);
  assert.equal(row.onlineBooking.staff[staff].manageOwnRequests, false);
  assert.ok(
    !JSON.stringify(f.platform.onlineBooking.view(f.staff.staff.token)).includes(f.owner.accountId),
  );
});
test('personal catalog ownership overrides old assignments and remains with disabled owner', async (t) => {
  const f = await fixture(t),
    org = f.owner.organizationId,
    staff = f.staff.staff.accountId;
  f.platform.onlineBooking.save(
    f.ownerToken,
    f.values({ staff: { [staff]: { enabled: false, manageOwnRequests: true } } }),
    new Set(['s1', 's2']),
  );
  const catalog = f.storage.readServices();
  assert.deepEqual(
    f.platform.onlineBooking.providers(org, ['s1', 's2'], catalog).map((m) => m.accountId),
    [f.owner.accountId],
  );
  f.platform.onlineBooking.save(
    f.ownerToken,
    f.values({
      staff: { [staff]: { enabled: true, manageOwnRequests: true } },
      services: { s1: [staff], s2: [staff, f.owner.accountId] },
    }),
    new Set(['s1', 's2']),
  );
  assert.deepEqual(
    f.platform.onlineBooking.providers(org, ['s1', 's2'], catalog).map((m) => m.accountId),
    [f.owner.accountId],
  );
  const personal = catalog.map((s) => ({ ...s, staffId: staff }));
  assert.deepEqual(
    f.platform.onlineBooking.providers(org, ['s1', 's2'], personal).map((m) => m.accountId),
    [staff],
  );
  f.platform.onlineBooking.save(
    f.ownerToken,
    f.values({ staff: { [f.owner.accountId]: { enabled: false, manageOwnRequests: true } } }),
    new Set(['s1', 's2']),
  );
  assert.deepEqual(f.platform.onlineBooking.providers(org, ['s1', 's2'], catalog), []);
  assert.deepEqual(
    f.platform.onlineBooking.providers(org, ['s1', 's2'], personal).map((m) => m.accountId),
    [staff],
  );
});

test('managers can save fourteen-day notice but values above it are rejected without saving', async (t) => {
  const f = await fixture(t),
    services = new Set(['s1', 's2']);
  const saved = f.platform.onlineBooking.save(
    f.ownerToken,
    f.values({ minimumLeadMinutes: 20160 }),
    services,
  );
  assert.equal(saved.minimumLeadMinutes, 20160);
  assert.throws(
    () =>
      f.platform.onlineBooking.save(
        f.ownerToken,
        f.values({ minimumLeadMinutes: 20161 }),
        services,
      ),
    { status: 400 },
  );
  assert.equal(f.settings().revision, saved.revision);
  assert.equal(f.settings().minimumLeadMinutes, 20160);
});
test('preview combines canonical services without directory reads and exposes no patient information', async (t) => {
  const f = await fixture(t),
    org = f.owner.organizationId;
  f.platform.onlineBooking.save(
    f.ownerToken,
    f.values({ staff: { [f.staff.staff.accountId]: { enabled: false, manageOwnRequests: true } } }),
    new Set(['s1', 's2']),
  );
  f.platform.workSchedules.save(
    f.ownerToken,
    {
      staffId: f.owner.accountId,
      dates: [date],
      status: 'working',
      intervals: [['09:00', '18:00']],
      revision: 0,
      expectedTimeZone: 'Europe/Moscow',
    },
    f.storage,
  );
  f.storage.overview = () => {
    throw Error('must not scan patient directory');
  };
  const result = bookingPreview(
    f.platform,
    f.ownerToken,
    f.storage,
    { date, serviceIds: ['s1', 's2'] },
    Date.parse('2030-01-01T00:00:00Z'),
  );
  assert.equal(result.duration, 90);
  assert.equal(result.slots[0].time, '09:00');
  assert.deepEqual(Object.keys(result.slots[0]).sort(), [
    'date',
    'duration',
    'roomId',
    'staffId',
    'time',
  ]);
  assert.throws(
    () => bookingPreview(f.platform, f.ownerToken, f.storage, { date, serviceIds: ['s1', 's1'] }),
    { status: 400 },
  );
  assert.equal(
    bookingPreview(f.platform, f.staff.staff.token, f.storage, { date, serviceIds: ['s1'] }).slots
      .length,
    0,
  );
});
test('HTTP settings enforce session, organization role, CSRF and revision without exposing clients', async (t) => {
  const f = await fixture(t);
  const { createMultiServer } = require('../multi-server.cjs');
  const server = createMultiServer({
    dataDir: f.dir,
    sendMail: null,
    telegramBot: null,
    telegramAutostart: false,
    supportAutostart: false,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (token, body, headers = {}) =>
    fetch(base + '/api/online-booking/settings', {
      method: body ? 'POST' : 'GET',
      headers: {
        Origin: base,
        'X-Cartoteca-Request': '1',
        'Content-Type': 'application/json',
        Cookie: token ? 'cartoteca_v2_session=' + token : '',
        ...f.contexts.get(token),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    assert.equal((await request('')).status, 401);
    const own = await (await request(f.ownerToken)).json();
    assert.equal(own.canManage, true);
    assert.deepEqual(own.catalog, []);
    const staff = await (await request(f.staff.staff.token)).json();
    assert.equal(staff.canManage, false);
    assert.equal(staff.members.length, 1);
    assert.equal((await request(f.staff.staff.token, f.values())).status, 403);
    assert.equal(
      (await request(f.ownerToken, f.values(), { Origin: 'https://foreign.test' })).status,
      403,
    );
    const values = f.values({ reservationMinutes: 45 });
    assert.equal((await request(f.staff.admin.token, values)).status, 200);
    assert.equal((await request(f.ownerToken, values)).status, 409);
    const other = await f.platform.registerOwner({
      email: 'other@booking.test',
      password,
      displayName: 'Other',
      organizationName: 'Other',
    });
    f.platform.verifyEmail(other.verificationToken);
    const otherLogin = await f.platform.login('other@booking.test', password),
      otherToken = otherLogin.token;
    f.contexts.set(otherToken, authContextHeaders(otherLogin));
    assert.equal((await (await request(otherToken)).json()).reservationMinutes, 30);
    assert.equal(f.settings().reservationMinutes, 45);
    assert.equal(
      (await request(f.ownerToken, f.values({ organizationId: other.organizationId }))).status,
      400,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
