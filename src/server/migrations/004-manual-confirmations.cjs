const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
function migrateManualConfirmations(db, directory) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 4) return;
  if (db.prepare('SELECT 1 FROM accounts LIMIT 1').get()) {
    const backup = path.join(
      directory,
      'migration-backups',
      'before-004-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
    );
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    const filename = path.join(backup, 'platform.sqlite');
    db.exec("VACUUM INTO '" + filename.replace(/'/g, "''") + "'");
    fs.copyFileSync(
      path.join(directory, 'platform.key'),
      path.join(backup, 'platform.key'),
      fs.constants.COPYFILE_EXCL,
    );
    const snapshot = new DatabaseSync(filename, { readOnly: true });
    try {
      if (snapshot.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok')
        throw Error('Migration backup integrity check failed.');
    } finally {
      snapshot.close();
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('PRAGMA user_version').get().user_version < 4)
      db.exec(`CREATE TABLE IF NOT EXISTS appointment_manual_confirmations(
      organization_id TEXT NOT NULL REFERENCES organizations(id),patient_id TEXT NOT NULL,appointment_id TEXT NOT NULL,value BLOB NOT NULL,
      PRIMARY KEY(organization_id,patient_id,appointment_id)); PRAGMA user_version=4;`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
module.exports = { migrateManualConfirmations };
