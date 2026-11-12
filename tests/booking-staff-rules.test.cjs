const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPlatformStore } = require('../platform-store.cjs');
const { effectiveStaffRules } = require('../src/server/modules/booking/staff-rules.cjs');
const { availableSlots } = require('../src/server/modules/booking/availability.cjs');
const { requestInput } = require('../src/server/modules/booking/request-input.cjs');

const permission = (extra = {}) => ({ enabled: true, manageOwnRequests: true, ...extra });

test('effective staff rules inherit each field independently without copying permissions', () => {
  const settings = {
    mode: 'any',
    bookingMode: 'approval',
    minimumLeadMinutes: 0,
    reservationMinutes: 15,
    staff: {
      first: permission({ mode: 'sequential' }),
      second: permission({ bookingMode: 'classic' }),
      third: permission({ mode: 'inherit', bookingMode: 'inherit' }),
    },
  };
  const before = structuredClone(settings);
  assert.deepEqual(effectiveStaffRules(settings, 'first'), {
    mode: 'sequential',
    bookingMode: 'approval',
    minimumLeadMinutes: 0,
    reservationMinutes: 15,
  });
  assert.deepEqual(effectiveStaffRules(settings, 'second'), {
    mode: 'any',
    bookingMode: 'classic',
    minimumLeadMinutes: 0,
    reservationMinutes: 15,
  });
  assert.deepEqual(
    effectiveStaffRules(settings, 'third'),
    effectiveStaffRules(settings, 'missing'),
  );
  assert.deepEqual(settings, before);
});

test('missing and explicit inherited fields follow the current organization defaults', () => {
  assert.deepEqual(effectiveStaffRules(), {
    mode: 'any',
    bookingMode: 'approval',
    minimumLeadMinutes: 60,
    reservationMinutes: 30,
  });
  const settings = {
    mode: 'sequential',
    bookingMode: 'classic',
    staff: { person: { mode: 'inherit', bookingMode: 'inherit' } },
  };
  assert.equal(effectiveStaffRules(settings, 'person').mode, 'sequential');
  assert.equal(effectiveStaffRules(settings, 'person').bookingMode, 'classic');
  settings.mode = 'any';
  settings.bookingMode = 'approval';
  assert.equal(effectiveStaffRules(settings, 'person').mode, 'any');
  assert.equal(effectiveStaffRules(settings, 'person').bookingMode, 'approval');
});

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-staff-booking-rules-'));
  let platform;
  t.after(() => {
    platform?.close();
    if (
      path.dirname(dir) !== path.resolve(os.tmpdir()) ||
      !path.basename(dir).startsWith('cartoteca-staff-booking-rules-')
    )
      throw Error('Unsafe synthetic staff rules cleanup');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  platform = createPlatformStore(path.join(dir, 'platform'));
  const password = 'Synthetic-staff-rules-password-2030';
  const owner = await platform.registerOwner({
    email: 'owner@staff-rules.test',
    password,
    displayName: 'Synthetic owner',
    organizationName: 'Synthetic staff rules',
  });
  platform.verifyEmail(owner.verificationToken);
  const ownerToken = (await platform.login('owner@staff-rules.test', password)).token;
  const users = {};
  for (const [name, role] of [
    ['employee', 'cosmetologist'],
    ['administrator', 'salon_admin'],
  ]) {
    const invite = platform.createInvitation({
      organizationId: owner.organizationId,
      invitedBy: owner.accountId,
      role,
    });
    const account = await platform.acceptInvitation({
      token: invite.token,
      email: name + '@staff-rules.test',
      password,
      displayName: 'Synthetic ' + name,
    });
    users[name] = {
      id: account.accountId,
      token: (await platform.login(name + '@staff-rules.test', password)).token,
    };
  }
  const view = () => platform.onlineBooking.view(ownerToken);
  const input = (extra = {}) => {
    const saved = view();
    return {
      revision: saved.revision,
      mode: saved.mode,
      bookingMode: saved.bookingMode,
      minimumLeadMinutes: saved.minimumLeadMinutes,
      reservationMinutes: saved.reservationMinutes,
      showPrices: saved.showPrices,
      staff: saved.staff,
      services: saved.services,
      ...extra,
    };
  };
  const save = (extra, token = ownerToken) =>
    platform.onlineBooking.save(token, input(extra), new Set());
  return { platform, owner, ownerToken, users, view, input, save };
}

test('owner and administrator can set independent staff rules through the platform service', async (t) => {
  const f = await fixture(t);
  const staff = {
    [f.owner.accountId]: permission({ mode: 'sequential', bookingMode: 'approval' }),
    [f.users.employee.id]: permission({ mode: 'any', bookingMode: 'classic' }),
  };
  f.save({ staff });
  assert.deepEqual(f.view().staff, staff);
  const updated = { ...staff, [f.owner.accountId]: permission({ mode: 'any' }) };
  f.save({ staff: updated }, f.users.administrator.token);
  assert.equal(f.view().staff[f.owner.accountId].mode, 'any');
  assert.equal(f.view().staff[f.owner.accountId].bookingMode, 'approval');
  assert.equal(f.view().staff[f.users.employee.id].bookingMode, 'classic');
});

test('older clients preserve the same staff overrides while updating permission fields', async (t) => {
  const f = await fixture(t);
  const id = f.users.employee.id;
  f.save({ staff: { [id]: permission({ mode: 'sequential', bookingMode: 'classic' }) } });
  f.save({
    staff: { [id]: permission({ manageOwnRequests: false }), [f.owner.accountId]: permission() },
  });
  assert.deepEqual(f.view().staff[id], {
    enabled: true,
    manageOwnRequests: false,
    mode: 'sequential',
    bookingMode: 'classic',
  });
  assert.deepEqual(f.view().staff[f.owner.accountId], permission());
  f.save({ staff: { [id]: permission({ bookingMode: 'approval' }) } });
  assert.equal(f.view().staff[id].mode, 'sequential');
  assert.equal(f.view().staff[id].bookingMode, 'approval');
});

test('explicit inherit resets an override and follows later organization changes', async (t) => {
  const f = await fixture(t);
  const id = f.users.employee.id;
  f.save({ staff: { [id]: permission({ mode: 'sequential', bookingMode: 'classic' }) } });
  f.save({ staff: { [id]: permission({ mode: 'inherit', bookingMode: 'inherit' }) } });
  let rules = effectiveStaffRules(f.view(), id);
  assert.equal(rules.mode, 'any');
  assert.equal(rules.bookingMode, 'approval');
  f.save({ mode: 'sequential', bookingMode: 'classic' });
  rules = effectiveStaffRules(f.view(), id);
  assert.equal(rules.mode, 'sequential');
  assert.equal(rules.bookingMode, 'classic');
});

test('defaults-only writes preserve staff rows not rendered by an older client', async (t) => {
  const f = await fixture(t),
    id = f.users.employee.id;
  f.save({
    staff: { [id]: permission({ enabled: false, mode: 'sequential', bookingMode: 'classic' }) },
  });
  const before = f.view().staff[id];
  f.save({ mode: 'sequential', bookingMode: 'classic', staff: {} });
  assert.deepEqual(f.view().staff[id], before);
  f.save({ staff: { [id]: permission({ mode: 'inherit', bookingMode: 'inherit' }) } });
  assert.equal(effectiveStaffRules(f.view(), id).bookingMode, 'classic');
});

test('staff rules reject foreign members, unknown fields and invalid enums without changes', async (t) => {
  const f = await fixture(t);
  const id = f.users.employee.id;
  const before = f.view();
  for (const entry of [
    permission({ mode: 'classic' }),
    permission({ mode: null }),
    permission({ bookingMode: 'sequential' }),
    permission({ bookingMode: null }),
    permission({ minimumLeadMinutes: 1 }),
  ])
    assert.throws(() => f.save({ staff: { [id]: entry } }), { status: 400 });
  assert.throws(() => f.save({ staff: { foreign: permission({ mode: 'any' }) } }), { status: 400 });
  assert.deepEqual(f.view(), before);
});

test('employees cannot edit rules and stale managers cannot overwrite newer overrides', async (t) => {
  const f = await fixture(t);
  const id = f.users.employee.id;
  const old = f.input({ staff: { [id]: permission({ mode: 'any' }) } });
  f.save({ staff: { [id]: permission({ mode: 'sequential' }) } });
  const before = f.view();
  assert.throws(() => f.save({ staff: { [id]: permission() } }, f.users.employee.token), {
    status: 403,
  });
  assert.throws(() => f.platform.onlineBooking.save(f.ownerToken, old, new Set()), { status: 409 });
  assert.deepEqual(f.view(), before);
  assert.deepEqual(Object.keys(f.platform.onlineBooking.view(f.users.employee.token).staff), [id]);
});

test('an internal exact-time recheck accepts only that free five-minute start', () => {
  const date = '2030-01-01';
  const options = {
    date,
    duration: 30,
    staff: [{ accountId: 'first' }],
    dayAt: () => ({ status: 'working', intervals: [['09:00', '12:00']] }),
    workspace: { rooms: [{ id: 'room', active: true, preventOverlap: true, staffIds: ['first'] }] },
    appointments: [{ date, time: '09:00', duration: 50, staffId: 'first', roomId: 'room' }],
    now: Date.parse('2030-01-01T00:00:00Z'),
    mode: 'any',
  };
  assert.deepEqual(
    availableSlots({ ...options, atTime: '09:50' }).map((slot) => slot.time),
    ['09:50'],
  );
  assert.deepEqual(availableSlots({ ...options, atTime: '09:45' }), []);
  assert.deepEqual(
    availableSlots({ ...options, atTime: '09:50', now: Date.parse(date + 'T07:30:00Z') }),
    [],
  );
  assert.throws(() => availableSlots({ ...options, atTime: '09:51' }), { status: 400 });
});

test('mixed staff offers keep sequential five-minute starts and align only new candidates', () => {
  const date = '2030-01-01';
  const options = {
    date,
    duration: 30,
    staff: [{ accountId: 'first' }, { accountId: 'second' }],
    dayAt: () => ({ status: 'working', intervals: [['09:00', '12:00']] }),
    workspace: {
      rooms: [{ id: 'room', active: true, preventOverlap: true, staffIds: ['first', 'second'] }],
    },
    appointments: [{ date, time: '09:00', duration: 50, staffId: 'first', roomId: 'room' }],
    modeForStaff: (id) => (id === 'first' ? 'sequential' : 'any'),
    now: Date.parse('2030-01-01T00:00:00Z'),
  };
  const slots = availableSlots(options);
  assert.deepEqual(
    slots.filter((slot) => slot.staffId === 'first').map((slot) => slot.time),
    ['09:50'],
  );
  assert.ok(slots.filter((slot) => slot.staffId === 'second').length > 1);
  const aligned = availableSlots({
    ...options,
    appointments: [],
    dayAt: () => ({ status: 'working', intervals: [['09:07', '12:00']] }),
  });
  assert.equal(aligned[0].time, '09:10');
  for (const slot of [...slots, ...aligned]) {
    const input = {
      key: 'synthetic-staff-rules-key',
      date,
      time: slot.time,
      serviceIds: ['service'],
      staffId: slot.staffId,
      kind: 'reserve',
      firstName: 'Synthetic',
      phone: '+79999999999',
      consent: true,
    };
    assert.equal(requestInput(input).time, slot.time);
    assert.throws(() => requestInput({ ...input, time: '09:07' }), { status: 400 });
  }
});
