const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// Candidate: explicit offline preparation only; never registered as a startup migration.
function migrateStaffMax(database, directory) {
  const { db } = database;
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version === 16) return;
  if (version !== 15) throw Error('Staff MAX requires a separately prepared schema 15.');
  const snapshotDirectory = path.join(
    directory,
    'migration-backups',
    'before-016-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
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
      snapshot.prepare('PRAGMA user_version').get().user_version !== 15 ||
      !crypto.timingSafeEqual(
        fs.readFileSync(path.join(snapshotDirectory, 'platform.key')),
        database.key,
      )
    )
      throw Error('Staff MAX snapshot verification failed.');
  } finally {
    snapshot.close();
  }
  database.transaction(() => {
    if (db.prepare('PRAGMA user_version').get().user_version !== 15)
      throw Error('Platform schema changed before staff MAX migration.');
    db.exec(`CREATE TABLE staff_max_links (
      organization_id TEXT NOT NULL REFERENCES organizations(id), account_id TEXT NOT NULL REFERENCES accounts(id),
      chat_hash TEXT NOT NULL, value BLOB NOT NULL,
      PRIMARY KEY(organization_id,account_id), UNIQUE(organization_id,chat_hash));
      CREATE INDEX staff_max_chat ON staff_max_links(chat_hash);
      CREATE TABLE staff_max_tokens (
      token_hash TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      account_id TEXT NOT NULL REFERENCES accounts(id), binding_id TEXT NOT NULL,
      issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, value BLOB NOT NULL);
      CREATE INDEX staff_max_token_account ON staff_max_tokens(organization_id,account_id);
      CREATE TABLE staff_max_stops (chat_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, value BLOB NOT NULL);
      CREATE TABLE staff_max_jobs (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      account_id TEXT NOT NULL REFERENCES accounts(id), event_key TEXT NOT NULL, value BLOB NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','cancelled','uncertain')),
      attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      lease_until INTEGER NOT NULL DEFAULT 0, lease_id TEXT,
      UNIQUE(organization_id,account_id,event_key));
      CREATE INDEX staff_max_due ON staff_max_jobs(status,next_at);
      PRAGMA user_version=16;`);
  });
  return { snapshotDirectory };
}
function rollbackEmptyStaffMax(database) {
  return database.transaction(() => {
    const { db } = database;
    if (db.prepare('PRAGMA user_version').get().user_version !== 16)
      throw Error('Expected staff MAX staging schema 16.');
    for (const table of [
      'staff_max_links',
      'staff_max_tokens',
      'staff_max_jobs',
      'staff_max_stops',
    ])
      if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())
        throw Error('Staff MAX data exists; restore the full verified backup.');
    if (db.prepare('SELECT 1 FROM max_runtime_leases LIMIT 1').get())
      throw Error('Stop MAX workers before rollback.');
    db.exec(
      'DROP TABLE staff_max_jobs; DROP TABLE staff_max_stops; DROP TABLE staff_max_tokens; DROP TABLE staff_max_links; PRAGMA user_version=15;',
    );
  });
}
module.exports = { migrateStaffMax, rollbackEmptyStaffMax };
