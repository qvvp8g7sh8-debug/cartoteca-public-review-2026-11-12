const { authContextHeaders } = require('./helpers/account-context.cjs');
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { createPlatformStore } = require('../platform-store.cjs'),
  { createStorage } = require('../storage.cjs');
const {
  submitRequest,
  listRequests,
  requestSummary,
  rejectRequest,
} = require('../src/server/modules/booking/requests.cjs');
const { bookingPreview } = require('../src/server/modules/booking/preview.cjs');
const { saveMutation } = require('../src/server/modules/cabinet/mutations.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const { fork } = require('node:child_process');
const { acceptRequest } = require('../src/server/modules/booking/acceptance.cjs');
const { requestContacts } = require('../src/server/modules/booking/contacts.cjs');
const { requestTimeOptions } = require('../src/server/modules/booking/request-time.cjs');
const date = '2030-01-01',
  now = Date.parse(date + 'T00:00:00Z'),
  password = 'Synthetic-request-commands-password';
for (const duration of [10, 20, 80]) {
  test(`service duration ${duration} survives mutation, reservation and acceptance without rounding`, async (t) => {
    const f = await fixture(t),
      c = acceptanceContext(f);
    const before = f.storage.readServices()[0];
    await saveMutation(
      c,
      {
        revision: f.storage.read().revision,
        patients: [],
        services: [{ id: before.id, before, after: { ...before, duration: duration + ' минут' } }],
      },
      { partial: true },
    );
    const request = submitRequest(f.platform, f.token, f.storage, f.input(), now);
    assert.equal(request.duration, duration);
    await acceptRequest(c, { id: request.id, revision: 0 }, now);
    const appointment = f.storage.read().patients[0].appointments[0];
    assert.equal(appointment.duration, duration);
    assert.equal(appointment.serviceItems[0].duration, duration);
    assert.equal(appointment.time, '09:00');
    const next = bookingPreview(f.platform, f.token, f.storage, { date, serviceIds: ['s'] }, now);
    assert.ok(
      next.slots.every(
        (slot) => slot.time >= (duration === 80 ? '10:30' : duration === 20 ? '09:30' : '09:15'),
      ),
    );
  });
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-booking-commands-')),
    platform = createPlatformStore(path.join(dir, 'platform'));
  let storage;
  t.after(() => {
    storage?.close();
    platform.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const owner = await platform.registerOwner({
    email: 'owner@requests.test',
    password,
    displayName: 'Synthetic',
    organizationName: 'Synthetic',
  });
  platform.verifyEmail(owner.verificationToken);
  const login = await platform.login('owner@requests.test', password),
    token = login.token,
    contextHeaders = authContextHeaders(login);
  const invite = platform.createInvitation({
    organizationId: owner.organizationId,
    invitedBy: owner.accountId,
    role: 'cosmetologist',
  });
  const staff = await platform.acceptInvitation({
      token: invite.token,
      email: 'staff@requests.test',
      password,
      displayName: 'Staff',
    }),
    staffToken = (await platform.login('staff@requests.test', password)).token;
  storage = createStorage(path.join(dir, 'tenants', owner.organizationId));
  storage.write({
    revision: 0,
    patients: [],
    services: [{ id: 's', name: 'Synthetic service', duration: '30 минут', price: 120 }],
  });
  const settings = () => {
    const { revision, mode, minimumLeadMinutes, reservationMinutes, staff, services } =
      platform.onlineBooking.view(token);
    return { revision, mode, minimumLeadMinutes, reservationMinutes, staff, services };
  };
  platform.onlineBooking.save(
    token,
    { ...settings(), staff: { [staff.accountId]: { enabled: false, manageOwnRequests: true } } },
    new Set(['s']),
  );
  platform.workSchedules.save(
    token,
    {
      staffId: owner.accountId,
      dates: [date],
      status: 'working',
      intervals: [
        ['09:00', '12:00'],
        ['13:00', '24:00'],
      ],
      revision: 0,
      expectedTimeZone: 'Europe/Moscow',
    },
    storage,
  );
  const input = (extra = {}) => ({
    key: 'synthetic-request-key-0001',
    date,
    time: '09:00',
    serviceIds: ['s'],
    staffId: owner.accountId,
    kind: 'reserve',
    firstName: 'Synthetic',
    phone: '+79990000000',
    consent: true,
    ...extra,
  });
  return {
    dir,
    platform,
    owner,
    token,
    contextHeaders,
    staff,
    staffToken,
    storage,
    input,
    settings,
  };
}
function acceptanceContext(f, token = f.token) {
  return {
    current: f.platform.session(token),
    platform: f.platform,
    token,
    tenantStore: () => f.storage,
    assertCurrent() {},
  };
}

test('inbox summary follows list ACL and does not expose other employees changes', async (t) => {
  const f = await fixture(t),
    org = f.owner.organizationId;
  const ownerRequest = submitRequest(f.platform, f.token, f.storage, f.input(), now);
  f.platform.withWriteLock(() =>
    f.platform.bookingRequests.create(
      org,
      'synthetic-staff-summary',
      {
        date,
        time: '10:00',
        duration: 30,
        staffId: f.staff.accountId,
        kind: 'other-time',
        firstName: 'Private synthetic',
        phone: '+79990000001',
        services: [{ name: 'Private service' }],
      },
      30,
      now,
    ),
  );
  const own = requestSummary(f.platform, f.staffToken, now);
  assert.equal(own.count, 1);
  assert.equal(requestSummary(f.platform, f.token, now).count, 2);
  assert.equal(own.version, listRequests(f.platform, f.staffToken, null, now).version);
  assert.deepEqual(Object.keys(own).sort(), ['checkedAt', 'count', 'settingsRevision', 'version']);
  assert.throws(() => requestSummary(f.platform, 'invalid-session', now), { status: 403 });
  rejectRequest(f.platform, f.token, { id: ownerRequest.id, revision: 0 }, now, f.storage);
  assert.equal(requestSummary(f.platform, f.staffToken, now).version, own.version);
  assert.equal(requestSummary(f.platform, f.token, now).count, 1);
});

test('choosing another date creates one calendar appointment and hides the accepted request while retaining replay protection', async (t) => {
  const f = await fixture(t),
    org = f.owner.organizationId,
    c = acceptanceContext(f);
  f.platform.workSchedules.save(
    f.token,
    {
      staffId: f.owner.accountId,
      dates: ['2030-01-02'],
      status: 'working',
      intervals: [['09:00', '18:00']],
      revision: 1,
      expectedTimeZone: 'Europe/Moscow',
    },
    f.storage,
  );
  const r = submitRequest(f.platform, f.token, f.storage, f.input({ kind: 'other-time' }), now);
  assert.ok(requestTimeOptions(c, { id: r.id, date: '2030-01-02' }, now).times.includes('10:00'));
  assert.throws(
    () => requestTimeOptions(acceptanceContext(f, f.staffToken), { id: r.id, date }, now),
    { status: 403 },
  );
  const values = { id: r.id, revision: 0, date: '2030-01-02', time: '10:00' };
  const result = await acceptRequest(c, values, now);
  assert.equal(result.status, 'accepted');
  assert.equal(result.date, values.date);
  assert.equal(result.time, values.time);
  assert.deepEqual(result.originalWish, { date, time: '09:00' });
  assert.equal(listRequests(f.platform, f.token, null, now).items.length, 0);
  const saved = f.storage.read().patients[0].appointments;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].date, values.date);
  assert.equal(saved[0].time, values.time);
  assert.deepEqual(await acceptRequest(c, values, now), result);
  assert.equal(
    submitRequest(f.platform, f.token, f.storage, f.input({ kind: 'other-time' }), now).status,
    'accepted',
  );
  assert.equal(f.storage.read().patients[0].appointments.length, 1);
});

test('changed occupancy prevents chosen-time acceptance and rejection disappears from the list without renewing on retry', async (t) => {
  const f = await fixture(t),
    r = submitRequest(f.platform, f.token, f.storage, f.input(), now),
    c = acceptanceContext(f);
  const options = requestTimeOptions(c, { id: r.id, date }, now);
  assert.ok(options.times.includes('09:00'), 'own reserve does not block its original time');
  assert.ok(!options.times.includes('12:00'));
  const state = f.storage.read();
  f.storage.write({
    ...state,
    patients: [
      {
        id: 'occupied',
        name: 'Synthetic',
        createdBy: f.owner.accountId,
        visits: [],
        appointments: [
          {
            id: 'busy',
            date,
            time: '10:00',
            duration: 30,
            staffId: f.owner.accountId,
            roomId: r.roomId,
          },
        ],
      },
    ],
  });
  await assert.rejects(acceptRequest(c, { id: r.id, revision: 0, date, time: '10:00' }, now), {
    status: 409,
  });
  await assert.rejects(acceptRequest(c, { id: r.id, revision: 0, date }, now), { status: 400 });
  assert.equal(
    f.platform.bookingRequests.get(f.owner.organizationId, r.id, now).acceptance,
    undefined,
  );
  assert.equal(
    f.platform.bookingRequests.reserves(f.owner.organizationId, date, date, now).length,
    1,
  );
  const rejected = rejectRequest(f.platform, f.token, { id: r.id, revision: 0 }, now, f.storage);
  assert.deepEqual(
    rejectRequest(f.platform, f.token, { id: r.id, revision: 0 }, now, f.storage),
    rejected,
  );
  assert.equal(listRequests(f.platform, f.token, null, now).items.length, 0);
  assert.equal(
    f.platform.bookingRequests.reserves(f.owner.organizationId, date, date, now).length,
    0,
  );
  assert.equal(submitRequest(f.platform, f.token, f.storage, f.input(), now).status, 'rejected');
});

test('chosen-time crash recovery exposes the durable selected time and never recreates a committed appointment', async (t) => {
  const f = await fixture(t),
    r = submitRequest(f.platform, f.token, f.storage, f.input(), now),
    c = acceptanceContext(f);
  const values = { id: r.id, revision: 0, date, time: '11:00' },
    finish = f.platform.bookingRequests.finish;
  f.platform.bookingRequests.finish = () => {
    throw Error('Synthetic chosen-time crash');
  };
  await assert.rejects(acceptRequest(c, values, now), /chosen-time crash/);
  f.platform.bookingRequests.finish = finish;
  assert.equal(listRequests(f.platform, f.token, null, now).items[0].time, '11:00');
  const resumed = await acceptRequest(c, values, now);
  assert.equal(resumed.status, 'accepted');
  assert.equal(resumed.time, '11:00');
  assert.equal(listRequests(f.platform, f.token, null, now).items.length, 0);
  assert.equal(f.storage.read().patients[0].appointments.length, 1);
});
test('acceptance creates one scheduled visit with canonical services and durable replay', async (t) => {
  const f = await fixture(t),
    r = submitRequest(f.platform, f.token, f.storage, f.input(), now);
  const result = await acceptRequest(acceptanceContext(f), { id: r.id, revision: r.revision }, now);
  assert.equal(result.status, 'accepted');
  const state = f.storage.read();
  assert.equal(state.patients.length, 1);
  const p = state.patients[0];
  assert.equal(p.visits.length, 0);
  assert.equal(p.appointments.length, 1);
  assert.equal(p.appointments[0].serviceItems[0].duration, 30);
  assert.equal(p.appointments[0].status, 'scheduled');
  assert.deepEqual(
    await acceptRequest(acceptanceContext(f), { id: r.id, revision: r.revision }, now),
    result,
  );
  assert.equal(f.storage.read().patients.length, 1);
});
test('acceptance reconciles a crash after cabinet commit, even after the owner deletes the card', async (t) => {
  const f = await fixture(t),
    r = submitRequest(f.platform, f.token, f.storage, f.input(), now);
  const finish = f.platform.bookingRequests.finish;
  f.platform.bookingRequests.finish = () => {
    throw Error('Synthetic crash between database commits');
  };
  await assert.rejects(
    acceptRequest(acceptanceContext(f), { id: r.id, revision: 0 }, now),
    /Synthetic crash/,
  );
  f.platform.bookingRequests.finish = finish;
  assert.equal(f.storage.read().patients.length, 1);
  assert.equal(f.platform.bookingRequests.get(f.owner.organizationId, r.id, now).status, 'pending');
  assert.throws(
    () => rejectRequest(f.platform, f.token, { id: r.id, revision: 0 }, now, f.storage),
    { status: 409 },
  );
  const saved = f.storage.read();
  f.storage.write({ ...saved, patients: [] });
  assert.equal(
    (await acceptRequest(acceptanceContext(f), { id: r.id, revision: 0 }, now)).status,
    'accepted',
  );
  assert.equal(f.storage.read().patients.length, 0, 'recovery must never resurrect a deleted card');
});
test('acceptance matches 8/+7 phones, refuses ambiguous cards and never exposes foreign history', async (t) => {
  const f = await fixture(t),
    patient = {
      id: 'existing',
      name: 'Existing',
      phone: '89990000000',
      createdBy: f.owner.accountId,
      visits: [],
      appointments: [],
    };
  let state = f.storage.read();
  f.storage.write({ ...state, patients: [patient] });
  const r = submitRequest(f.platform, f.token, f.storage, f.input(), now);
  await acceptRequest(acceptanceContext(f), { id: r.id, revision: 0 }, now);
  assert.equal(f.storage.read().patients.length, 1);
  assert.equal(f.storage.read().patients[0].name, 'Existing');
  state = f.storage.read();
  f.storage.write({ ...state, patients: [...state.patients, { ...patient, id: 'ambiguous' }] });
  const second = submitRequest(
    f.platform,
    f.token,
    f.storage,
    f.input({ key: 'synthetic-ambiguous-key', time: '10:00' }),
    now,
  );
  assert.equal(requestContacts(acceptanceContext(f), second.id).items.length, 2);
  await assert.rejects(acceptRequest(acceptanceContext(f), { id: second.id, revision: 0 }, now), {
    status: 409,
  });
  await acceptRequest(
    acceptanceContext(f),
    { id: second.id, revision: 0, patientId: 'existing' },
    now,
  );
  assert.equal(f.storage.read().patients.length, 2);
});
test('expired reservation acceptance rechecks collisions even when manual overlap is allowed', async (t) => {
  const f = await fixture(t),
    r = submitRequest(f.platform, f.token, f.storage, f.input(), now);
  const later = now + 31 * 60000;
  let state = f.storage.read();
  f.storage.write({
    ...state,
    patients: [
      {
        id: 'occupied',
        name: 'Occupied',
        createdBy: f.owner.accountId,
        visits: [],
        appointments: [
          {
            id: 'occupied-a',
            date,
            time: '09:00',
            duration: 30,
            staffId: f.owner.accountId,
            roomId: r.roomId,
          },
        ],
      },
    ],
  });
  await assert.rejects(acceptRequest(acceptanceContext(f), { id: r.id, revision: 0 }, later), {
    status: 409,
  });
  assert.equal(f.storage.read().patients.length, 1);
});
test('acceptance checks staff permission again after asynchronous preparation', async (t) => {
  const f = await fixture(t);
  const personal = f.storage.read();
  f.storage.write({
    ...personal,
    services: personal.services.map((s) => ({ ...s, staffId: f.staff.accountId })),
  });
  f.platform.saveWorkspace(
    f.owner.organizationId,
    f.owner.accountId,
    {
      revision: 0,
      enabled: false,
      mode: 'shared',
      roomLayout: 'single',
      rooms: [
        {
          id: 'main',
          name: 'Main',
          active: true,
          staffMode: 'multiple',
          staffIds: [f.owner.accountId, f.staff.accountId],
        },
      ],
    },
    () => f.storage.read(),
  );
  f.platform.onlineBooking.save(
    f.token,
    {
      ...f.settings(),
      staff: {
        [f.owner.accountId]: { enabled: false, manageOwnRequests: true },
        [f.staff.accountId]: { enabled: true, manageOwnRequests: true },
      },
    },
    new Set(['s']),
  );
  f.platform.workSchedules.save(
    f.token,
    {
      staffId: f.staff.accountId,
      dates: [date],
      status: 'working',
      intervals: [['09:00', '18:00']],
      revision: 0,
      expectedTimeZone: 'Europe/Moscow',
    },
    f.storage,
  );
  const r = submitRequest(
    f.platform,
    f.staffToken,
    f.storage,
    f.input({ staffId: f.staff.accountId }),
    now,
  );
  const prepare = f.storage.prepareImages;
  f.storage.prepareImages = async (...args) => {
    const result = await prepare(...args);
    f.platform.onlineBooking.save(
      f.token,
      {
        ...f.settings(),
        staff: {
          [f.owner.accountId]: { enabled: false, manageOwnRequests: true },
          [f.staff.accountId]: { enabled: true, manageOwnRequests: false },
        },
      },
      new Set(['s']),
    );
    return result;
  };
  await assert.rejects(
    acceptRequest(acceptanceContext(f, f.staffToken), { id: r.id, revision: 0 }, now),
    { status: 403 },
  );
  assert.equal(f.storage.read().patients.length, 0);
});
test('acceptance refuses a contact owned by another employee without exposing or duplicating it', async (t) => {
  const f = await fixture(t);
  const personal = f.storage.read();
  f.storage.write({
    ...personal,
    services: personal.services.map((s) => ({ ...s, staffId: f.staff.accountId })),
  });
  f.platform.saveWorkspace(
    f.owner.organizationId,
    f.owner.accountId,
    {
      revision: 0,
      enabled: false,
      mode: 'shared',
      roomLayout: 'single',
      rooms: [
        {
          id: 'main',
          name: 'Main',
          active: true,
          staffMode: 'multiple',
          staffIds: [f.owner.accountId, f.staff.accountId],
        },
      ],
    },
    () => f.storage.read(),
  );
  let state = f.storage.read();
  f.storage.write({
    ...state,
    patients: [
      {
        id: 'foreign',
        name: 'Private',
        phone: '89990000000',
        createdBy: f.owner.accountId,
        visits: [],
        appointments: [],
      },
    ],
  });
  f.platform.onlineBooking.save(
    f.token,
    {
      ...f.settings(),
      staff: {
        [f.owner.accountId]: { enabled: false, manageOwnRequests: true },
        [f.staff.accountId]: { enabled: true, manageOwnRequests: true },
      },
    },
    new Set(['s']),
  );
  f.platform.workSchedules.save(
    f.token,
    {
      staffId: f.staff.accountId,
      dates: [date],
      status: 'working',
      intervals: [['09:00', '18:00']],
      revision: 0,
      expectedTimeZone: 'Europe/Moscow',
    },
    f.storage,
  );
  const r = submitRequest(
    f.platform,
    f.staffToken,
    f.storage,
    f.input({ staffId: f.staff.accountId }),
    now,
  );
  await assert.rejects(
    acceptRequest(acceptanceContext(f, f.staffToken), { id: r.id, revision: 0 }, now),
    { status: 403 },
  );
  assert.deepEqual(requestContacts(acceptanceContext(f, f.staffToken), r.id), {
    needsAdministrator: true,
    items: [],
  });
  assert.equal(f.storage.read().patients.length, 1);
  assert.equal(f.storage.read().patients[0].appointments.length, 0);
});
test('failed preparation releases its destination intent so a new matching card can be selected on retry', async (t) => {
  const f = await fixture(t),
    r = submitRequest(f.platform, f.token, f.storage, f.input(), now);
  const prepare = f.storage.prepareImages;
  f.storage.prepareImages = async () => {
    throw Error('Synthetic preparation failure');
  };
  await assert.rejects(
    acceptRequest(acceptanceContext(f), { id: r.id, revision: 0 }, now),
    /preparation failure/,
  );
  assert.equal(
    f.platform.bookingRequests.get(f.owner.organizationId, r.id, now).acceptance,
    undefined,
  );
  f.storage.prepareImages = prepare;
  const state = f.storage.read();
  f.storage.write({
    ...state,
    patients: [
      {
        id: 'created-between-retries',
        name: 'Existing',
        phone: '89990000000',
        createdBy: f.owner.accountId,
        visits: [],
        appointments: [],
      },
    ],
  });
  assert.equal(
    (await acceptRequest(acceptanceContext(f), { id: r.id, revision: 0 }, now)).status,
    'accepted',
  );
  assert.equal(f.storage.read().patients.length, 1);
  assert.equal(f.storage.read().patients[0].id, 'created-between-retries');
});
test('service price edits during asynchronous preparation are not silently saved as stale snapshots', async (t) => {
  const f = await fixture(t),
    r = submitRequest(f.platform, f.token, f.storage, f.input(), now),
    prepare = f.storage.prepareImages;
  f.storage.prepareImages = async (...args) => {
    const result = await prepare(...args),
      state = f.storage.read();
    f.storage.write({ ...state, services: state.services.map((s) => ({ ...s, price: 999 })) });
    return result;
  };
  await assert.rejects(acceptRequest(acceptanceContext(f), { id: r.id, revision: 0 }, now), {
    status: 409,
  });
  assert.equal(f.storage.read().patients.length, 0);
  assert.equal(
    f.platform.bookingRequests.get(f.owner.organizationId, r.id, now).acceptance,
    undefined,
  );
});
test('admission serializes availability and idempotency, derives canonical duration and blocks manual save', async (t) => {
  const f = await fixture(t),
    { platform, token, storage } = f;
  const result = submitRequest(platform, token, storage, f.input(), now);
  assert.equal(result.status, 'pending');
  assert.equal(result.duration, 30);
  assert.equal(result.services[0].name, 'Synthetic service');
  assert.ok(!JSON.stringify(result).includes('fingerprint'));
  assert.ok(!Object.hasOwn(result, 'patientId'));
  assert.deepEqual(submitRequest(platform, token, storage, f.input(), now + 1000), result);
  assert.throws(() => submitRequest(platform, token, storage, f.input({ time: '10:00' }), now), {
    status: 409,
  });
  assert.throws(
    () =>
      submitRequest(platform, token, storage, f.input({ key: 'synthetic-request-key-0002' }), now),
    { status: 409 },
  );
  assert.ok(
    !bookingPreview(platform, token, storage, { date, serviceIds: ['s'] }, now).slots.some(
      (s) => s.time === '09:00',
    ),
  );
  const patient = {
    id: 'p',
    name: 'Synthetic',
    createdBy: f.owner.accountId,
    visits: [],
    appointments: [
      {
        id: 'a',
        date,
        time: '09:00',
        duration: 30,
        staffId: f.owner.accountId,
        roomId: result.roomId,
      },
    ],
  };
  await assert.rejects(
    saveMutation(
      {
        current: platform.session(token),
        platform,
        token,
        tenantStore: () => storage,
        assertCurrent() {},
      },
      { revision: 0, patients: [{ id: 'p', before: null, after: patient }], services: [] },
      { partial: true },
    ),
    { status: 409 },
  );
  assert.equal(storage.read().patients.length, 0);
  rejectRequest(platform, token, { id: result.id, revision: 0 }, now);
  assert.ok(
    bookingPreview(platform, token, storage, { date, serviceIds: ['s'] }, now).slots.some(
      (s) => s.time === '09:00',
    ),
  );
});
test('other-time never holds time, permits a request inside the working day but excludes breaks and bad contacts', async (t) => {
  const f = await fixture(t),
    submit = (extra) => submitRequest(f.platform, f.token, f.storage, f.input(extra), now);
  const result = submit({ kind: 'other-time', time: '23:30' });
  assert.equal(result.status, 'requested');
  assert.equal(result.expiresAt, now + 86400000);
  assert.equal(
    f.platform.bookingRequests.reserves(f.owner.organizationId, date, date, now).length,
    0,
  );
  for (const extra of [
    { key: 'synthetic-other-time-key', kind: 'other-time', time: '12:00' },
    { consent: false },
    { duration: 120 },
    { phone: 'abc' },
    { time: '09:01' },
    { serviceIds: ['missing'] },
  ])
    assert.throws(
      () => submit(extra),
      (e) => [400, 409].includes(e.status),
    );
});
test('request listing is scoped and bounded; withdrawn staff permission blocks rejection at commit', async (t) => {
  const f = await fixture(t),
    org = f.owner.organizationId;
  const personal = f.storage.read();
  f.storage.write({
    ...personal,
    services: personal.services.map((s) => ({ ...s, staffId: f.staff.accountId })),
  });
  f.platform.onlineBooking.save(
    f.token,
    {
      ...f.settings(),
      staff: { [f.staff.accountId]: { enabled: true, manageOwnRequests: true } },
      services: { s: [f.staff.accountId, f.owner.accountId] },
    },
    new Set(['s']),
  );
  f.platform.workSchedules.save(
    f.token,
    {
      staffId: f.staff.accountId,
      dates: [date],
      status: 'working',
      intervals: [['09:00', '18:00']],
      revision: 0,
      expectedTimeZone: 'Europe/Moscow',
    },
    f.storage,
  );
  f.platform.saveWorkspace(
    org,
    f.owner.accountId,
    {
      revision: 0,
      enabled: false,
      mode: 'shared',
      roomLayout: 'single',
      rooms: [
        {
          id: 'main',
          name: 'Main',
          active: true,
          staffMode: 'multiple',
          staffIds: [f.owner.accountId, f.staff.accountId],
        },
      ],
    },
    () => f.storage.read(),
  );
  const result = submitRequest(
    f.platform,
    f.staffToken,
    f.storage,
    f.input({ staffId: f.staff.accountId }),
    now,
  );
  assert.equal(listRequests(f.platform, f.staffToken, null, now).items.length, 1);
  assert.throws(
    () =>
      submitRequest(
        f.platform,
        f.staffToken,
        f.storage,
        f.input({ key: 'synthetic-foreign-key' }),
        now,
      ),
    { status: 403 },
  );
  f.platform.onlineBooking.save(
    f.token,
    {
      ...f.settings(),
      staff: { [f.staff.accountId]: { enabled: true, manageOwnRequests: false } },
    },
    new Set(['s']),
  );
  assert.throws(
    () => rejectRequest(f.platform, f.staffToken, { id: result.id, revision: 0 }, now),
    { status: 403 },
  );
  rejectRequest(f.platform, f.token, { id: result.id, revision: 0 }, now);
  assert.equal(
    rejectRequest(f.platform, f.token, { id: result.id, revision: 0 }, now).status,
    'rejected',
  );
  assert.throws(
    () => rejectRequest(f.platform, f.staffToken, { id: result.id, revision: 0 }, now),
    { status: 403 },
  );
  f.platform.withWriteLock(() => {
    for (let i = 0; i < 52; i++)
      f.platform.bookingRequests.create(
        org,
        'synthetic-pagination-' + i,
        {
          date,
          time: '09:00',
          duration: 30,
          staffId: f.owner.accountId,
          roomId: 'main',
          kind: 'other-time',
        },
        30,
        now + i,
      );
  });
  const first = listRequests(f.platform, f.token, null, now),
    second = listRequests(f.platform, f.token, first.cursor, now);
  assert.equal(first.items.length, 50);
  assert.equal(second.items.length, 2);
  assert.equal(new Set([...first.items, ...second.items].map((r) => r.id)).size, 52);
  assert.equal(listRequests(f.platform, f.staffToken, null, now).items.length, 0);
});
test('HTTP request commands require authorization, CSRF and never grant global-only access', async (t) => {
  const f = await fixture(t),
    server = createMultiServer({
      dataDir: f.dir,
      telegramBot: null,
      supportBot: null,
      telegramAutostart: false,
      supportAutostart: false,
      sendMail: null,
    });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const contexts = new Map([['cartoteca_v2_session=' + f.token, f.contextHeaders]]);
  const call = (body, headers = {}, method = 'POST') =>
    fetch(base + '/api/online-booking/requests', {
      method,
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        'X-Cartoteca-Request': '1',
        ...contexts.get(headers.Cookie),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    assert.equal((await call(f.input())).status, 401);
    await f.platform.bootstrapGlobalAdmin({
      email: 'global@requests.test',
      password,
      displayName: 'Synthetic global',
    });
    const globalLogin = await f.platform.login('global@requests.test', password),
      globalToken = globalLogin.token;
    contexts.set('cartoteca_v2_session=' + globalToken, authContextHeaders(globalLogin));
    assert.equal(
      (await call(f.input(), { Cookie: 'cartoteca_v2_session=' + globalToken })).status,
      403,
    );
    const cookie = 'cartoteca_v2_session=' + f.token;
    assert.equal(
      (await call(f.input(), { Cookie: cookie, 'X-Cartoteca-Request': '' })).status,
      403,
    );
    const response = await call(f.input(), { Cookie: cookie });
    assert.equal(response.status, 200);
    const record = await response.json();
    assert.equal(record.status, 'pending');
    const list = await call(null, { Cookie: cookie }, 'GET');
    assert.equal(list.status, 200);
    assert.equal((await list.json()).items.length, 1);
    const timeOptions = (body, headers = {}) =>
      fetch(base + '/api/online-booking/requests/time-options', {
        method: 'POST',
        headers: {
          Origin: base,
          'Content-Type': 'application/json',
          'X-Cartoteca-Request': '1',
          ...contexts.get(headers.Cookie),
          ...headers,
        },
        body: JSON.stringify(body),
      });
    assert.equal((await timeOptions({ id: record.id, date })).status, 401);
    assert.equal(
      (
        await timeOptions(
          { id: record.id, date },
          { Cookie: 'cartoteca_v2_session=' + globalToken },
        )
      ).status,
      403,
    );
    assert.equal(
      (await timeOptions({ id: record.id, date }, { Cookie: cookie, 'X-Cartoteca-Request': '' }))
        .status,
      403,
    );
    assert.equal(
      (await timeOptions({ id: record.id, date, staffId: f.staff.accountId }, { Cookie: cookie }))
        .status,
      400,
    );
    const options = await timeOptions({ id: record.id, date }, { Cookie: cookie });
    assert.equal(options.status, 200);
    assert.ok((await options.json()).times.includes('09:00'));
    const accepted = await fetch(base + '/api/online-booking/requests/accept', {
      method: 'POST',
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        'X-Cartoteca-Request': '1',
        Cookie: cookie,
        ...f.contextHeaders,
      },
      body: JSON.stringify({ id: record.id, revision: 0 }),
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).status, 'accepted');
    assert.equal((await call(null, { Cookie: cookie }, 'GET')).status, 200);
    assert.equal((await timeOptions({ id: record.id, date }, { Cookie: cookie })).status, 409);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
test('independent workers reserve one slot once and refuse a competing request', async (t) => {
  const f = await fixture(t),
    root = createStorage(f.dir);
  root.close();
  const children = [];
  const spawn = () =>
    new Promise((resolve, reject) => {
      const child = fork(path.join(__dirname, 'helpers/process-server.cjs'), [f.dir], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      children.push(child);
      const timer = setTimeout(() => {
        child.kill();
        reject(Error('Synthetic worker timeout'));
      }, 10000);
      child.on('message', (message) => {
        if (Number.isInteger(message.port)) {
          clearTimeout(timer);
          resolve('http://127.0.0.1:' + message.port);
        }
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  try {
    const bases = [await spawn(), await spawn()];
    const send = (base, key) =>
      fetch(base + '/api/online-booking/requests', {
        method: 'POST',
        headers: {
          Origin: base,
          'Content-Type': 'application/json',
          'X-Cartoteca-Request': '1',
          Cookie: 'cartoteca_v2_session=' + f.token,
          ...f.contextHeaders,
        },
        body: JSON.stringify(f.input({ key })),
      });
    const responses = await Promise.all(
      bases.map((base) => send(base, 'synthetic-parallel-request')),
    );
    assert.deepEqual(
      responses.map((r) => r.status),
      [200, 200],
    );
    const records = await Promise.all(responses.map((r) => r.json()));
    assert.equal(records[0].id, records[1].id);
    assert.equal((await send(bases[1], 'synthetic-competing-request')).status, 409);
    assert.equal(listRequests(f.platform, f.token).items.length, 1);
    const accept = (base) =>
      fetch(base + '/api/online-booking/requests/accept', {
        method: 'POST',
        headers: {
          Origin: base,
          'Content-Type': 'application/json',
          'X-Cartoteca-Request': '1',
          Cookie: 'cartoteca_v2_session=' + f.token,
          ...f.contextHeaders,
        },
        body: JSON.stringify({ id: records[0].id, revision: 0 }),
      });
    const accepted = await Promise.all(bases.map(accept));
    assert.ok(accepted.some((r) => r.status === 200));
    assert.ok(accepted.every((r) => [200, 409].includes(r.status)));
    assert.equal((await accept(bases[1])).status, 200);
    assert.equal(f.storage.read().patients.length, 1);
    assert.equal(f.storage.read().patients[0].appointments.length, 1);
  } finally {
    await Promise.all(
      children.map(
        (child) =>
          new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            child.once('exit', resolve);
            child.send('stop');
          }),
      ),
    );
  }
});
