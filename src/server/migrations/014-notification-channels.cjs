const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// Candidate only. Never registered or applied by normal application startup.
function migrateNotificationChannels(database, directory) {
  const { db } = database;
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version === 14) return;
  if (version !== 13) throw Error('Channel delivery requires staging schema 13.');
  const snapshotDirectory = path.join(
    directory,
    'migration-backups',
    'before-014-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
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
      snapshot.prepare('PRAGMA user_version').get().user_version !== 13 ||
      !crypto.timingSafeEqual(
        fs.readFileSync(path.join(snapshotDirectory, 'platform.key')),
        database.key,
      )
    )
      throw Error('Channel delivery backup verification failed.');
  } finally {
    snapshot.close();
  }
  database.transaction(() => {
    if (db.prepare('PRAGMA user_version').get().user_version !== 13)
      throw Error('Platform schema changed before channel migration.');
    db.exec(`CREATE TABLE notification_channel_jobs (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      patient_id TEXT NOT NULL, appointment_id TEXT NOT NULL, stamp TEXT NOT NULL,
      channel TEXT NOT NULL CHECK(channel IN ('telegram','max')),
      callback_hash TEXT NOT NULL UNIQUE, value BLOB NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','reserved','sending','sent','uncertain','failed','cancelled')),
      next_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
      UNIQUE(organization_id,patient_id,appointment_id,stamp,channel));
      CREATE INDEX notification_channel_due ON notification_channel_jobs(status,next_at);`);
    const insert = db.prepare(`INSERT INTO notification_channel_jobs
      (id,organization_id,patient_id,appointment_id,stamp,channel,callback_hash,value,status,next_at,expires_at,attempt,lease_until)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const row of db.prepare('SELECT * FROM notification_jobs').all()) {
      const channel = database.open(row.value).channel;
      if (!['telegram', 'max'].includes(channel))
        throw Error('Invalid staging notification channel.');
      insert.run(
        row.id,
        row.organization_id,
        row.patient_id,
        row.appointment_id,
        row.stamp,
        channel,
        row.callback_hash,
        row.value,
        row.status,
        row.next_at,
        row.expires_at,
        row.attempt,
        row.lease_until,
      );
    }
    // Preserve old jobs and all shared receipts verbatim. They are no longer claimed.
    db.exec('PRAGMA user_version=14;');
  });
  return { snapshotDirectory };
}
function rollbackEmptyNotificationChannels(database) {
  return database.transaction(() => {
    const { db } = database;
    if (db.prepare('PRAGMA user_version').get().user_version !== 14)
      throw Error('Expected channel delivery staging schema 14.');
    for (const table of ['notification_channel_jobs', 'notification_confirmations'])
      if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())
        throw Error('Notification data exists; restore the full verified backup.');
    db.exec('DROP TABLE notification_channel_jobs; PRAGMA user_version=13;');
  });
}
module.exports = { migrateNotificationChannels, rollbackEmptyNotificationChannels };
