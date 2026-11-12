const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { DEFAULT_TIME_ZONE, timeZoneRule } = require('../modules/organizations/time-zone.cjs');
function migrateOrganizationTimeZone(database, directory) {
  const { db, open, seal } = database;
  if (db.prepare('PRAGMA user_version').get().user_version >= 6) return;
  if (db.prepare('SELECT 1 FROM accounts LIMIT 1').get()) {
    const backup = path.join(
      directory,
      'migration-backups',
      'before-006-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
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
        throw Error('Organization timezone backup failed.');
    } finally {
      snapshot.close();
    }
  }
  database.transaction(() => {
    if (db.prepare('PRAGMA user_version').get().user_version >= 6) return;
    for (const row of db.prepare('SELECT id,value FROM organizations ORDER BY id').iterate()) {
      const organization = open(row.value);
      if (organization.timeZone !== undefined) {
        timeZoneRule(organization.timeZone, (status, message) => Error(message));
        continue;
      }
      const legacy = db
        .prepare('SELECT value FROM telegram_settings WHERE organization_id=?')
        .get(row.id);
      const zone = timeZoneRule(
        (legacy && open(legacy.value).timeZone) || DEFAULT_TIME_ZONE,
        (status, message) => Error(message),
      );
      db.prepare('UPDATE organizations SET value=? WHERE id=?').run(
        seal({ ...organization, timeZone: zone }),
        row.id,
      );
    }
    db.exec('PRAGMA user_version=6');
  });
}
module.exports = { migrateOrganizationTimeZone };
