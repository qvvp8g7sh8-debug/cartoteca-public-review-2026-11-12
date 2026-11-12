const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStorage } = require('../storage.cjs');
const {
  createCalendarOccupancyVersion,
} = require('../src/server/infrastructure/calendar-occupancy-version.cjs');

function fixture(t, schema) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-calendar-version-'));
  const stores = [];
  const open = () => {
    const store = createStorage(directory, { cabinetSchema: schema });
    stores.push(store);
    return store;
  };
  t.after(() => {
    for (const store of stores) store.close();
    const resolved = path.resolve(directory);
    if (
      path.dirname(resolved) === path.resolve(os.tmpdir()) &&
      /^cartoteca-calendar-version-/.test(path.basename(resolved))
    )
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  });
  const store = open();
  const patients = ['a', 'b', 'c'].map((suffix) => ({
    id: 'patient-' + suffix,
    name: 'Synthetic ' + suffix,
    visits: [],
    appointments: [
      {
        id: 'appointment-' + suffix,
        staffId: 'staff-' + suffix,
        date: '2030-01-01',
        time: '10:00',
        duration: 30,
        status: 'scheduled',
        service: 'Synthetic',
      },
    ],
  }));
  store.write({ revision: 0, patients, services: [] });
  const patient = (id = 'patient-a') => store.readSelected([id]).patients[0];
  const save = (values, ids = values.map((value) => value.id), options = {}) =>
    store.write(
      { revision: store.get('revision'), patients: values, services: [] },
      { changedIds: { patients: ids, services: [] }, ...options },
    );
  const versions = () => ['staff-a', 'staff-b', 'staff-c'].map(store.calendarOccupancyVersion);
  return { store, open, patient, save, versions };
}

for (const schema of [1, 2]) {
  test(`schema ${schema}: occupancy versions are encrypted, per staff and shared by connections`, (t) => {
    const { store, open, patient, save, versions } = fixture(t, schema);
    const original = versions();
    for (const value of original) assert.match(value, /^[\da-f-]{36}$/);
    assert.equal(new Set(original).size, 3);
    assert.equal(store.calendarOccupancyVersion('absent'), '');
    assert.equal(store.calendarOccupancyVersion(''), '');
    const rows = store.db
      .prepare("SELECT key,value FROM meta WHERE key LIKE 'calendar-occupancy:%'")
      .all();
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.match(row.key, /^calendar-occupancy:[\da-f]{64}$/);
      assert.ok(original.includes(store.decode(row.value)));
      assert.ok(!original.some((value) => Buffer.from(row.value).includes(Buffer.from(value))));
    }
    const other = open();
    assert.equal(other.calendarOccupancyVersion('staff-a'), original[0]);
    const changed = patient();
    changed.appointments[0].time = '11:00';
    save([changed]);
    assert.notEqual(versions()[0], original[0]);
    assert.deepEqual(versions().slice(1), original.slice(1));
    assert.equal(other.calendarOccupancyVersion('staff-a'), versions()[0]);
    assert.equal(open().calendarOccupancyVersion('staff-a'), versions()[0]);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, schema);
  });

  test(`schema ${schema}: phone, history, service, room and completed status keep versions`, (t) => {
    const { patient, save, versions } = fixture(t, schema);
    const original = versions();
    const changed = patient();
    changed.phone = '+79999999999';
    changed.notes = 'Synthetic clinical note';
    Object.assign(changed.appointments[0], {
      service: 'Changed service',
      notes: 'Synthetic appointment note',
      roomId: 'another-room',
      status: 'completed',
      completedVisitId: 'visit-a',
    });
    changed.visits.push({
      id: 'visit-a',
      appointmentId: 'appointment-a',
      staffId: 'staff-a',
      date: '2030-01-01',
      procedure: 'Synthetic',
      notes: 'Synthetic history',
      photos: [],
    });
    save([changed]);
    assert.deepEqual(versions(), original);
    save([changed]);
    assert.deepEqual(versions(), original);
  });

  test(`schema ${schema}: legacy and structured names invalidate all nonclosed appointment owners`, (t) => {
    const { patient, save, versions } = fixture(t, schema);
    const changed = patient();
    changed.appointments.push(
      { ...changed.appointments[0], id: 'other-owner', staffId: 'staff-b' },
      { ...changed.appointments[0], id: 'closed-owner', staffId: 'staff-c', status: 'cancelled' },
    );
    save([changed]);
    let previous = versions();
    changed.name = 'Renamed Synthetic';
    save([changed]);
    assert.notEqual(versions()[0], previous[0]);
    assert.notEqual(versions()[1], previous[1]);
    assert.equal(versions()[2], previous[2]);
    for (const names of [
      { firstName: 'Test', lastName: 'Surname', middleName: 'Middle', name: 'Test Middle Surname' },
      {
        firstName: 'Other',
        lastName: 'Surname',
        middleName: 'Middle',
        name: 'Other Middle Surname',
      },
      {
        firstName: 'Other',
        lastName: 'Surname',
        middleName: 'Second',
        name: 'Other Second Surname',
      },
      {
        firstName: 'Other',
        lastName: 'Renamed',
        middleName: 'Second',
        name: 'Other Second Renamed',
      },
    ]) {
      previous = versions();
      Object.assign(changed, names);
      save([changed]);
      assert.notEqual(versions()[0], previous[0]);
      assert.notEqual(versions()[1], previous[1]);
      assert.equal(versions()[2], previous[2]);
    }
    previous = versions();
    changed.firstName = ' Other  ';
    changed.lastName = '  Renamed ';
    save([changed]);
    assert.deepEqual(versions(), previous, 'whitespace changes keep the same displayed name');
  });

  test(`schema ${schema}: anonymous client phone and designation never enter the fingerprint`, (t) => {
    const { patient, save, versions } = fixture(t, schema);
    const changed = patient();
    changed.name = '';
    changed.phone = '+79999999999';
    changed.designation = 'Synthetic designation';
    save([changed]);
    const previous = versions();
    changed.phone = '+79999999998';
    changed.designation = 'Updated designation';
    save([changed]);
    assert.deepEqual(versions(), previous);
  });

  test(`schema ${schema}: moving an appointment between clients with the same name keeps versions`, (t) => {
    const { patient, save, versions } = fixture(t, schema);
    const one = patient(),
      two = patient('patient-b');
    two.name = one.name;
    save([two]);
    const previous = versions();
    two.appointments.push(one.appointments.pop());
    save([one, two]);
    assert.deepEqual(versions(), previous);
  });

  test(`schema ${schema}: create, date, time, duration, identity and delete invalidate only owner`, (t) => {
    const { patient, save, versions } = fixture(t, schema);
    for (const mutate of [
      (appointment) => (appointment.date = '2030-01-02'),
      (appointment) => (appointment.time = '12:00'),
      (appointment) => (appointment.duration = 45),
      (appointment) => (appointment.id = 'replacement-a'),
    ]) {
      const previous = versions();
      const changed = patient();
      mutate(changed.appointments[0]);
      save([changed]);
      assert.notEqual(versions()[0], previous[0]);
      assert.deepEqual(versions().slice(1), previous.slice(1));
    }
    const changed = patient();
    const appointment = changed.appointments.pop();
    let previous = versions();
    save([changed]);
    assert.notEqual(versions()[0], previous[0]);
    previous = versions();
    changed.appointments.push(appointment);
    save([changed]);
    assert.notEqual(versions()[0], previous[0]);
    assert.deepEqual(versions().slice(1), previous.slice(1));
  });

  test(`schema ${schema}: cancelled/no-show have no occupancy until reopened`, (t) => {
    const { patient, save, versions } = fixture(t, schema);
    const changed = patient();
    let previous = versions();
    changed.appointments[0].status = 'cancelled';
    save([changed]);
    assert.notEqual(versions()[0], previous[0]);
    previous = versions();
    changed.appointments[0].status = 'no_show';
    changed.appointments[0].time = '13:00';
    save([changed]);
    assert.deepEqual(versions(), previous);
    changed.appointments[0].status = 'scheduled';
    save([changed]);
    assert.notEqual(versions()[0], previous[0]);
    assert.deepEqual(versions().slice(1), previous.slice(1));
  });

  test(`schema ${schema}: reassignment invalidates both staff, moving to another client changes the name`, (t) => {
    const { patient, save, versions } = fixture(t, schema);
    const one = patient(),
      two = patient('patient-b');
    let previous = versions();
    two.appointments.push(one.appointments.pop());
    save([one, two]);
    assert.notEqual(versions()[0], previous[0]);
    assert.deepEqual(versions().slice(1), previous.slice(1));
    previous = versions();
    two.appointments.find((appointment) => appointment.id === 'appointment-a').staffId = 'staff-b';
    save([two]);
    assert.notEqual(versions()[0], previous[0]);
    assert.notEqual(versions()[1], previous[1]);
    assert.equal(versions()[2], previous[2]);
    previous = versions();
    save([], ['patient-b']);
    assert.equal(versions()[0], previous[0]);
    assert.notEqual(versions()[1], previous[1]);
    assert.equal(versions()[2], previous[2]);
  });

  test(`schema ${schema}: full replacement and restored data get new non-repeating versions`, (t) => {
    const { store, versions } = fixture(t, schema);
    const original = versions(),
      baseline = store.read();
    const changed = structuredClone(baseline);
    changed.patients[0].appointments[0].time = '14:00';
    store.write(changed);
    const moved = versions();
    assert.notEqual(moved[0], original[0]);
    assert.deepEqual(moved.slice(1), original.slice(1));
    store.write(baseline, { migrating: true });
    assert.notEqual(versions()[0], original[0]);
    assert.notEqual(versions()[0], moved[0]);
    assert.deepEqual(versions().slice(1), original.slice(1));
    const beforeDelete = versions();
    store.write({ ...store.read(), patients: [] });
    for (let index = 0; index < 3; index++) assert.notEqual(versions()[index], beforeDelete[index]);
  });

  test(`schema ${schema}: failed validation, conflicts and transaction rollback preserve versions`, (t) => {
    const { store, patient, save, versions } = fixture(t, schema);
    const original = versions();
    const changed = patient();
    changed.appointments[0].duration = 0;
    assert.throws(() => save([changed]));
    assert.deepEqual(versions(), original);
    changed.appointments[0].duration = 45;
    assert.throws(() => store.write({ revision: 0, patients: [changed], services: [] }));
    assert.deepEqual(versions(), original);
    let rolledBackVersion;
    assert.throws(
      () =>
        store.transaction(() => {
          save([changed], undefined, { insideTransaction: true });
          rolledBackVersion = versions()[0];
          throw Error('Synthetic rollback');
        }),
      /Synthetic rollback/,
    );
    assert.notEqual(rolledBackVersion, original[0]);
    assert.deepEqual(versions(), original);
    assert.equal(patient().appointments[0].duration, 30);
    save([changed]);
    assert.notEqual(versions()[0], rolledBackVersion);
    assert.notEqual(versions()[0], original[0]);
  });

  test(`schema ${schema}: legacy absence stays empty until an exported field changes`, (t) => {
    const { store, patient, save } = fixture(t, schema);
    store.db.prepare("DELETE FROM meta WHERE key LIKE 'calendar-occupancy:%'").run();
    const changed = patient();
    changed.notes = 'Unrelated change';
    save([changed]);
    assert.equal(store.calendarOccupancyVersion('staff-a'), '');
    changed.appointments[0].time = '15:00';
    save([changed]);
    assert.match(store.calendarOccupancyVersion('staff-a'), /^[\da-f-]{36}$/);
    assert.equal(store.calendarOccupancyVersion('staff-b'), '');
  });
}

test('occupancy diff ignores unrelated fields, unassigned records and reads only deleted indexes', () => {
  const meta = new Map(),
    reads = [];
  const appointment = { id: 'a', staffId: 'staff-a', date: '2030-01-01', time: '10:00' };
  const deleted = { id: 'deleted', staffId: 'staff-b', date: '2030-01-01', time: '10:00' };
  const versions = createCalendarOccupancyVersion({
    db: { isTransaction: true },
    get: (key, fallback) => meta.get(key) ?? fallback,
    set: (key, value) => meta.set(key, value),
    hash: (value) => value,
    decode: (value) => value,
    prepare: (sql) => ({
      all: (id) => {
        assert.equal(sql, 'SELECT value FROM cabinet_appointments WHERE patient_id=?');
        reads.push(id);
        return [{ value: deleted }];
      },
    }),
  });
  const affected = versions.update(
    [
      {
        id: 'existing',
        visits: [{ photos: [{ caption: 'Changed synthetic photo' }] }],
        appointments: [
          { ...appointment, duration: 60 },
          { ...appointment, id: 'unassigned', staffId: '' },
        ],
      },
    ],
    new Set(['existing', 'removed']),
    new Map([['existing', { appointments: [appointment], visits: [] }]]),
  );
  assert.deepEqual([...affected], ['staff-b']);
  assert.deepEqual(reads, ['removed']);
  assert.equal(versions.version('staff-a'), '');
  assert.match(versions.version('staff-b'), /^[\da-f-]{36}$/);
  meta.clear();
  const moved = {
    id: 'incoming',
    name: 'Test Surname',
    appointments: [{ ...deleted, patientName: 'Ignored appointment field' }],
  };
  const ids = new Set(['removed', 'incoming']);
  const previous = new Map([['incoming', null]]);
  deleted.patientName = 'Surname Test';
  assert.deepEqual([...versions.update([moved], ids, previous)], []);
  moved.name = '';
  deleted.patientName = '';
  assert.deepEqual([...versions.update([moved], ids, previous)], []);
  delete deleted.patientName;
  assert.deepEqual([...versions.update([moved], ids, previous)], ['staff-b']);
});
