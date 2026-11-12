const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

function migrateEmailInvitations(database, directory) {
  const { db } = database;
  if (db.prepare('PRAGMA user_version').get().user_version >= 8) return;
  if (db.prepare('SELECT 1 FROM accounts LIMIT 1').get()) {
    const target = path.join(
      directory,
      'migration-backups',
      'before-008-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
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
        throw Error('Email invitation backup failed.');
    } finally {
      snapshot.close();
    }
  }
  database.transaction(() => {
    if (db.prepare('PRAGMA user_version').get().user_version >= 8) return;
    db.exec(`CREATE TABLE email_invitations (
      id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL REFERENCES invitations(token_hash) ON DELETE CASCADE,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      value BLOB NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','sent','failed','revoked')),
      created_at INTEGER NOT NULL, attempted_at INTEGER NOT NULL, sent_at INTEGER);
      CREATE INDEX email_invitation_org ON email_invitations(organization_id,created_at);
      PRAGMA user_version=8;`);
  });
}
module.exports = { migrateEmailInvitations };
