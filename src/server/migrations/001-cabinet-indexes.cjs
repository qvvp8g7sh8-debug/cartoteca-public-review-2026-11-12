const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
// Cabinet versions are independent from platform versions. Original encrypted rows stay intact.
function migrateCabinetIndexes({ db, directory, rebuild }) {
  const version = () => db.prepare('PRAGMA user_version').get().user_version;
  if (version() > 1) throw Error('Unsupported cabinet database version');
  if (version() === 1) return;
  if (db.prepare('SELECT 1 FROM patients UNION ALL SELECT 1 FROM services LIMIT 1').get()) {
    const backup = path.join(
      directory,
      'migration-backups',
      'before-indexes-001-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
    );
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    const filename = path.join(backup, 'cabinet.sqlite');
    db.exec("VACUUM INTO '" + filename.replace(/'/g, "''") + "'");
    fs.copyFileSync(
      path.join(directory, 'encryption.key'),
      path.join(backup, 'encryption.key'),
      fs.constants.COPYFILE_EXCL,
    );
    const snapshot = new DatabaseSync(filename, { readOnly: true });
    try {
      if (snapshot.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok')
        throw Error('Cabinet migration backup verification failed');
    } finally {
      snapshot.close();
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // A second worker may have finished migration while this worker prepared its snapshot.
    if (version() === 0) {
      db.exec(`
        CREATE TABLE cabinet_summaries(patient_id TEXT NOT NULL,audience TEXT NOT NULL,value BLOB NOT NULL,PRIMARY KEY(patient_id,audience));
        CREATE INDEX cabinet_summary_audience ON cabinet_summaries(audience,patient_id);
        CREATE TABLE cabinet_patient_counts(patient_id TEXT PRIMARY KEY,photo_count INTEGER NOT NULL);
        CREATE TABLE cabinet_record_ids(kind TEXT NOT NULL,id TEXT NOT NULL,patient_id TEXT NOT NULL,PRIMARY KEY(kind,id));
        CREATE INDEX cabinet_record_patient ON cabinet_record_ids(patient_id);
        CREATE TABLE cabinet_appointments(id TEXT PRIMARY KEY,patient_id TEXT NOT NULL,value BLOB NOT NULL);
        CREATE INDEX cabinet_appointment_patient ON cabinet_appointments(patient_id);
        CREATE TABLE cabinet_days(day_hash TEXT NOT NULL,appointment_id TEXT NOT NULL,PRIMARY KEY(day_hash,appointment_id));
        CREATE INDEX cabinet_day_appointment ON cabinet_days(appointment_id);
        CREATE TABLE cabinet_photo_refs(photo_id TEXT NOT NULL,patient_id TEXT NOT NULL,audience TEXT NOT NULL,PRIMARY KEY(photo_id,patient_id,audience));
        CREATE INDEX cabinet_photo_patient ON cabinet_photo_refs(patient_id);
      `);
      rebuild();
      db.exec('PRAGMA user_version=1');
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
module.exports = { migrateCabinetIndexes };
