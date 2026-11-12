const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { bookingFixture } = require('./helpers/booking-fixture.cjs');
const { saveMutation } = require('../src/server/modules/cabinet/mutations.cjs');

function countDecrypts(callback) {
  const original = crypto.createDecipheriv;
  let count = 0;
  crypto.createDecipheriv = function (...args) {
    count++;
    return original.apply(this, args);
  };
  try {
    return { value: callback(), count };
  } finally {
    crypto.createDecipheriv = original;
  }
}
function mutationContext(f) {
  return {
    current: f.platform.session(f.token),
    platform: f.platform,
    token: f.token,
    tenantStore: () => f.storage,
    assertCurrent() {
      assert.ok(f.platform.session(f.token));
    },
  };
}
async function addStaff(f) {
  const invite = f.platform.createInvitation({
    organizationId: f.org,
    invitedBy: f.owner.accountId,
    role: 'cosmetologist',
  });
  return f.platform.acceptInvitation({
    token: invite.token,
    email: 'optimization-staff@example.test',
    password: 'Synthetic-optimization-password-2026',
    displayName: 'Synthetic staff',
  });
}

test('calendar narrows encrypted candidates but retains exact staff, status, names and overnight semantics', async (t) => {
  const f = await bookingFixture();
  t.after(f.close);
  const state = f.storage.read();
  const appointment = (id, staffId, status = 'scheduled') => ({
    id,
    staffId,
    status,
    date: f.date,
    time: '23:45',
    duration: 60,
    service: 'Synthetic service',
  });
  state.patients = Array.from({ length: 40 }, (_, i) => ({
    id: 'p' + i,
    firstName: 'Имя',
    lastName: 'Фамилия' + i,
    name: 'Имя Фамилия' + i,
    createdBy: 'other',
    visits: [],
    appointments: [appointment('a' + i, 'other')],
  }));
  state.patients.push({
    id: 'shared',
    firstName: 'Имя',
    lastName: 'Прежняя',
    name: 'Имя Прежняя',
    createdBy: 'staff',
    visits: [],
    appointments: [
      appointment('own', 'staff'),
      appointment('foreign', 'other'),
      appointment('cancelled', 'staff', 'cancelled'),
      appointment('missed', 'staff', 'no_show'),
    ],
  });
  // Patient access alone must not expose appointments assigned to another specialist.
  state.patients.push({
    id: 'history',
    name: 'Synthetic',
    createdBy: 'staff',
    visits: [],
    appointments: [appointment('history-foreign', 'other')],
  });
  f.storage.write(state);
  const all = countDecrypts(() => f.storage.calendarSnapshot('2030-01-02', '2030-01-02'));
  const scoped = countDecrypts(() =>
    f.storage.calendarSnapshot('2030-01-02', '2030-01-02', { staffId: 'staff' }),
  );
  assert.deepEqual(
    scoped.value.appointments,
    all.value.appointments.filter((a) => a.staffId === 'staff'),
  );
  assert.deepEqual(
    scoped.value.appointments.map((a) => a.id),
    ['own'],
  );
  assert.ok(
    scoped.count < all.count / 4,
    `Expected narrower reads: ${scoped.count} vs ${all.count}`,
  );
  assert.equal(
    f.storage.calendarSnapshot('2030-01-01', '2030-01-01', { staffId: 'absent' }).appointments
      .length,
    0,
  );
  assert.equal(
    f.storage.calendarSnapshot('2029-12-31', '2029-12-31', { staffId: 'staff' }).appointments
      .length,
    0,
  );
  const next = f.storage.read();
  Object.assign(
    next.patients.find((p) => p.id === 'shared'),
    { lastName: 'Новая', name: 'Имя Новая' },
  );
  f.storage.write(next);
  const updated = f.storage.calendarSnapshot(f.date, f.date, { staffId: 'staff' });
  assert.match(JSON.stringify(updated.appointments), /Новая/);
  assert.doesNotMatch(JSON.stringify(updated.appointments), /Прежняя/);
  assert.equal(f.storage.db.prepare('PRAGMA user_version').get().user_version, 1);
});

test('membership facts avoid decrypting names and observe account and membership revocation', async (t) => {
  const f = await bookingFixture();
  const db = new DatabaseSync(path.join(f.dir, 'platform', 'platform.sqlite'));
  t.after(() => {
    db.close();
    f.close();
  });
  const staff = await addStaff(f);
  const facts = countDecrypts(() => f.platform.workspaceIdentities(f.org));
  assert.equal(facts.count, 0);
  assert.deepEqual(
    facts.value,
    f.platform.workspaceMembers(f.org).map(({ displayName, ...identity }) => identity),
  );
  assert.deepEqual(
    f.platform.workspaceIdentities(f.org, staff.accountId),
    facts.value.filter((m) => m.accountId === staff.accountId),
  );
  assert.deepEqual(f.platform.workspaceIdentities('another-organization', staff.accountId), []);
  db.prepare("UPDATE accounts SET status='suspended' WHERE id=?").run(staff.accountId);
  assert.equal(f.platform.workspaceIdentities(f.org, staff.accountId)[0].status, 'suspended');
  db.prepare("UPDATE accounts SET status='active' WHERE id=?").run(staff.accountId);
  db.prepare(
    "UPDATE memberships SET status='suspended' WHERE organization_id=? AND account_id=?",
  ).run(f.org, staff.accountId);
  assert.equal(f.platform.workspaceIdentities(f.org, staff.accountId)[0].status, 'suspended');
});

test('save reads identities once per validation and refreshes them after asynchronous preparation', async (t) => {
  const f = await bookingFixture();
  const db = new DatabaseSync(path.join(f.dir, 'platform', 'platform.sqlite'));
  t.after(() => {
    db.close();
    f.close();
  });
  const staff = await addStaff(f);
  const original = f.platform.workspaceIdentities,
    reads = [];
  f.platform.workspaceIdentities = (...args) => {
    const facts = original(...args);
    reads.push(facts);
    return facts;
  };
  const service = {
    id: 'staff-service',
    name: 'Synthetic service',
    duration: '30 минут',
    price: 120,
    staffId: staff.accountId,
  };
  const body = {
    revision: f.storage.read().revision,
    patients: [],
    services: [{ id: service.id, before: null, after: service }],
  };
  const beforeSave = f.storage.read();
  const prepare = f.storage.prepareImages;
  f.storage.prepareImages = async (...args) => {
    const result = await prepare(...args);
    db.prepare("UPDATE accounts SET status='suspended' WHERE id=?").run(staff.accountId);
    return result;
  };
  await assert.rejects(saveMutation(mutationContext(f), body, { partial: true }), { status: 400 });
  assert.equal(reads.length, 2);
  assert.equal(reads[0].find((m) => m.accountId === staff.accountId).status, 'active');
  assert.equal(reads[1].find((m) => m.accountId === staff.accountId).status, 'suspended');
  assert.equal(f.storage.readSelected([], [service.id]).services.length, 0);
  assert.deepEqual(f.storage.read(), beforeSave);
  f.storage.prepareImages = prepare;
  db.prepare("UPDATE accounts SET status='active' WHERE id=?").run(staff.accountId);
  reads.length = 0;
  await saveMutation(mutationContext(f), body, { partial: true });
  assert.equal(reads.length, 2);
  assert.equal(f.storage.readSelected([], [service.id]).services.length, 1);
});
