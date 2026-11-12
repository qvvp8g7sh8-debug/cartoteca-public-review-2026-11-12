const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { walletSchema, walletTables } = require('../modules/billing/wallet-schema.cjs');
const { serviceConnectionSchemaSQL } = require('../modules/billing/entitlements-schema.cjs');
const { packageSchema, packageTables } = require('../modules/billing/package-schema.cjs');
const { paymentSchema, paymentTables } = require('../modules/billing/payment-schema.cjs');
const { syncFile, syncDirectory } = require('../infrastructure/backup/durable.cjs');

// Explicit offline preparation on a complete copy; never applied by server startup.
function migratePaidServices(database, directory) {
  const { db } = database;
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version === 19) return;
  if (version !== 18) throw Error('Paid services require separately prepared schema 18.');
  const snapshotDirectory = path.join(
    directory,
    'migration-backups',
    'before-019-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
  );
  fs.mkdirSync(snapshotDirectory, { recursive: true, mode: 0o700 });
  const filename = path.join(snapshotDirectory, 'platform.sqlite');
  db.exec("VACUUM INTO '" + filename.replace(/'/g, "''") + "'");
  const keyFile = path.join(snapshotDirectory, 'platform.key');
  fs.copyFileSync(path.join(directory, 'platform.key'), keyFile, fs.constants.COPYFILE_EXCL);
  syncFile(filename);
  syncFile(keyFile);
  syncDirectory(snapshotDirectory);
  const snapshot = new DatabaseSync(filename, { readOnly: true });
  try {
    if (
      snapshot.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
      snapshot.prepare('PRAGMA foreign_key_check').all().length ||
      snapshot.prepare('PRAGMA user_version').get().user_version !== 18 ||
      !fs.readFileSync(keyFile).equals(database.key)
    )
      throw Error('Paid services snapshot verification failed.');
  } finally {
    snapshot.close();
  }
  database.transaction(() =>
    db.exec(
      walletSchema +
        serviceConnectionSchemaSQL +
        packageSchema +
        paymentSchema +
        'PRAGMA user_version=19;',
    ),
  );
  return { snapshotDirectory };
}

function rollbackEmptyPaidServices(database) {
  return database.transaction(() => {
    const { db } = database;
    if (db.prepare('PRAGMA user_version').get().user_version !== 19)
      throw Error('Expected paid services schema 19.');
    for (const table of [
      ...paymentTables,
      ...packageTables,
      'billing_entries',
      'billing_reservations',
      'billing_operations',
      'billing_customer_operations',
      'billing_service_connections',
    ])
      if (db.prepare('SELECT 1 FROM ' + table + ' LIMIT 1').get())
        throw Error(
          'Paid service history or connections exist; retain schema 19 and the verified complete backup.',
        );
    if (
      db
        .prepare(
          'SELECT 1 FROM billing_wallets WHERE balance_microrub<>0 OR reserved_microrub<>0 ' +
            'OR provider_cost_microrub<>0 OR charged_microrub<>0 OR unpaid_charge_microrub<>0 LIMIT 1',
        )
        .get()
    )
      throw Error('Wallet amounts exist; financial state cannot be discarded.');
    db.exec(
      [...paymentTables]
        .reverse()
        .map((table) => 'DROP TABLE ' + table + ';')
        .join('') +
        'DROP TRIGGER billing_package_grants_no_update; DROP TRIGGER billing_package_grants_no_delete; ' +
        [...packageTables]
          .reverse()
          .map((table) => 'DROP TABLE ' + table + ';')
          .join('') +
        'DROP TABLE billing_customer_operations; DROP TABLE billing_service_connections; ' +
        'DROP TRIGGER billing_entries_immutable_update; DROP TRIGGER billing_entries_immutable_delete; ' +
        [...walletTables]
          .reverse()
          .map((table) => 'DROP TABLE ' + table + ';')
          .join('') +
        'PRAGMA user_version=18;',
    );
  });
}
module.exports = { migratePaidServices, rollbackEmptyPaidServices };
