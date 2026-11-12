const { patientProfile, createPatientRecords } = require('../infrastructure/cabinet-records.cjs');
const { isDeepStrictEqual } = require('node:util');

// Explicit copy preparation only. Never registered as an automatic startup migration.
function migrateCabinetRecords({ db, encode, decode }) {
  if (db.isTransaction) throw Error('Cabinet migration requires an offline prepared copy');
  if (db.prepare('PRAGMA user_version').get().user_version !== 1)
    throw Error('Cabinet records migration requires schema 1');
  db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE cabinet_patient_records(
      kind TEXT NOT NULL CHECK(kind IN ('visit','appointment')),
      id TEXT NOT NULL, patient_id TEXT NOT NULL REFERENCES patients(id),
      position INTEGER NOT NULL CHECK(position>=0), value BLOB NOT NULL,
      PRIMARY KEY(kind,id), UNIQUE(patient_id,kind,position)
    ); CREATE INDEX cabinet_patient_record_owner ON cabinet_patient_records(patient_id,kind,position);`);
    const insert = db.prepare(
      'INSERT INTO cabinet_patient_records(kind,id,patient_id,position,value) VALUES(?,?,?,?,?)',
    );
    const update = db.prepare('UPDATE patients SET value=? WHERE id=?');
    for (const row of db.prepare('SELECT id,value FROM patients ORDER BY rowid').all()) {
      const patient = decode(row.value);
      if (
        !patient ||
        patient.id !== row.id ||
        !Array.isArray(patient.visits) ||
        !Array.isArray(patient.appointments)
      )
        throw Error('Invalid patient during cabinet migration');
      for (const [kind, collection] of [
        ['visit', 'visits'],
        ['appointment', 'appointments'],
      ])
        patient[collection].forEach((record, position) => {
          if (!record || typeof record.id !== 'string' || !record.id)
            throw Error('Invalid canonical record');
          insert.run(kind, record.id, row.id, position, encode(record));
        });
      update.run(encode(patientProfile(patient)), row.id);
      const stored = db
        .prepare(
          'SELECT kind,value FROM cabinet_patient_records WHERE patient_id=? ORDER BY kind,position',
        )
        .all(row.id);
      const restored = {
        ...decode(db.prepare('SELECT value FROM patients WHERE id=?').get(row.id).value),
        visits: stored.filter((r) => r.kind === 'visit').map((r) => decode(r.value)),
        appointments: stored.filter((r) => r.kind === 'appointment').map((r) => decode(r.value)),
      };
      if (!isDeepStrictEqual(restored, patient))
        throw Error('Cabinet migration content verification failed');
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw Error('Cabinet migration integrity failed');
    db.exec('PRAGMA user_version=2; COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
// Downgrade materializes CURRENT data in another fresh copy, not an old snapshot.
function rollbackCabinetRecords({ db, encode, decode }) {
  if (db.isTransaction || db.prepare('PRAGMA user_version').get().user_version !== 2)
    throw Error('Cabinet records rollback requires an offline schema 2 copy');
  const records = createPatientRecords({ db, encode, decode });
  db.exec('BEGIN IMMEDIATE');
  try {
    const put = db.prepare('UPDATE patients SET value=? WHERE id=?');
    for (const row of db.prepare('SELECT id,value FROM patients ORDER BY rowid').all()) {
      const patient = records.hydrate([row])[0];
      const encoded = encode(patient);
      if (!isDeepStrictEqual(decode(encoded), patient))
        throw Error('Cabinet rollback content verification failed');
      put.run(encoded, row.id);
    }
    db.exec('DROP TABLE cabinet_patient_records; PRAGMA user_version=1; COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
module.exports = { migrateCabinetRecords, rollbackCabinetRecords };
