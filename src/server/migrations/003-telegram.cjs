const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
function migrateTelegram(db, directory) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version >= 3) return;
  // Back up existing accounts and their key before changing an actual platform.
  if (db.prepare('SELECT 1 FROM accounts LIMIT 1').get()) {
    const backup = path.join(
      directory,
      'migration-backups',
      'before-003-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
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
    db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_settings(organization_id TEXT PRIMARY KEY REFERENCES organizations(id),value BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_links(organization_id TEXT NOT NULL REFERENCES organizations(id),patient_id TEXT NOT NULL,chat_hash TEXT NOT NULL,value BLOB NOT NULL,PRIMARY KEY(organization_id,patient_id),UNIQUE(organization_id,chat_hash));
      CREATE TABLE IF NOT EXISTS telegram_link_tokens(token_hash TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id),patient_id TEXT NOT NULL,issued_by TEXT NOT NULL REFERENCES accounts(id),expires_at INTEGER NOT NULL,used_at INTEGER);
      CREATE TABLE IF NOT EXISTS telegram_jobs(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id),patient_id TEXT NOT NULL,fingerprint TEXT NOT NULL,callback_hash TEXT UNIQUE NOT NULL,value BLOB NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,lease_until INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL,UNIQUE(organization_id,patient_id,fingerprint));
      CREATE INDEX IF NOT EXISTS telegram_jobs_due ON telegram_jobs(status,next_at);
      CREATE TABLE IF NOT EXISTS telegram_confirmations(organization_id TEXT NOT NULL,patient_id TEXT NOT NULL,fingerprint TEXT NOT NULL,chat_hash TEXT NOT NULL,confirmed_at INTEGER NOT NULL,PRIMARY KEY(organization_id,patient_id,fingerprint));
      CREATE TABLE IF NOT EXISTS telegram_runtime(key TEXT PRIMARY KEY,value BLOB NOT NULL);
      PRAGMA user_version=3;
      COMMIT;
    `);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
module.exports = { migrateTelegram };
