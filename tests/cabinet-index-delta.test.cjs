const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createStorage } = require('../storage.cjs');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-index-delta-'));
  const store = createStorage(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const appointment = (id, staffId = 'staff-a') => ({ id, staffId, date: '2030-01-01', time: '23:45', duration: 30, service: 'Synthetic' });
  const patients = ['one', 'two'].map((id) => ({ id, name: id, phone: '', createdBy: 'owner',
    visits: Array.from({ length: 80 }, (_, i) => ({ id: `${id}-v${i}`, staffId: 'staff-a', date: '2020-01-01', procedure: 'Synthetic', photos: [] })),
    appointments: [appointment(id + '-a'), appointment(id + '-b')] }));
  store.write({ revision: 0, patients, services: [] });
  const save = (values, extra = {}) => store.write({ revision: store.get('revision'), patients: values, services: [] },
    { changedIds: { patients: values.map((p) => p.id), services: [] }, ...extra });
  const value = (id) => Buffer.from(store.db.prepare('SELECT value FROM cabinet_appointments WHERE id=?').get(id).value);
  return { store, save, value };
}
test('appointment edits preserve unrelated encrypted indexes and visit/photo rows', (t) => {
  const { store, save, value } = fixture(t);
  const before = value('one-b'), unrelated = value('two-a');
  const visitRows = store.db.prepare("SELECT rowid,* FROM cabinet_record_ids WHERE kind='visit'").all();
  const counts = store.db.prepare('SELECT rowid,* FROM cabinet_patient_counts').all();
  const patient = store.readSelected(['one']).patients[0];
  patient.appointments[0].duration = 5;
  patient.appointments[0].staffId = 'staff-b';
  save([patient]);
  assert.deepEqual(value('one-b'), before);
  assert.deepEqual(value('two-a'), unrelated);
  assert.deepEqual(store.db.prepare("SELECT rowid,* FROM cabinet_record_ids WHERE kind='visit'").all(), visitRows);
  assert.deepEqual(store.db.prepare('SELECT rowid,* FROM cabinet_patient_counts').all(), counts);
  const tomorrow = store.calendarSnapshot('2030-01-02', '2030-01-02').appointments;
  assert.ok(!tomorrow.some((a) => a.id === 'one-a'));
  assert.ok(tomorrow.some((a) => a.id === 'one-b'));
  assert.equal(store.calendarSnapshot('2030-01-01', '2030-01-01', { staffId: 'staff-b' }).appointments.length, 1);
  assert.ok(!store.calendarSnapshot('2030-01-01', '2030-01-01', { staffId: 'staff-a' }).appointments.some((a) => a.id === 'one-a'));
  const unchanged = value('one-a');
  save([patient]);
  assert.deepEqual(value('one-a'), unchanged, 'identical full patient does not rewrite indexes');
});
test('delta removes all old appointment ids before inserts across patients and rolls back together', (t) => {
  const { store, save } = fixture(t);
  const [one, two] = store.readSelected(['one', 'two']).patients;
  const first = one.appointments.shift(), second = two.appointments.shift();
  one.appointments.push(second); two.appointments.push(first);
  save([one, two]);
  const entries = store.calendarSnapshot('2030-01-01', '2030-01-02').appointments;
  assert.equal(entries.find((a) => a.id === first.id).patientId, 'two');
  assert.equal(entries.find((a) => a.id === second.id).patientId, 'one');
  const before = store.read(), indexed = store.db.prepare('SELECT id,value FROM cabinet_appointments ORDER BY id').all();
  one.appointments = [];
  assert.throws(() => store.transaction(() => {
    save([one], { insideTransaction: true });
    throw Error('Synthetic rollback');
  }), /Synthetic rollback/);
  assert.deepEqual(store.read(), before);
  assert.deepEqual(store.db.prepare('SELECT id,value FROM cabinet_appointments ORDER BY id').all(), indexed);
});
test('contact/history changes use full replacement and deletion keeps indexes consistent', (t) => {
  const { store, save } = fixture(t);
  const patient = store.readSelected(['one']).patients[0];
  patient.name = 'Updated synthetic'; patient.phone = '+79999999999';
  patient.visits.push({ id: 'new-visit', date: '2030-01-01', procedure: 'Synthetic', photos: [], staffId: 'staff-b' });
  patient.appointments = patient.appointments.slice(1);
  save([patient]);
  assert.equal(store.indexes.summaries({ role: 'cosmetologist', accountId: 'staff-b' })[0].visitCount, 1);
  const appointment = store.calendarSnapshot('2030-01-01', '2030-01-02').appointments.find((a) => a.patientId === 'one');
  assert.equal(appointment.patientName, 'synthetic Updated'); // Existing surname-first projection.
  assert.equal(appointment.patientPhone, '+79999999999');
  store.write({ revision: store.get('revision'), patients: [], services: [] }, { changedIds: { patients: ['one'], services: [] } });
  for (const table of ['cabinet_summaries', 'cabinet_appointments', 'cabinet_record_ids', 'cabinet_patient_counts'])
    assert.equal(store.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE patient_id=?`).get('one').n, 0);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
});
