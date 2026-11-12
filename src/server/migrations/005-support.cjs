const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
function migrateSupport(db, directory) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 5) return;
  if (db.prepare('SELECT 1 FROM accounts LIMIT 1').get()) {
    const backup = path.join(
      directory,
      'migration-backups',
      'before-005-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
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
        throw Error('Support migration backup failed.');
    } finally {
      snapshot.close();
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('PRAGMA user_version').get().user_version < 5)
      db.exec(`
      CREATE TABLE IF NOT EXISTS support_requests(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),organization_id TEXT REFERENCES organizations(id),request_key TEXT NOT NULL,created_at INTEGER NOT NULL,value BLOB NOT NULL,UNIQUE(account_id,request_key));
      CREATE INDEX IF NOT EXISTS support_account_time ON support_requests(account_id,created_at);
      CREATE INDEX IF NOT EXISTS support_created ON support_requests(created_at);
      CREATE TABLE IF NOT EXISTS support_deliveries(request_id TEXT NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,channel TEXT NOT NULL CHECK(channel IN ('telegram','email')),status TEXT NOT NULL CHECK(status IN ('waiting','pending','sending','sent','failed')),attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,lease_until INTEGER NOT NULL DEFAULT 0,lease_id TEXT,PRIMARY KEY(request_id,channel));
      CREATE INDEX IF NOT EXISTS support_delivery_due ON support_deliveries(channel,status,next_at);
      PRAGMA user_version=5;`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
module.exports = { migrateSupport };
