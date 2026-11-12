const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { safeTree, plainFile } = require('../infrastructure/backup/snapshot.cjs');
const { configureSqlite } = require('../infrastructure/sqlite-configuration.cjs');
const { validatePaidSchema } = require('../modules/billing/prepared-schema.cjs');
const { schema, validate } = require('../infrastructure/notification-maintenance-schema.cjs');
function migrateNotificationMaintenance(directory, { rollback = false } = {}) {
  directory = path.resolve(directory);
  safeTree(directory);
  const marker = path.join(path.dirname(directory), '.restore-in-progress');
  plainFile(marker);
  if (fs.readFileSync(marker, 'utf8') !== 'notification-queue-maintenance-preparation-v1')
    throw Error('Notification maintenance requires an offline preparation copy');
  const filename = path.join(directory, 'platform.sqlite');
  plainFile(filename);
  const db = new DatabaseSync(filename);
  try {
    configureSqlite(db);
    const platformVersion = db.prepare('PRAGMA user_version').get().user_version;
    if (![19, 20].includes(platformVersion))
      throw Error('Unsupported notification maintenance platform schema');
    validatePaidSchema(db);
    db.exec('BEGIN IMMEDIATE');
    const previous = validate(db);
    if (rollback ? !previous : Boolean(previous))
      throw Error('Unexpected source notification maintenance component');
    if (!rollback) db.exec(schema);
    validate(db, { required: true });
    validatePaidSchema(db);
    if (
      db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').all().length
    )
      throw Error('Notification maintenance preparation integrity failed');
    db.exec('COMMIT');
    // No queue state or identity changes. Older binaries can use these additive
    // indexes; rollback disables the feature and retains the validated component.
    return { componentVersion: 1, platformVersion, rollbackPreservesComponent: rollback };
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
}
module.exports = { migrateNotificationMaintenance };
