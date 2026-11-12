const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
// Offline copied data only. Startup deliberately never applies this migration.
function migrateStaffPush(database, directory) {
  const { db } = database;
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version === 17) return;
  if (version !== 16) throw Error('Staff push requires prepared schema 16.');
  const snapshotDirectory = path.join(
    directory,
    'migration-backups',
    'before-017-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
  );
  fs.mkdirSync(snapshotDirectory, { recursive: true, mode: 0o700 });
  const filename = path.join(snapshotDirectory, 'platform.sqlite');
  db.exec("VACUUM INTO '" + filename.replace(/'/g, "''") + "'");
  fs.copyFileSync(
    path.join(directory, 'platform.key'),
    path.join(snapshotDirectory, 'platform.key'),
    fs.constants.COPYFILE_EXCL,
  );
  const copy = new DatabaseSync(filename, { readOnly: true });
  try {
    if (
      copy.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
      copy.prepare('PRAGMA foreign_key_check').all().length ||
      copy.prepare('PRAGMA user_version').get().user_version !== 16 ||
      !fs.readFileSync(path.join(snapshotDirectory, 'platform.key')).equals(database.key)
    )
      throw Error('Push snapshot verification failed.');
  } finally {
    copy.close();
  }
  database.transaction(() => {
    db.exec(`CREATE TABLE staff_push_config (id TEXT PRIMARY KEY, value BLOB NOT NULL);
      CREATE TABLE staff_push_devices (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      account_id TEXT NOT NULL REFERENCES accounts(id), endpoint_hash TEXT UNIQUE NOT NULL,
      value BLOB NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX staff_push_account ON staff_push_devices(organization_id,account_id);
      CREATE TABLE staff_push_jobs (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      account_id TEXT NOT NULL REFERENCES accounts(id), device_id TEXT NOT NULL,
      event_key TEXT NOT NULL, value BLOB NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','cancelled')),
      attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      lease_until INTEGER NOT NULL DEFAULT 0, lease_id TEXT,
      UNIQUE(device_id,event_key));
      CREATE INDEX staff_push_due ON staff_push_jobs(status,next_at);
      PRAGMA user_version=17;`);
    db.prepare('INSERT INTO staff_push_config VALUES(?,?)').run(
      'vapid',
      database.seal(require('web-push').generateVAPIDKeys()),
    );
  });
  return { snapshotDirectory };
}
function rollbackEmptyStaffPush(database) {
  return database.transaction(() => {
    const { db } = database;
    if (db.prepare('PRAGMA user_version').get().user_version !== 17)
      throw Error('Expected push schema 17.');
    for (const table of ['staff_push_devices', 'staff_push_jobs'])
      if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())
        throw Error('Push data exists; restore the verified complete backup.');
    db.exec(
      'DROP TABLE staff_push_jobs; DROP TABLE staff_push_devices; DROP TABLE staff_push_config; PRAGMA user_version=16;',
    );
  });
}
module.exports = { migrateStaffPush, rollbackEmptyStaffPush };
