const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  createBookingRequestOrigins,
} = require('../src/server/modules/booking/request-origins.cjs');
const { editable } = require('../src/server/modules/cabinet/changes.cjs');

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE booking_requests(id TEXT,organization_id TEXT,status TEXT,value BLOB)');
  let opened = 0;
  const origins = createBookingRequestOrigins({
    db,
    open(value) {
      opened++;
      return JSON.parse(Buffer.from(value).subarray(28).toString());
    },
  });
  const put = (org, id, patient, appointment, stamp = 1, status = 'accepted') => {
    db.prepare('DELETE FROM booking_requests WHERE organization_id=? AND id=?').run(org, id);
    const value = { appointmentId: appointment, acceptance: { patientId: patient } };
    db.prepare('INSERT INTO booking_requests VALUES(?,?,?,?)').run(
      id,
      org,
      status,
      Buffer.concat([Buffer.alloc(28, stamp), Buffer.from(JSON.stringify(value))]),
    );
  };
  const markers = new Set();
  const read = (org, patient, appointment) =>
    origins.appointmentSources(
      org,
      [
        {
          id: patient,
          appointments: [{ id: appointment, date: '2027-01-01', staffId: 'new-staff' }],
        },
      ],
      { get: (key) => markers.has(key) },
    );
  return { db, put, markers, read, opened: () => opened };
}

test('online provenance requires matching organization, patient, appointment and cabinet commit', (t) => {
  const f = fixture(t);
  f.put('org', 'request', 'patient', 'appointment', 1, 'pending');
  assert.equal(f.read('org', 'patient', 'appointment').size, 0);
  f.markers.add('booking-accepted:request');
  assert.ok(f.read('org', 'patient', 'appointment').has('["patient","appointment"]'));
  assert.equal(f.read('org', 'other-patient', 'appointment').size, 0);
  assert.equal(f.read('other-org', 'patient', 'appointment').size, 0);
  assert.equal(f.read('org', 'patient', 'manual-appointment').size, 0);
});

test('origin survives date/staff changes and cache refresh follows changed or removed receipts', (t) => {
  const f = fixture(t);
  f.put('org', 'request', 'patient', 'appointment');
  f.markers.add('booking-accepted:request');
  assert.equal(f.read('org', 'patient', 'appointment').size, 1);
  assert.equal(f.read('org', 'patient', 'appointment').size, 1);
  assert.equal(f.opened(), 1);
  f.put('org', 'request', 'other-patient', 'appointment', 2);
  assert.equal(f.read('org', 'patient', 'appointment').size, 0);
  assert.equal(f.read('org', 'other-patient', 'appointment').size, 1);
  f.db.prepare('DELETE FROM booking_requests').run();
  assert.equal(f.read('org', 'other-patient', 'appointment').size, 0);
});

test('an editable payload cannot set or retain the server-owned origin', () => {
  const payload = {
    patients: [{ id: 'patient', appointments: [{ id: 'manual', bookingSource: 'online' }] }],
  };
  assert.equal(editable(payload).patients[0].appointments[0].bookingSource, undefined);
  assert.equal(payload.patients[0].appointments[0].bookingSource, 'online');
});

test('cold origins read changed ciphertext in bounded batches and retain a bounded identifier cache', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE booking_requests(id TEXT,organization_id TEXT,status TEXT,value BLOB)');
  const put = db.prepare('INSERT INTO booking_requests VALUES(?,?,?,?)');
  for (let i = 0; i < 450; i++)
    put.run(
      'request-' + i,
      'org',
      'accepted',
      Buffer.concat([
        Buffer.alloc(28, 1),
        Buffer.from(JSON.stringify({ appointmentId: 'a-' + i, acceptance: { patientId: 'p' } })),
      ]),
    );
  let queries = 0,
    opened = 0;
  const wrapped = {
    get isTransaction() {
      return db.isTransaction;
    },
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      const statement = db.prepare(sql);
      return new Proxy(statement, {
        get(target, key) {
          const value = target[key];
          if (typeof value !== 'function') return value;
          return (...args) => {
            if (['all', 'iterate', 'get'].includes(key)) queries++;
            return value.apply(target, args);
          };
        },
      });
    },
  };
  const origins = createBookingRequestOrigins({
    db: wrapped,
    open(value) {
      opened++;
      return JSON.parse(Buffer.from(value).subarray(28));
    },
  });
  const patients = [{ id: 'p', appointments: [{ id: 'a-0' }, { id: 'a-449' }] }],
    storage = { get: () => true };
  assert.equal(origins.appointmentSources('org', patients, storage).size, 2);
  assert.equal(queries, 4, 'one stamp scan plus three chunks instead of 451 lookups');
  assert.equal(opened, 450);
  queries = 0;
  assert.equal(origins.appointmentSources('org', patients, storage).size, 2);
  assert.equal(queries, 1);
  assert.equal(opened, 450);
  const limited = createBookingRequestOrigins(
    {
      db,
      open(value) {
        opened++;
        return JSON.parse(Buffer.from(value).subarray(28));
      },
    },
    { maxOrganizations: 1, maxEntries: 2 },
  );
  const before = opened;
  limited.appointmentSources('org', patients, storage);
  limited.appointmentSources('org', patients, storage);
  assert.equal(opened - before, 900, 'oversized history is processed but not retained');
});

test('rollback and cabinet proof remain authoritative after cached provenance reads', (t) => {
  const f = fixture(t);
  f.put('org', 'request', 'patient', 'appointment');
  f.markers.add('booking-accepted:request');
  assert.equal(f.read('org', 'patient', 'appointment').size, 1);
  f.db.exec('BEGIN');
  f.put('org', 'request', 'patient', 'replacement', 2);
  assert.equal(f.read('org', 'patient', 'replacement').size, 1);
  f.db.exec('ROLLBACK');
  assert.equal(f.read('org', 'patient', 'replacement').size, 0);
  assert.equal(f.read('org', 'patient', 'appointment').size, 1);
  f.markers.clear();
  assert.equal(f.read('org', 'patient', 'appointment').size, 0);
});
