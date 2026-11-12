const test = require('node:test');
const assert = require('node:assert/strict');
const { createPushSchedule } = require('../src/server/modules/notifications/push-events.cjs');
const { fingerprint } = require('../src/server/modules/notifications/appointments.cjs');
const {
  createManagedPushDelivery,
} = require('../src/server/modules/notifications/push-managed-delivery.cjs');
const flush = () => new Promise(setImmediate);
test('Push validates only its canonical appointment and still cancels changed, removed or rebound events', () => {
  let appointment = {
    id: 'a',
    staffId: 'staff',
    date: '2026-11-01',
    time: '12:00',
    duration: 30,
    status: 'scheduled',
  };
  let selected = 0;
  const storage = {
    readAppointment(patient, id) {
      assert.equal(patient, 'p');
      assert.equal(id, 'a');
      selected++;
      return appointment;
    },
    readSelected() {
      assert.fail('unrelated patient history must not hydrate');
    },
  };
  const schedule = createPushSchedule(
    { organizationTimeZone: () => 'Europe/Moscow' },
    () => storage,
    {},
  );
  const job = {
    organization_id: 'org',
    decoded: {
      event: 'change',
      staffId: 'staff',
      reference: {
        kind: 'appointment',
        patientId: 'p',
        id: 'a',
        stamp: fingerprint(appointment, 'Europe/Moscow'),
      },
    },
  };
  assert.equal(schedule.current(job), true);
  appointment = { ...appointment, time: '13:00' };
  assert.equal(schedule.current(job), false);
  appointment = null;
  assert.equal(schedule.current(job), false);
  job.decoded.reference.removed = true;
  assert.equal(schedule.current(job), true);
  assert.equal(selected, 4);
});
test('managed Push consumes a single scoped claim without a legacy global peek', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let current = true,
    claims = 0,
    delivered = 0;
  const job = { id: 'j', device_id: 'd', organization_id: 'o', next_at: 0 };
  const store = {
    claimManagedWithHead() {
      claims++;
      return claims === 1 ? { head: job, job } : { head: null, job: null };
    },
    peekManaged() {
      assert.fail('PG3 does not probe legacy global hint');
    },
    claimManaged() {
      assert.fail('one scoped CAS only');
    },
  };
  const runtime = createManagedPushDelivery({
    store,
    clock: () => 100,
    monotonic: () => 0,
    current: () => current,
    active: () => current,
    available: () => true,
    manualRunning: () => false,
    plan() {},
    onError: () => assert.fail('unexpected error'),
    deliver: async () => {
      delivered++;
      current = false;
      return { outcome: 'sent' };
    },
    runBackgroundWork: (callback) => callback(),
  });
  t.after(() => runtime.stop());
  runtime.start(1);
  t.mock.timers.tick(0);
  await flush();
  assert.equal(delivered, 1);
  assert.equal(claims, 2);
  assert.equal(runtime.stats().claims, 1);
  assert.equal(runtime.stats().observedHeadDueLagMs, null);
  assert.deepEqual(runtime.stats().claimedNextAtLag, { count: 1, totalMs: 100, maxMs: 100 });
  assert.equal(runtime.stats().active, 0);
});

test('schema2 Push reads a single canonical appointment without decrypting unrelated visit history', (t) => {
  const { DatabaseSync } = require('node:sqlite');
  const { createPatientRecords } = require('../src/server/infrastructure/cabinet-records.cjs');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(
    'CREATE TABLE cabinet_patient_records(kind TEXT,id TEXT,patient_id TEXT,position INTEGER,value BLOB);',
  );
  const appointment = {
    id: 'canonical-a',
    staffId: 'staff',
    date: '2026-11-01',
    time: '12:00',
    duration: 30,
    status: 'scheduled',
  };
  db.prepare('INSERT INTO cabinet_patient_records VALUES(?,?,?,?,?)').run(
    'appointment',
    appointment.id,
    'p',
    0,
    Buffer.from(JSON.stringify(appointment)),
  );
  db.prepare('INSERT INTO cabinet_patient_records VALUES(?,?,?,?,?)').run(
    'visit',
    'unrelated-v',
    'p',
    0,
    Buffer.from('unrelated invalid visit payload'),
  );
  const records = createPatientRecords({
    db,
    schemaVersion: 2,
    decode: (value) => JSON.parse(Buffer.from(value).toString('utf8')),
  });
  assert.throws(
    () => records.hydrate([{ id: 'p', value: Buffer.from(JSON.stringify({ id: 'p' })) }]),
    SyntaxError,
  );
  const schedule = createPushSchedule(
    { organizationTimeZone: () => 'Europe/Moscow' },
    () => ({ readAppointment: (patient, id) => records.appointment(patient, id) }),
    {},
  );
  assert.equal(
    schedule.current({
      organization_id: 'org',
      decoded: {
        event: 'change',
        staffId: 'staff',
        reference: {
          kind: 'appointment',
          patientId: 'p',
          id: appointment.id,
          stamp: fingerprint(appointment, 'Europe/Moscow'),
        },
      },
    }),
    true,
  );
});
