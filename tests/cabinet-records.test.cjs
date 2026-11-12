const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createStorage } = require('../storage.cjs');
const {
  prepareCabinetRecordsCopy,
} = require('../src/server/migrations/prepare-cabinet-records.cjs');
const { migrateCabinetRecords } = require('../src/server/migrations/002-cabinet-records.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-records-'));
  const stores = [];
  t.after(() => {
    for (const store of stores) {
      try {
        store.close();
      } catch {}
    }
    if (
      path.dirname(root) === path.resolve(os.tmpdir()) &&
      /^cartoteca-records-/.test(path.basename(root))
    )
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  });
  const source = path.join(root, 'schema1'),
    destination = path.join(root, 'schema2');
  const legacy = createStorage(source);
  const appointment = (id) => ({
    id,
    date: '2030-01-01',
    time: '10:00',
    duration: 30,
    service: 'Synthetic',
    staffId: 'owner',
  });
  const patients = ['one', 'two'].map((id) => ({
    id,
    name: 'Synthetic',
    notes: 'Unchanged history',
    createdBy: 'owner',
    visits: Array.from({ length: 20 }, (_, n) => ({
      id: `${id}-v${n}`,
      date: '2020-01-01',
      procedure: 'Synthetic',
      staffId: 'owner',
      photos: [],
    })),
    appointments: [appointment(id + '-a'), appointment(id + '-b')],
  }));
  legacy.write({ revision: 0, patients, services: [] });
  const before = legacy.read();
  legacy.close();
  const open = (directory) => {
    const store = createStorage(directory);
    stores.push(store);
    return store;
  };
  const migrate = () => prepareCabinetRecordsCopy({ source, destination, offline: true });
  return { root, source, destination, before, open, migrate };
}
const blob = (store, sql, ...args) => Buffer.from(store.db.prepare(sql).get(...args).value);
function save(store, patients, ids = patients.map((p) => p.id), extra = {}) {
  return store.write(
    { revision: store.get('revision'), patients, services: [] },
    { changedIds: { patients: ids, services: [] }, ...extra },
  );
}

test('schema 2 migration is explicit, verified and compatible with full/selected reads', (t) => {
  const f = fixture(t),
    original = f.open(f.source);
  assert.equal(original.capabilities.cabinetSchemaVersion, 1);
  assert.throws(
    () => prepareCabinetRecordsCopy({ source: f.source, destination: f.destination }),
    /Stop writers/,
  );
  f.migrate();
  const next = f.open(f.destination);
  assert.deepEqual(next.capabilities, { cabinetSchemaVersion: 2, normalizedRecords: true });
  assert.deepEqual(next.read(), f.before);
  assert.deepEqual(next.readSelected(['two', 'one', 'two']).patients, [
    f.before.patients[1],
    f.before.patients[0],
    f.before.patients[1],
  ]);
  const duplicate = next.readSelected(['one', 'one']).patients;
  duplicate[0].appointments[0].duration = 5;
  assert.equal(duplicate[1].appointments[0].duration, 30);
  assert.deepEqual(next.readPatientAppointments('one'), f.before.patients[0].appointments);
  assert.deepEqual(next.readPatientAppointments('absent'), []);
  assert.deepEqual(original.read(), f.before);
  assert.equal(original.db.prepare('PRAGMA user_version').get().user_version, 1);
  const profile = next.decode(
    next.db.prepare('SELECT value FROM patients WHERE id=?').get('one').value,
  );
  assert.ok(!Object.hasOwn(profile, 'visits') && !Object.hasOwn(profile, 'appointments'));
  assert.equal(next.db.prepare('SELECT COUNT(*) n FROM cabinet_patient_records').get().n, 44);
  assert.equal(next.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(next.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.throws(() => f.migrate(), /must not exist/);
  assert.throws(
    () =>
      prepareCabinetRecordsCopy({
        source: f.source,
        destination: path.join(f.source, 'nested'),
        offline: true,
      }),
    /outside/,
  );
  const snapshot = new DatabaseSync(
    path.join(f.destination, 'migration-backups/before-records-002/cabinet.sqlite'),
    { readOnly: true },
  );
  assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 1);
  snapshot.close();
});

test('canonical appointment reads do not decrypt profile/history and enforce patient ownership', (t) => {
  const f = fixture(t),
    original = f.open(f.source);
  f.migrate();
  const store = f.open(f.destination);
  assert.deepEqual(original.readAppointment('one', 'one-a'), f.before.patients[0].appointments[0]);
  assert.equal(original.readAppointment('two', 'one-a'), null);
  store.db
    .prepare("UPDATE cabinet_patient_records SET value=? WHERE kind='visit'")
    .run(Buffer.from('corrupt synthetic history'));
  store.db.prepare('UPDATE patients SET value=?').run(Buffer.from('corrupt synthetic profile'));
  assert.deepEqual(store.readPatientAppointments('one'), f.before.patients[0].appointments);
  assert.deepEqual(store.readAppointment('one', 'one-a'), f.before.patients[0].appointments[0]);
  assert.equal(store.readAppointment('two', 'one-a'), null);
  assert.equal(store.readAppointment('absent', 'one-a'), null);
  assert.equal(store.readAppointment('one', 'absent'), null);
  assert.throws(() => store.read());
});

test('one appointment edit preserves profile, visit history and other appointment ciphertexts', (t) => {
  const f = fixture(t);
  f.migrate();
  const store = f.open(f.destination);
  const profile = blob(store, 'SELECT value FROM patients WHERE id=?', 'one');
  const history = store.db
    .prepare("SELECT * FROM cabinet_patient_records WHERE kind='visit' ORDER BY id")
    .all();
  const unaffected = blob(
    store,
    "SELECT value FROM cabinet_patient_records WHERE kind='appointment' AND id=?",
    'one-b',
  );
  const selected = store.readSelected(['one']).patients;
  selected[0].appointments[0].time = '11:00';
  save(store, selected);
  assert.deepEqual(blob(store, 'SELECT value FROM patients WHERE id=?', 'one'), profile);
  assert.deepEqual(
    store.db.prepare("SELECT * FROM cabinet_patient_records WHERE kind='visit' ORDER BY id").all(),
    history,
  );
  assert.deepEqual(
    blob(
      store,
      "SELECT value FROM cabinet_patient_records WHERE kind='appointment' AND id=?",
      'one-b',
    ),
    unaffected,
  );
  assert.equal(store.readPatientAppointments('one')[0].time, '11:00');
  assert.equal(
    store.calendarSnapshot('2030-01-01', '2030-01-01').appointments.find((a) => a.id === 'one-a')
      .time,
    '11:00',
  );
  const updatedHistory = store.readSelected(['one']).patients;
  updatedHistory[0].visits[0].procedure = 'Changed synthetic';
  save(store, updatedHistory);
  const remaining = store.db
    .prepare("SELECT * FROM cabinet_patient_records WHERE kind='visit' AND id<>? ORDER BY id")
    .all('one-v0');
  assert.deepEqual(
    remaining,
    history.filter((row) => row.id !== 'one-v0'),
  );
});

test('record moves, removals, reorder and transaction rollback preserve canonical and derived rows', (t) => {
  const f = fixture(t);
  f.migrate();
  const store = f.open(f.destination);
  const values = store.read().patients,
    a = values[0].appointments.shift(),
    b = values[1].appointments.shift();
  values[0].appointments.push(b);
  values[1].appointments.push(a);
  values[0].visits.reverse();
  save(store, values);
  assert.deepEqual(store.read().patients, values);
  assert.equal(
    store.calendarSnapshot('2030-01-01', '2030-01-01').appointments.find((row) => row.id === a.id)
      .patientId,
    'two',
  );
  const before = store.read(),
    rows = store.db.prepare('SELECT * FROM cabinet_patient_records ORDER BY kind,id').all();
  const changed = structuredClone(values);
  changed[0].visits = [];
  changed[0].appointments[0].duration = 5;
  assert.throws(
    () =>
      store.transaction(() => {
        save(store, changed, undefined, { insideTransaction: true });
        throw Error('Synthetic rollback');
      }),
    /Synthetic rollback/,
  );
  assert.deepEqual(store.read(), before);
  assert.deepEqual(
    store.db.prepare('SELECT * FROM cabinet_patient_records ORDER BY kind,id').all(),
    rows,
  );
  save(store, [], ['one']);
  assert.equal(
    store.db.prepare('SELECT COUNT(*) n FROM cabinet_patient_records WHERE patient_id=?').get('one')
      .n,
    0,
  );
  assert.equal(
    store.db.prepare('SELECT COUNT(*) n FROM cabinet_appointments WHERE patient_id=?').get('one').n,
    0,
  );
});

test('rollback copy materializes current normalized data including post-migration writes', (t) => {
  const f = fixture(t);
  f.migrate();
  const store = f.open(f.destination);
  const patient = store.readSelected(['one']).patients[0];
  patient.appointments[0].duration = 5;
  patient.visits.push({ id: 'new-v', date: '2020-02-01', procedure: 'New synthetic', photos: [] });
  save(store, [patient]);
  const expected = store.read();
  const returned = path.join(f.root, 'returned');
  prepareCabinetRecordsCopy({
    source: f.destination,
    destination: returned,
    offline: true,
    rollback: true,
  });
  const restored = f.open(returned);
  assert.equal(restored.capabilities.cabinetSchemaVersion, 1);
  assert.deepEqual(restored.read(), expected);
  assert.deepEqual(store.read(), expected);
  assert.deepEqual(restored.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('failed transformation rolls back DDL and refuses activation of incomplete copy', (t) => {
  const f = fixture(t),
    source = f.open(f.source),
    before = source.read();
  let count = 0;
  assert.throws(
    () =>
      migrateCabinetRecords({
        db: source.db,
        decode: source.decode,
        encode(value) {
          if (++count === 3) throw Error('Synthetic encode failure');
          return source.encode(value);
        },
      }),
    /Synthetic encode failure/,
  );
  assert.deepEqual(source.read(), before);
  assert.equal(source.db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(
    source.db.prepare("SELECT 1 FROM sqlite_master WHERE name='cabinet_patient_records'").get(),
    undefined,
  );
  source.db
    .prepare('UPDATE patients SET value=? WHERE id=?')
    .run(Buffer.from('broken cipher'), 'one');
  assert.throws(() => f.migrate());
  assert.ok(fs.existsSync(path.join(f.destination, '.cabinet-records-in-progress')));
  assert.throws(() => createStorage(f.destination), /Incomplete cabinet/);
});

test('schema 2 prepared cipher ticket works once and keeps unchanged history untouched', (t) => {
  const f = fixture(t);
  f.migrate();
  const store = f.open(f.destination);
  const before = store.readSelected(['one']),
    next = structuredClone(before);
  next.patients[0].appointments[0].duration = 10;
  const ids = { patients: ['one'], services: [] };
  const ticket = store.prepareWrite(before, next, { changedIds: ids });
  assert.ok(ticket);
  const history = store.db
    .prepare("SELECT value FROM cabinet_patient_records WHERE kind='visit' ORDER BY id")
    .all();
  store.write(next, { changedIds: ids, preparedWrite: ticket, preparedBefore: before });
  assert.deepEqual(
    store.db
      .prepare("SELECT value FROM cabinet_patient_records WHERE kind='visit' ORDER BY id")
      .all(),
    history,
  );
  assert.equal(store.readPatientAppointments('one')[0].duration, 10);
  assert.equal(store.readCacheBudget.stats().entries >= 0, true);
});
