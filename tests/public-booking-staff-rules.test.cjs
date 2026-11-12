const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPlatformStore } = require('../platform-store.cjs');
const { createStorage } = require('../storage.cjs');
const {
  publicInfo,
  publicAvailability,
  publicSubmit,
} = require('../src/server/modules/booking/public-service.cjs');
const { acceptRequest } = require('../src/server/modules/booking/acceptance.cjs');
const { PRIVACY_VERSION } = require('../src/shared/privacy-consent.cjs');

const date = '2030-01-02',
  now = Date.parse(date + 'T00:00:00Z');
const password = 'Synthetic-staff-rules-password';
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-staff-booking-'));
  const platform = createPlatformStore(path.join(dir, 'platform'));
  let storage;
  t.after(() => {
    storage?.close();
    platform.close();
    const target = path.resolve(dir);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('cartoteca-staff-booking-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  const owner = await platform.registerOwner({
    email: 'owner@staff-booking.test',
    password,
    displayName: 'Synthetic owner',
    organizationName: 'Synthetic organization',
  });
  platform.verifyEmail(owner.verificationToken);
  const invite = platform.createInvitation({
    organizationId: owner.organizationId,
    invitedBy: owner.accountId,
    role: 'cosmetologist',
  });
  const member = await platform.acceptInvitation({
    token: invite.token,
    email: 'member@staff-booking.test',
    password,
    displayName: 'Synthetic member',
  });
  const token = (await platform.login('owner@staff-booking.test', password)).token;
  const org = owner.organizationId;
  storage = createStorage(path.join(dir, 'tenants', org));
  storage.write({
    revision: 0,
    services: [
      {
        id: 'owner-service',
        name: 'Owner service',
        duration: '30 минут',
        price: 100,
        staffId: owner.accountId,
      },
      {
        id: 'member-service',
        name: 'Member service',
        duration: '30 минут',
        price: 100,
        staffId: member.accountId,
      },
    ],
    patients: [
      {
        id: 'occupied',
        name: 'Synthetic occupied',
        createdBy: owner.accountId,
        visits: [],
        appointments: [
          {
            id: 'occupied-appointment',
            date,
            time: '09:00',
            duration: 50,
            staffId: owner.accountId,
            roomId: 'main',
            status: 'scheduled',
            service: 'Synthetic',
          },
        ],
      },
    ],
  });
  const workspace = platform.workspaceSettings(org);
  platform.saveWorkspace(
    org,
    owner.accountId,
    {
      revision: workspace.revision,
      enabled: true,
      mode: 'separate',
      roomLayout: 'multiple',
      staffRules: [],
      rooms: [
        ...workspace.rooms,
        {
          id: 'member-room',
          name: 'Synthetic member room',
          active: true,
          preventOverlap: true,
          staffMode: 'single',
          staffIds: [member.accountId],
        },
      ],
    },
    () => storage.read(),
  );
  for (const staffId of [owner.accountId, member.accountId]) {
    const revision = platform.workSchedules.view(token, staffId, date, date).revision;
    platform.workSchedules.save(
      token,
      {
        staffId,
        dates: [date],
        status: 'working',
        intervals: [['09:00', '13:00']],
        revision,
        expectedTimeZone: 'Europe/Moscow',
      },
      storage,
    );
  }
  function save(overrides = {}) {
    const {
      revision,
      mode,
      bookingMode,
      minimumLeadMinutes,
      reservationMinutes,
      showPrices,
      staff,
      services,
    } = platform.onlineBooking.view(token);
    return platform.onlineBooking.save(
      token,
      {
        revision,
        mode,
        bookingMode,
        minimumLeadMinutes,
        reservationMinutes,
        showPrices,
        staff,
        services,
        ...overrides,
      },
      new Set(['owner-service', 'member-service']),
    );
  }
  save({
    staff: {
      [owner.accountId]: {
        enabled: true,
        manageOwnRequests: true,
        mode: 'sequential',
        bookingMode: 'classic',
      },
      [member.accountId]: {
        enabled: true,
        manageOwnRequests: true,
        mode: 'any',
        bookingMode: 'approval',
      },
    },
  });
  platform.bookingPublication.save(token, {
    enabled: true,
    revision: platform.bookingPublication.view(token).revision,
  });
  const context = {
    platform,
    tenantStore: () => storage,
    clientAddress: () => 'synthetic-staff-client',
    req: {},
  };
  const info = () => publicInfo(context, org, now);
  const input = (staffId, extra = {}) => ({
    key: info().challenge,
    date,
    time: staffId === owner.accountId ? '09:50' : '10:30',
    serviceIds: [staffId === owner.accountId ? 'owner-service' : 'member-service'],
    staffId,
    kind: 'reserve',
    bookingMode: staffId === owner.accountId ? 'classic' : 'approval',
    firstName: 'Synthetic',
    phone: staffId === owner.accountId ? '+79990000101' : '+79990000102',
    consent: true,
    privacyConsentVersion: PRIVACY_VERSION,
    ...extra,
  });
  const available = (staffId) =>
    publicAvailability(
      context,
      org,
      {
        date,
        staffId,
        serviceIds: [staffId === owner.accountId ? 'owner-service' : 'member-service'],
      },
      now,
    );
  const appointments = () =>
    storage.read().patients.flatMap((patient) => patient.appointments || []);
  return {
    platform,
    storage,
    owner,
    member,
    token,
    org,
    context,
    save,
    info,
    input,
    available,
    appointments,
  };
}

test('one public organization exposes independent effective rules without management permissions', async (t) => {
  const f = await fixture(t),
    info = f.info();
  assert.equal(info.members.find((m) => m.id === f.owner.accountId).rules.bookingMode, 'classic');
  assert.equal(info.members.find((m) => m.id === f.member.accountId).rules.bookingMode, 'approval');
  assert.equal(JSON.stringify(info.members).includes('manageOwnRequests'), false);
  const owner = f.available(f.owner.accountId),
    member = f.available(f.member.accountId);
  assert.equal(owner.mode, 'sequential');
  assert.equal(owner.rules.bookingMode, 'classic');
  assert.deepEqual(
    owner.slots.map((s) => s.time),
    ['09:50'],
  );
  assert.deepEqual(owner.requestedTimes, []);
  assert.equal(member.mode, 'any');
  assert.equal(member.rules.bookingMode, 'approval');
  assert.ok(member.slots.length > 1);
  assert.ok(member.requestedTimes.length > 0);
});

test('mixed staff submission saves classic immediately and leaves approval as a request', async (t) => {
  const f = await fixture(t),
    initial = f.appointments().length;
  const classic = publicSubmit(f.context, f.org, f.input(f.owner.accountId), now + 1000);
  assert.equal(classic.status, 'booked');
  assert.equal(classic.time, '09:50');
  assert.equal(f.appointments().length, initial + 1);
  const request = f.input(f.member.accountId);
  assert.equal(publicSubmit(f.context, f.org, request, now + 2000).status, 'pending');
  assert.equal(f.appointments().length, initial + 1);
  assert.equal(
    f.platform.bookingRequests.byKey(f.org, request.key, now + 2000).staffId,
    f.member.accountId,
  );
});

test('a stale approval form cannot silently become a classic appointment', async (t) => {
  const f = await fixture(t),
    before = f.appointments().length;
  const request = f.input(f.member.accountId);
  const saved = f.platform.onlineBooking.view(f.token);
  f.save({
    staff: {
      ...saved.staff,
      [f.member.accountId]: {
        ...saved.staff[f.member.accountId],
        bookingMode: 'classic',
      },
    },
  });
  assert.throws(() => publicSubmit(f.context, f.org, request, now + 1000), { status: 409 });
  assert.equal(f.appointments().length, before);
  assert.equal(f.platform.bookingRequests.byKey(f.org, request.key, now + 1000), null);
});

test('an already pending approval replays its own status after switching staff to classic', async (t) => {
  const f = await fixture(t),
    request = f.input(f.member.accountId);
  const result = publicSubmit(f.context, f.org, request, now + 1000);
  const before = f.appointments().length,
    saved = f.platform.onlineBooking.view(f.token);
  f.save({
    staff: {
      ...saved.staff,
      [f.member.accountId]: {
        ...saved.staff[f.member.accountId],
        bookingMode: 'classic',
        mode: 'sequential',
      },
    },
  });
  assert.deepEqual(publicSubmit(f.context, f.org, request, now + 2000), result);
  assert.equal(f.appointments().length, before);
});

test('a classic receipt replays before new staff rules without a duplicate appointment', async (t) => {
  const f = await fixture(t),
    request = f.input(f.owner.accountId);
  const result = publicSubmit(f.context, f.org, request, now + 1000);
  const before = f.appointments().length,
    saved = f.platform.onlineBooking.view(f.token);
  f.save({
    staff: {
      ...saved.staff,
      [f.owner.accountId]: {
        ...saved.staff[f.owner.accountId],
        bookingMode: 'approval',
        mode: 'any',
      },
    },
  });
  assert.deepEqual(publicSubmit(f.context, f.org, request, now + 2000), result);
  assert.equal(f.appointments().length, before);
  assert.throws(
    () => publicSubmit(f.context, f.org, { ...request, staffId: f.member.accountId }, now + 3000),
    { status: 409 },
  );
});

test('existing common and staff paths remain stable after rule changes', async (t) => {
  const f = await fixture(t),
    before = f.platform.bookingPublication.view(f.token);
  f.save({ mode: 'sequential', bookingMode: 'classic' });
  const after = f.platform.bookingPublication.view(f.token);
  assert.equal(after.path, before.path);
  assert.deepEqual(after.staffPaths, before.staffPaths);
});

test('classic staff cannot request negotiation of other time through a hidden control', async (t) => {
  const f = await fixture(t),
    request = f.input(f.owner.accountId, { kind: 'other-time' });
  const before = f.appointments().length;
  assert.throws(() => publicSubmit(f.context, f.org, request, now + 1000), { status: 400 });
  assert.equal(f.appointments().length, before);
  assert.equal(f.platform.bookingRequests.byKey(f.org, request.key, now + 1000), null);
});

test('availability shown before another booking cannot bypass fresh occupancy checks', async (t) => {
  const f = await fixture(t),
    request = f.input(f.owner.accountId);
  assert.equal(f.available(f.owner.accountId).slots[0].time, '09:50');
  const state = f.storage.read();
  state.patients[0].appointments.push({
    id: 'new-occupancy',
    date,
    time: '09:50',
    duration: 30,
    staffId: f.owner.accountId,
    status: 'scheduled',
    service: 'Synthetic later booking',
  });
  f.storage.write(state);
  const before = f.appointments().length;
  assert.throws(() => publicSubmit(f.context, f.org, request, now + 1000), { status: 409 });
  assert.equal(f.appointments().length, before);
});

for (const moved of [false, true])
  test(
    'sequential five-minute time survives approval' + (moved ? ' and manual time choice' : ''),
    async (t) => {
      const f = await fixture(t),
        saved = f.platform.onlineBooking.view(f.token);
      f.save({
        staff: {
          ...saved.staff,
          [f.owner.accountId]: {
            ...saved.staff[f.owner.accountId],
            bookingMode: 'approval',
          },
        },
      });
      const request = f.input(f.owner.accountId, { bookingMode: 'approval' });
      publicSubmit(f.context, f.org, request, now + 1000);
      const record = f.platform.bookingRequests.byKey(f.org, request.key, now + 1000);
      const current = f.platform.session(f.token);
      const result = await acceptRequest(
        {
          ...f.context,
          token: f.token,
          current,
          assertCurrent() {
            assert.equal(f.platform.session(f.token).organizationId, f.org);
          },
        },
        { id: record.id, revision: record.revision, ...(moved ? { date, time: '10:35' } : {}) },
        now + 2000,
      );
      assert.equal(result.status, 'accepted');
      assert.ok(f.appointments().some((item) => item.time === (moved ? '10:35' : '09:50')));
    },
  );
