const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// Explicit preparation only. Normal application startup never applies this migration.
function migrateMaxInbox(database, directory) {
  const { db } = database;
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version === 15) return;
  if (version !== 14) throw Error('MAX inbox requires prepared schema 14.');
  const snapshotDirectory = path.join(
    directory,
    'migration-backups',
    'before-015-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
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
      snapshot.prepare('PRAGMA user_version').get().user_version !== 14 ||
      !crypto.timingSafeEqual(
        fs.readFileSync(path.join(snapshotDirectory, 'platform.key')),
        database.key,
      )
    )
      throw Error('MAX inbox snapshot verification failed.');
  } finally {
    snapshot.close();
  }
  database.transaction(() => {
    if (db.prepare('PRAGMA user_version').get().user_version !== 14)
      throw Error('Platform schema changed before MAX inbox migration.');
    db.exec(`CREATE TABLE max_event_inbox (
      id TEXT PRIMARY KEY, bot_hash TEXT NOT NULL, event_hash TEXT NOT NULL UNIQUE,
      value BLOB NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','processing','done','failed')),
      created_at INTEGER NOT NULL, next_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0, lease_id TEXT);
      CREATE INDEX max_inbox_due ON max_event_inbox(bot_hash,status,next_at);
      CREATE INDEX max_inbox_retention ON max_event_inbox(expires_at);
      CREATE TABLE max_runtime_leases (bot_hash TEXT PRIMARY KEY, owner TEXT NOT NULL, lease_until INTEGER NOT NULL);
      PRAGMA user_version=15;`);
  });
  return { snapshotDirectory };
}
function rollbackEmptyMaxInbox(database) {
  return database.transaction(() => {
    if (database.db.prepare('PRAGMA user_version').get().user_version !== 15)
      throw Error('Expected prepared schema 15.');
    if (database.db.prepare('SELECT 1 FROM max_event_inbox LIMIT 1').get())
      throw Error('MAX events exist; restore the full verified backup.');
    if (database.db.prepare('SELECT 1 FROM max_runtime_leases LIMIT 1').get())
      throw Error('Stop all MAX workers before rollback.');
    database.db.exec(
      'DROP TABLE max_runtime_leases; DROP TABLE max_event_inbox; PRAGMA user_version=14;',
    );
  });
}
module.exports = { migrateMaxInbox, rollbackEmptyMaxInbox };
