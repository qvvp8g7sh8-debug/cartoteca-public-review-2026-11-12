const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

function migrateBookingRequests(database, directory) {
  const { db } = database;
  if (db.prepare('PRAGMA user_version').get().user_version >= 9) return;
  if (db.prepare('SELECT 1 FROM accounts LIMIT 1').get()) {
    const target = path.join(
      directory,
      'migration-backups',
      'before-009-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
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
        throw Error('Booking request backup failed.');
    } finally {
      snapshot.close();
    }
  }
  database.transaction(() => {
    if (db.prepare('PRAGMA user_version').get().user_version >= 9) return;
    db.exec(`CREATE TABLE booking_requests (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      staff_id TEXT NOT NULL REFERENCES accounts(id),
      request_key TEXT NOT NULL,
      value BLOB NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','requested','expired','accepted','rejected','cancelled')),
      expires_at INTEGER,
      day_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      UNIQUE(organization_id,request_key),
      CHECK((status='pending' AND expires_at IS NOT NULL) OR status!='pending'));
      CREATE INDEX booking_request_reserves ON booking_requests(organization_id,status,day_key,expires_at);
      CREATE INDEX booking_request_staff ON booking_requests(organization_id,staff_id,created_at,id);
      PRAGMA user_version=9;`);
  });
}
module.exports = { migrateBookingRequests };
