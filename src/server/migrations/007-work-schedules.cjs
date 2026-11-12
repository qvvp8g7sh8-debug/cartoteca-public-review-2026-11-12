const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
function migrateWorkSchedules(database, directory) {
  const { db } = database;
  if (db.prepare('PRAGMA user_version').get().user_version >= 7) return;
  if (db.prepare('SELECT 1 FROM accounts LIMIT 1').get()) {
    const backup = path.join(
      directory,
      'migration-backups',
      'before-007-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
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
      if (
        snapshot.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
        snapshot.prepare('PRAGMA foreign_key_check').all().length
      )
        throw Error('Work schedules backup failed.');
    } finally {
      snapshot.close();
    }
  }
  database.transaction(() => {
    if (db.prepare('PRAGMA user_version').get().user_version >= 7) return;
    db.exec(`CREATE TABLE IF NOT EXISTS work_schedule_profiles (
      organization_id TEXT NOT NULL REFERENCES organizations(id), staff_id TEXT NOT NULL,
      value BLOB NOT NULL, PRIMARY KEY(organization_id,staff_id));
      CREATE TABLE IF NOT EXISTS work_schedule_days (
      organization_id TEXT NOT NULL REFERENCES organizations(id), staff_id TEXT NOT NULL,
      date TEXT NOT NULL, value BLOB NOT NULL, PRIMARY KEY(organization_id,staff_id,date));
      CREATE INDEX IF NOT EXISTS work_schedule_date ON work_schedule_days(organization_id,date,staff_id);
      PRAGMA user_version=7;`);
  });
}
module.exports = { migrateWorkSchedules };
