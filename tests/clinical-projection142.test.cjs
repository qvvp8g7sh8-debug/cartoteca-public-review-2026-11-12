const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  createAppointmentConfirmations,
} = require('../src/server/modules/cabinet/confirmations.cjs');
const { createPersonalEvents } = require('../src/server/modules/calendar/personal-events.cjs');
const {
  appointmentRows,
  pairKey,
} = require('../src/server/modules/notifications/appointment-state-batch.cjs');
const seal = (value) => Buffer.from(JSON.stringify(value));
const open = (value) => JSON.parse(Buffer.from(value).toString());
const zone = 'Europe/Moscow';
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE accounts(id TEXT PRIMARY KEY,value BLOB NOT NULL);
    CREATE TABLE memberships(organization_id TEXT,account_id TEXT,PRIMARY KEY(organization_id,account_id));
    CREATE TABLE appointment_manual_confirmations(organization_id TEXT,patient_id TEXT,appointment_id TEXT,value BLOB NOT NULL,PRIMARY KEY(organization_id,patient_id,appointment_id));
    CREATE TABLE organizations(id TEXT PRIMARY KEY,value BLOB NOT NULL);
  `);
  const counts = { receipts: 0, actorBatches: 0, actorPoints: 0, organizationPoints: 0 };
  let readonly = false;
  const measured = {
    get canPrefetchReads() {
      return readonly;
    },
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        all(...args) {
          if (sql.includes('CROSS JOIN appointment_manual_confirmations')) counts.receipts++;
          if (sql.includes('CROSS JOIN accounts')) counts.actorBatches++;
          return stmt.all(...args);
        },
        get(...args) {
          if (sql.includes('SELECT a.value FROM accounts')) counts.actorPoints++;
          if (sql === 'SELECT value FROM organizations WHERE id=?') counts.organizationPoints++;
          return stmt.get(...args);
        },
      };
    },
  };
  const context = { db: measured, seal, open, crypto, audit() {} };
  const scalar = createAppointmentConfirmations({ ...context, db });
  const confirmations = createAppointmentConfirmations(context);
  return {
    db,
    context,
    scalar,
    confirmations,
    counts,
    readonly(value) {
      readonly = value;
    },
    reset() {
      for (const key of Object.keys(counts)) counts[key] = 0;
    },
    account(id, org = 'org', displayName = 'Name ' + id) {
      db.prepare('INSERT OR IGNORE INTO accounts VALUES(?,?)').run(id, seal({ displayName }));
      db.prepare('INSERT OR IGNORE INTO memberships VALUES(?,?)').run(org, id);
    },
    save(patient, appointment, actorId, changes = {}, org = 'org') {
      db.prepare('INSERT OR REPLACE INTO appointment_manual_confirmations VALUES(?,?,?,?)').run(
        org,
        patient,
        appointment.id,
        seal({ stamp: scalar.stamp(appointment, zone), actorId, confirmedAt: 123, ...changes }),
      );
    },
  };
}
const appointment = (id, changes = {}) => ({
  id,
  date: '2099-01-02',
  time: '10:00',
  duration: 30,
  staffId: 'staff',
  service: 'Synthetic',
  ...changes,
});
function expected(f, patients, org = 'org') {
  return new Map(
    patients.flatMap((p) =>
      p.appointments.flatMap((a) => {
        const value = f.scalar.read(org, p.id, a, zone);
        return value ? [[pairKey(p.id, a.id), value]] : [];
      }),
    ),
  );
}

test('manual confirmation actor reads are indexed chunks rather than one JOIN per actor, with scalar-equivalent tenant and stamp output', (t) => {
  const f = fixture(t),
    patients = [{ id: 'p', appointments: [] }];
  for (let i = 0; i < 450; i++) {
    const a = appointment('a-' + i);
    patients[0].appointments.push(a);
    f.account('actor-' + i);
    f.save('p', a, 'actor-' + i);
  }
  const stale = appointment('stale'),
    inactive = appointment('inactive', { status: 'completed' });
  patients[0].appointments.push(stale, inactive, patients[0].appointments[0]);
  f.save('p', stale, 'actor-0', { stamp: 'old' });
  f.save('p', inactive, 'actor-0');
  f.save('p', patients[0].appointments[1], 'foreign-name', {}, 'other');
  f.account('foreign-name', 'other', 'FOREIGN PRIVATE NAME');
  const oracle = expected(f, patients);
  f.reset();
  const result = f.confirmations.readMany('org', appointmentRows(patients, zone, f.confirmations));
  assert.deepEqual(result, oracle);
  assert.equal(f.counts.receipts, 3);
  assert.equal(f.counts.actorBatches, 3);
  assert.equal(f.counts.actorPoints, 0);
  assert.doesNotMatch(JSON.stringify([...result]), /FOREIGN PRIVATE NAME/);
  assert.equal(result.size, 450);
});

test('actor rename, membership removal and another organization are read afresh on the next response', (t) => {
  const f = fixture(t),
    a = appointment('a'),
    patients = [{ id: 'p', appointments: [a] }];
  f.account('actor');
  f.save('p', a, 'actor');
  const entries = appointmentRows(patients, zone, f.confirmations),
    key = pairKey('p', 'a');
  assert.equal(f.confirmations.readMany('org', entries).get(key).manualConfirmedBy, 'Name actor');
  f.db
    .prepare('UPDATE accounts SET value=? WHERE id=?')
    .run(seal({ displayName: 'Changed name' }), 'actor');
  assert.equal(f.confirmations.readMany('org', entries).get(key).manualConfirmedBy, 'Changed name');
  f.db
    .prepare('DELETE FROM memberships WHERE organization_id=? AND account_id=?')
    .run('org', 'actor');
  assert.equal(f.confirmations.readMany('org', entries).get(key).manualConfirmedBy, 'Сотрудник');
  f.account('actor', 'other');
  f.save('p', a, 'actor', {}, 'other');
  assert.deepEqual(f.confirmations.readMany('other', entries), expected(f, patients, 'other'));
  assert.equal(f.confirmations.readMany('org', entries).get(key).manualConfirmedBy, 'Сотрудник');
});

test('unusual legacy actor bindings preserve scalar behavior and valid Unicode plus duplicate receipts keep their order', (t) => {
  const f = fixture(t),
    patients = [{ id: 'p', appointments: [] }];
  const ids = ['valid-😀', 'legacy-\ud800', 'nul\0actor', null, 'second-valid', 'legacy-\ud800'];
  for (const [i, id] of ids.entries()) {
    const a = appointment('a-' + i);
    patients[0].appointments.push(a);
    if (id !== null) f.account(id);
    f.save('p', a, id);
  }
  const oracle = expected(f, patients);
  f.reset();
  assert.deepEqual(
    f.confirmations.readMany('org', appointmentRows(patients, zone, f.confirmations)),
    oracle,
  );
  assert.equal(f.counts.actorPoints, 3, 'one exact point binding for each distinct legacy key');
  assert.equal(f.counts.actorBatches, 2, 'flush normal inputs before a legacy point lookup');
});

function personalData() {
  return {
    version: 1,
    revision: 4,
    events: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        staffId: 'first',
        date: '2099-01-02',
        time: '10:00',
        duration: 30,
        notes: 'FIRST PRIVATE',
      },
      {
        id: '00000000-0000-4000-8000-000000000002',
        staffId: 'second',
        date: '2099-01-02',
        time: '11:00',
        duration: 30,
        notes: 'SECOND PRIVATE',
      },
    ],
  };
}
test('native personal views and month overview reuse the owning organization projection and preserve the staff audience', (t) => {
  const f = fixture(t),
    data = personalData();
  let organizationReads = 0;
  const organization = (org) => {
    assert.equal(org, 'org');
    organizationReads++;
    return { personalEvents: structuredClone(data) };
  };
  organization.readRequests = () => [];
  f.context.organization = organization;
  const events = createPersonalEvents(f.context),
    staff = { organizationId: 'org', accountId: 'first', role: 'cosmetologist' };
  f.readonly(true);
  const view = events.view(staff, '2099-01-01', '2099-01-31');
  const overview = events.overview(staff, '2099-01-01', '2099-01-31');
  assert.deepEqual(view.personalEvents, [data.events[0]]);
  assert.deepEqual(overview, [{ date: '2099-01-02', staffId: 'first', count: 1 }]);
  assert.doesNotMatch(JSON.stringify({ view, overview }), /SECOND PRIVATE/);
  assert.equal(f.counts.organizationPoints, 0);
  assert.equal(organizationReads, 2);
  f.context.organization = () => {
    throw Object.assign(Error('Aborted snapshot'), { code: '25P02' });
  };
  f.context.organization.readRequests = () => [];
  assert.throws(() => events.view(staff), { code: '25P02' });
});

test('ordinary personal reads and compatibility stores retain fresh point reads and fail closed on missing or invalid data', (t) => {
  const f = fixture(t),
    data = personalData(),
    owner = { organizationId: 'org', accountId: 'owner', role: 'owner' };
  f.db.prepare('INSERT INTO organizations VALUES(?,?)').run('org', seal({ personalEvents: data }));
  const organization = () => assert.fail('Ordinary reads must not borrow a projection');
  organization.readRequests = () => [];
  f.context.organization = organization;
  const events = createPersonalEvents(f.context);
  assert.equal(events.view(owner).personalEvents.length, 2);
  data.revision++;
  data.events.pop();
  f.db
    .prepare('UPDATE organizations SET value=? WHERE id=?')
    .run(seal({ personalEvents: data }), 'org');
  assert.equal(events.view(owner).personalEvents.length, 1);
  f.readonly(true);
  f.context.organization = () => assert.fail('Unregistered compatibility port');
  assert.equal(events.view(owner).personalEvents.length, 1);
  assert.equal(f.counts.organizationPoints, 3);
  f.db
    .prepare('UPDATE organizations SET value=? WHERE id=?')
    .run(seal({ personalEvents: { version: 2 } }), 'org');
  assert.throws(() => events.view(owner), { status: 400 });
  f.db.prepare('DELETE FROM organizations').run();
  assert.throws(() => events.view(owner), { status: 404 });
});
