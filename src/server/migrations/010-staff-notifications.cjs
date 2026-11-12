const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
function migrateStaffNotifications(database, directory) {
  const { db } = database;
  if (db.prepare('PRAGMA user_version').get().user_version >= 10) return;
  if (db.prepare('SELECT 1 FROM accounts LIMIT 1').get()) {
    const target = path.join(
      directory,
      'migration-backups',
      'before-010-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
    );
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    const filename = path.join(target, 'platform.sqlite');
    db.exec("VACUUM INTO '" + filename.replace(/'/g, "''") + "'");
    fs.copyFileSync(
      path.join(directory, 'platform.key'),
      path.join(target, 'platform.key'),
      fs.constants.COPYFILE_EXCL,
    );
    const snapshot = new DatabaseSync(filename, { readOnly: true });
    try {
      if (
        snapshot.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
        snapshot.prepare('PRAGMA foreign_key_check').all().length
      )
        throw Error('Staff notification backup failed.');
    } finally {
      snapshot.close();
    }
  }
  database.transaction(() => {
    if (db.prepare('PRAGMA user_version').get().user_version >= 10) return;
    db.exec(`CREATE TABLE staff_telegram_links (
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      account_id TEXT NOT NULL REFERENCES accounts(id),
      chat_hash TEXT NOT NULL, value BLOB NOT NULL,
      PRIMARY KEY(organization_id,account_id), UNIQUE(organization_id,chat_hash));
      CREATE TABLE staff_telegram_tokens (
      token_hash TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      account_id TEXT NOT NULL REFERENCES accounts(id), binding_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL, used_at INTEGER);
      CREATE TABLE staff_notification_jobs (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      account_id TEXT NOT NULL REFERENCES accounts(id), event_key TEXT NOT NULL,
      value BLOB NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','cancelled')),
      attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      lease_until INTEGER NOT NULL DEFAULT 0, lease_id TEXT,
      UNIQUE(organization_id,account_id,event_key));
      CREATE INDEX staff_notification_due ON staff_notification_jobs(status,next_at);
      CREATE INDEX staff_telegram_chat ON staff_telegram_links(chat_hash);
      CREATE INDEX staff_telegram_pending ON staff_telegram_tokens(organization_id,account_id);
      PRAGMA user_version=10;`);
  });
}
module.exports = { migrateStaffNotifications };
