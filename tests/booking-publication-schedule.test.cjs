const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createBookingPublication } = require('../src/server/modules/booking/publication.cjs');
const { createFutureDays } = require('../src/server/modules/schedules/future-days.cjs');
const {
  createBookingPublicationRuntime,
} = require('../src/server/modules/booking/publication-runtime.cjs');
const org = '11111111-1111-4111-8111-111111111111';
const now = Date.parse('2040-01-01T00:00:00Z');

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(
    'CREATE TABLE organizations(id TEXT PRIMARY KEY,status TEXT,value TEXT); CREATE TABLE work_schedule_days(organization_id TEXT,staff_id TEXT,date TEXT,value TEXT,PRIMARY KEY(organization_id,staff_id,date));',
  );
  db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(
    org,
    'active',
    JSON.stringify({ name: 'Synthetic', bookingPublication: { enabled: true, revision: 1 } }),
  );
  const audits = [];
  const context = {
    db,
    seal: JSON.stringify,
    open: JSON.parse,
    readOnlySnapshot(fn) {
      db.exec('BEGIN DEFERRED');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    audit: (...args) => audits.push(args),
    organization: () =>
      JSON.parse(db.prepare('SELECT value FROM organizations WHERE id=?').get(org).value),
    organizationTimeZone: () => 'Europe/Moscow',
    subscription: () => ({ status: 'active' }),
    workspaceIdentities: () => [{ accountId: 'owner', role: 'owner', status: 'active' }],
    onlineBooking: {
      actor: (token) => ({
        role: token === 'employee' ? 'cosmetologist' : 'owner',
        organizationId: org,
        accountId: 'owner',
      }),
      settings: () => ({ staff: {} }),
    },
    workSchedules: { futureDays: createFutureDays({ db, open: JSON.parse }) },
  };
  context.compoundTransaction = (fn) => context.transaction(fn);
  const publication = createBookingPublication(context);
  const day = (date, status = 'working', intervals = [['09:00', '10:00']], staff = 'owner') =>
    db
      .prepare('INSERT OR REPLACE INTO work_schedule_days VALUES(?,?,?,?)')
      .run(org, staff, date, JSON.stringify({ status, intervals }));
  const reconcile = (time = now) =>
    context.transaction(() => publication.reconcileInTransaction(org, time));
  return { context, publication, audits, day, reconcile };
}

test('no future days disables exactly once and restoring graph requires manual activation', (t) => {
  const f = fixture(t);
  const value = f.reconcile();
  assert.equal(value.enabled, false);
  assert.equal(value.disabledReason, 'no_working_days');
  assert.equal(value.revision, 2);
  f.reconcile();
  assert.equal(f.audits.length, 1);
  f.day('2040-01-02');
  assert.equal(f.reconcile().enabled, false);
  assert.equal(f.reconcile().hasWorkingDays, true);
  assert.throws(() => f.publication.resolve(org, { now }), { status: 404 });
  assert.equal(f.publication.resolve(org, { allowAutoDisabled: true, now }).name, 'Synthetic');
  assert.equal(f.publication.save('owner', { enabled: true, revision: 2 }).enabled, true);
});

test('the last working interval ending disables even with a browser closed; 24:00 respects organization zone', (t) => {
  const f = fixture(t);
  f.day('2040-01-01', 'working', [['00:00', '24:00']]);
  assert.equal(f.reconcile(Date.parse('2040-01-01T20:59:59Z')).enabled, true);
  const runtime = createBookingPublicationRuntime({
    publication: f.publication,
    clock: () => Date.parse('2040-01-01T21:00:00Z'),
  });
  runtime.tick();
  assert.equal(f.publication.view('owner', now).enabled, false);
  assert.equal(f.audits.length, 1);
  runtime.stop();
});

test('schedule existence does not depend on services, rooms, reservations or online staff assignments', (t) => {
  const f = fixture(t);
  f.context.onlineBooking.settings = () => ({
    staff: { owner: { enabled: false } },
    minimumLeadMinutes: 10080,
    services: {},
  });
  f.day('2050-02-03');
  assert.equal(f.reconcile().enabled, true);
  // This fixture exposes no cabinet/room/catalog/reservation ports at all.
  assert.equal(f.audits.length, 0);
});

test('organization closure excludes its day; disabled memberships never count', (t) => {
  const f = fixture(t);
  f.day('2040-01-02');
  f.day('2040-01-02', 'closed', [], 'organization');
  assert.equal(f.reconcile().enabled, false);
  f.day('2050-02-03');
  f.context.workspaceIdentities = () => [
    { accountId: 'owner', role: 'owner', status: 'suspended' },
  ];
  assert.equal(f.reconcile().hasWorkingDays, false);
});

test('enable without graph stays off; employee cannot enable; schedule failure preserves publication', (t) => {
  const f = fixture(t);
  assert.throws(() => f.publication.save('employee', { enabled: true, revision: 1 }), {
    status: 403,
  });
  f.context.workSchedules.futureDays = () => {
    throw Error('Synthetic storage failure');
  };
  assert.throws(f.reconcile, /Synthetic storage failure/);
  assert.equal(f.context.organization(org).bookingPublication.enabled, true);
  assert.equal(f.audits.length, 0);
  f.context.workSchedules.futureDays = function* () {};
  const saved = f.publication.save('owner', { enabled: true, revision: 1 });
  assert.equal(saved.enabled, false);
  assert.equal(saved.disabledReason, 'no_working_days');
});

test('maintenance uses bounded batches and preserves manual-off profiles', (t) => {
  const f = fixture(t);
  f.publication.save('owner', { enabled: false, revision: 1 });
  const before = f.context.organization(org);
  assert.equal(f.publication.reconcileBatch('', 1, now).cursor, org);
  assert.equal(f.publication.reconcileBatch(org, 1, now).cursor, '');
  assert.deepEqual(f.context.organization(org), before);
  assert.throws(() => f.publication.reconcileBatch('', 101, now), { status: 400 });
});
