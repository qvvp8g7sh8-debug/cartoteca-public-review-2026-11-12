const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { scheduleTables, triggers, dropTriggers } = require('./notification-schedule-schema.cjs');

// Explicit offline preparation on a complete copy; never called by server startup.
function migrateNotificationSchedule(database, directory) {
  const { db } = database;
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version === 18) return;
  if (version !== 17) throw Error('Notification schedule requires prepared schema 17.');
  const snapshotDirectory = path.join(
    directory,
    'migration-backups',
    'before-018-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
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
      snapshot.prepare('PRAGMA user_version').get().user_version !== 17 ||
      !fs.readFileSync(path.join(snapshotDirectory, 'platform.key')).equals(database.key)
    )
      throw Error('Notification schedule snapshot verification failed.');
  } finally {
    snapshot.close();
  }
  database.transaction(() => db.exec(scheduleTables + triggers() + 'PRAGMA user_version=18;'));
  return { snapshotDirectory };
}
function rollbackNotificationSchedule(database) {
  return database.transaction(() => {
    const { db } = database;
    if (db.prepare('PRAGMA user_version').get().user_version !== 18)
      throw Error('Expected notification schedule schema 18.');
    if (db.prepare('SELECT 1 FROM notification_schedule_intents LIMIT 1').get())
      throw Error(
        'Unsettled notification intents exist; recover or restore the verified complete backup.',
      );
    // These are rebuildable projections only. Version17 resumes its full scan;
    // authoritative appointments and existing sent/uncertain jobs are untouched.
    db.exec(
      dropTriggers() +
        `DROP TABLE notification_schedule;
      DROP TABLE notification_schedule_dirty; DROP TABLE notification_schedule_intents;
      PRAGMA user_version=17;`,
    );
  });
}
module.exports = { migrateNotificationSchedule, rollbackNotificationSchedule };
