const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// Candidate only. Registration/application requires the separately authorized migration stage.
function migrateNotificationQueue(database, directory) {
  const { db } = database;
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version === 13) return;
  if (version !== 12) throw Error('Notification queue requires MAX staging schema 12.');
  let snapshotDirectory = null;
  if (db.prepare('SELECT 1 FROM accounts LIMIT 1').get()) {
    snapshotDirectory = path.join(
      directory,
      'migration-backups',
      'before-013-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
    );
    fs.mkdirSync(snapshotDirectory, { recursive: true, mode: 0o700 });
    const filename = path.join(snapshotDirectory, 'platform.sqlite');
    db.exec("VACUUM INTO '" + filename.replace(/'/g, "''") + "'");
    fs.copyFileSync(
      path.join(directory, 'platform.key'),
      path.join(snapshotDirectory, 'platform.key'),
      fs.constants.COPYFILE_EXCL,
    );
    const snapshot = new DatabaseSync(filename, { readOnly: true });
    try {
      if (
        snapshot.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
        snapshot.prepare('PRAGMA foreign_key_check').all().length ||
        snapshot.prepare('PRAGMA user_version').get().user_version !== 12 ||
        !crypto.timingSafeEqual(
          fs.readFileSync(path.join(snapshotDirectory, 'platform.key')),
          database.key,
        )
      )
        throw Error('Notification migration backup verification failed.');
    } finally {
      snapshot.close();
    }
  }
  database.transaction(() => {
    if (db.prepare('PRAGMA user_version').get().user_version !== 12)
      throw Error('Platform schema changed before notification migration.');
    db.exec(`
      CREATE TABLE notification_jobs (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
        patient_id TEXT NOT NULL, appointment_id TEXT NOT NULL, stamp TEXT NOT NULL,
        callback_hash TEXT NOT NULL UNIQUE, value BLOB NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','reserved','sending','sent','uncertain','failed','cancelled')),
        next_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
        UNIQUE(organization_id,patient_id,appointment_id,stamp));
      CREATE INDEX notification_due ON notification_jobs(status,next_at);
      CREATE TABLE notification_confirmations (
        organization_id TEXT NOT NULL REFERENCES organizations(id), patient_id TEXT NOT NULL,
        appointment_id TEXT NOT NULL, stamp TEXT NOT NULL, value BLOB NOT NULL,
        PRIMARY KEY(organization_id,patient_id,appointment_id,stamp));
      PRAGMA user_version=13;
    `);
  });
  return { snapshotDirectory };
}
function rollbackEmptyNotificationQueue(database) {
  return database.transaction(() => {
    const { db } = database;
    if (db.prepare('PRAGMA user_version').get().user_version !== 13)
      throw Error('Expected notification staging schema 13.');
    for (const table of ['notification_jobs', 'notification_confirmations'])
      if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())
        throw Error('Notification data exists; restore the full verified backup.');
    db.exec(
      'DROP TABLE notification_confirmations; DROP TABLE notification_jobs; PRAGMA user_version=12;',
    );
  });
}
module.exports = { migrateNotificationQueue, rollbackEmptyNotificationQueue };
