const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { syncFile, syncDirectory } = require('../infrastructure/backup/durable.cjs');
const {
  multiServiceSchema,
  validateMultiServiceSchema,
} = require('../modules/billing/multi-service-schema.cjs');
// Explicit offline operation, never called from startup. Caller stops every writer first.
function migrateMultiServiceBilling(database, directory, { offline = false } = {}) {
  if (!offline) throw Error('Stop every writer before preparing multi-service billing.');
  const { db } = database,
    version = db.prepare('PRAGMA user_version').get().user_version;
  if (version === 20) {
    validateMultiServiceSchema(db);
    return { alreadyPrepared: true };
  }
  if (version !== 19) throw Error('Multi-service billing requires prepared schema19.');
  const snapshotDirectory = path.join(
    directory,
    'migration-backups',
    'before-020-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
  );
  fs.mkdirSync(snapshotDirectory, { recursive: true, mode: 0o700 });
  const filename = path.join(snapshotDirectory, 'platform.sqlite'),
    keyFile = path.join(snapshotDirectory, 'platform.key');
  db.exec("VACUUM INTO '" + filename.replace(/'/g, "''") + "'");
  fs.copyFileSync(path.join(directory, 'platform.key'), keyFile, fs.constants.COPYFILE_EXCL);
  syncFile(filename);
  syncFile(keyFile);
  syncDirectory(snapshotDirectory);
  const snapshot = new DatabaseSync(filename, { readOnly: true });
  try {
    if (
      snapshot.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
      snapshot.prepare('PRAGMA foreign_key_check').all().length ||
      !fs.readFileSync(keyFile).equals(database.key)
    )
      throw Error('Multi-service snapshot verification failed.');
  } finally {
    snapshot.close();
  }
  database.transaction(() => {
    db.exec(multiServiceSchema + 'PRAGMA user_version=20;');
    validateMultiServiceSchema(db);
  });
  return { snapshotDirectory, previousSchema: 19, schema: 20 };
}
function rollbackEmptyMultiServiceBilling(database) {
  return database.transaction(() => {
    const { db } = database;
    if (db.prepare('PRAGMA user_version').get().user_version !== 20)
      throw Error('Expected schema20.');
    if (db.prepare("SELECT 1 FROM billing_services WHERE code<>'voice-assistant'").get())
      throw Error('Additional services exist; retain schema20 and the verified backup.');
    if (
      db.prepare('SELECT 1 FROM billing_financial_actions LIMIT 1').get() ||
      db.prepare('SELECT 1 FROM billing_grant_revocations LIMIT 1').get()
    )
      throw Error('Financial history cannot be discarded.');
    if (db.prepare("SELECT 1 FROM billing_package_definitions WHERE receipt_json<>'{}'").get())
      throw Error('Package fiscal settings must be retained.');
    for (const table of [
      'billing_package_definitions',
      'billing_package_grants',
      'billing_payment_orders',
    ])
      if (db.prepare('SELECT 1 FROM ' + table + " WHERE service_code<>'voice-assistant'").get())
        throw Error('Multi-service history cannot be discarded.');
    db.exec(`DROP TRIGGER billing_package_service_frozen;DROP TRIGGER billing_payment_service_frozen;
DROP INDEX billing_payment_open_service;DROP INDEX billing_grants_org_service;
DROP TRIGGER billing_package_definitions_service_known;DROP TRIGGER billing_package_grants_service_known;DROP TRIGGER billing_payment_orders_service_known;
ALTER TABLE billing_payment_orders DROP COLUMN service_code;
ALTER TABLE billing_package_grants DROP COLUMN service_code;
ALTER TABLE billing_package_grants DROP COLUMN period_months;
ALTER TABLE billing_package_grants DROP COLUMN quota_unit;
ALTER TABLE billing_package_definitions DROP COLUMN service_code;
ALTER TABLE billing_package_definitions DROP COLUMN period_months;
ALTER TABLE billing_package_definitions DROP COLUMN quota_unit;
ALTER TABLE billing_package_definitions DROP COLUMN receipt_json;
DROP TABLE billing_services;
DROP TABLE billing_grant_revocations;DROP TABLE billing_financial_actions;
CREATE UNIQUE INDEX billing_payment_open_org ON billing_payment_orders(organization_id) WHERE state IN ('creating','pending','uncertain','review');
PRAGMA user_version=19;`);
  });
}
module.exports = { migrateMultiServiceBilling, rollbackEmptyMultiServiceBilling };
