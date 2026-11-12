const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// Candidate only: intentionally NOT registered in application/platform.cjs.
function migrateMaxConnections(database, directory) {
  const { db } = database;
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version === 12) return;
  if (version !== 11) throw Error('MAX connections require platform schema 11.');
  let snapshotDirectory = null;
  if (db.prepare('SELECT 1 FROM accounts LIMIT 1').get()) {
    snapshotDirectory = path.join(
      directory,
      'migration-backups',
      'before-012-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
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
        snapshot.prepare('PRAGMA user_version').get().user_version !== 11 ||
        !crypto.timingSafeEqual(
          fs.readFileSync(path.join(snapshotDirectory, 'platform.key')),
          database.key,
        )
      )
        throw Error('MAX migration backup verification failed.');
    } finally {
      snapshot.close();
    }
  }
  database.transaction(() => {
    const current = db.prepare('PRAGMA user_version').get().user_version;
    if (current === 12) return;
    if (current !== 11) throw Error('Platform schema changed before MAX migration.');
    db.exec(`
      CREATE TABLE max_client_links (
        organization_id TEXT NOT NULL REFERENCES organizations(id), patient_id TEXT NOT NULL,
        recipient_hash TEXT NOT NULL, value BLOB NOT NULL,
        PRIMARY KEY(organization_id,patient_id), UNIQUE(organization_id,recipient_hash));
      CREATE INDEX max_client_recipient ON max_client_links(recipient_hash);
      CREATE TABLE max_client_tokens (
        token_hash TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
        patient_id TEXT NOT NULL, issued_by TEXT NOT NULL REFERENCES accounts(id),
        expires_at INTEGER NOT NULL, used_at INTEGER, value BLOB NOT NULL);
      CREATE INDEX max_client_token_patient ON max_client_tokens(organization_id,patient_id);
      CREATE TABLE max_client_stops (
        recipient_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, value BLOB NOT NULL);
      CREATE TABLE notification_preferences (
        organization_id TEXT NOT NULL REFERENCES organizations(id), patient_id TEXT NOT NULL,
        appointment_id TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL CHECK(revision > 0),
        value BLOB NOT NULL, PRIMARY KEY(organization_id,patient_id,appointment_id));
      PRAGMA user_version=12;
    `);
  });
  return { snapshotDirectory };
}

// Empty staging schema only. Once it contains data, restore the verified full backup instead.
function rollbackEmptyMaxConnections(database) {
  return database.transaction(() => {
    const { db } = database;
    if (db.prepare('PRAGMA user_version').get().user_version !== 12)
      throw Error('Expected MAX staging schema 12.');
    for (const table of [
      'max_client_links',
      'max_client_tokens',
      'max_client_stops',
      'notification_preferences',
    ])
      if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())
        throw Error('MAX data exists; rollback requires full verified backup restoration.');
    db.exec(
      'DROP TABLE notification_preferences; DROP TABLE max_client_stops; DROP TABLE max_client_tokens; DROP TABLE max_client_links; PRAGMA user_version=11;',
    );
  });
}
module.exports = { migrateMaxConnections, rollbackEmptyMaxConnections };
