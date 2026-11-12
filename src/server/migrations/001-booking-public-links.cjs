const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { safeTree, plainFile } = require('../infrastructure/backup/snapshot.cjs');
const { configureSqlite } = require('../infrastructure/sqlite-configuration.cjs');
const { schema, validate } = require('../infrastructure/booking-public-links-schema.cjs');

// Only a recovered offline copy can gain component-v1. The historical platform
// version remains untouched; in particular this never activates schema18.
function migrateBookingPublicLinks(directory, { rollback = false } = {}) {
  directory = path.resolve(directory);
  safeTree(directory);
  const marker = path.join(path.dirname(directory), '.restore-in-progress');
  plainFile(marker);
  if (fs.readFileSync(marker, 'utf8') !== 'booking-public-links-preparation-v1')
    throw Error('Public booking links require an offline preparation copy');
  const filename = path.join(directory, 'platform.sqlite');
  plainFile(filename);
  const db = new DatabaseSync(filename);
  try {
    configureSqlite(db);
    const platformVersion = db.prepare('PRAGMA user_version').get().user_version;
    if (![11, 12, 13, 14, 15, 16, 17, 18].includes(platformVersion))
      throw Error('Unsupported public booking links platform schema');
    db.exec('BEGIN IMMEDIATE');
    const previous = validate(db);
    if (rollback ? !previous : Boolean(previous))
      throw Error('Unexpected source public booking links component');
    if (!rollback) db.exec(schema);
    // Roll back the application, not published identities: retaining these
    // additive tables is compatible with older binaries and preserves every code.
    validate(db);
    if (
      db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').all().length
    )
      throw Error('Public booking links preparation integrity failed');
    const mappingsPreserved = db.prepare('SELECT count(*) n FROM booking_public_links').get().n;
    db.exec('COMMIT');
    return {
      componentVersion: 1,
      platformVersion,
      mappingsPreserved,
      rollbackPreservesComponent: rollback,
    };
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
}
module.exports = { migrateBookingPublicLinks };
