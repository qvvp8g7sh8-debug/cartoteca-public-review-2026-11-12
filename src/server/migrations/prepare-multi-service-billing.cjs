const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createV2Backup, recoverUpgradeCopy } = require('../infrastructure/backup/service.cjs');
const { safeTree, readKey } = require('../infrastructure/backup/snapshot.cjs');
const { disjoint } = require('../infrastructure/backup/organization-inventory.cjs');
const { syncFile, syncDirectory } = require('../infrastructure/backup/durable.cjs');
const { migrateMultiServiceBilling } = require('./020-multi-service-billing.cjs');
const { validatePaidSchema } = require('../modules/billing/prepared-schema.cjs');
async function prepareMultiServiceBilling({
  source,
  destination,
  directory,
  keyFile,
  offline = false,
}) {
  if (!offline) throw Error('Stop every writer before preparing multi-service billing.');
  [source, destination, directory, keyFile] = [source, destination, directory, keyFile].map(
    (value) => path.resolve(value),
  );
  disjoint(source, destination, directory);
  safeTree(source);
  safeTree(path.dirname(destination));
  if (fs.existsSync(destination)) throw Error('Preparation destination must be new.');
  if (fs.existsSync(path.join(source, '.restore-in-progress')))
    throw Error('Source recovery is incomplete.');
  const relative = path.relative(destination, keyFile);
  if (
    !relative ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  )
    throw Error('Backup key must stay outside the prepared copy.');
  const fingerprint = () =>
    crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(source, 'platform/platform.sqlite')))
      .update(fs.readFileSync(path.join(source, 'platform/platform.key')))
      .digest('hex');
  const original = fingerprint(),
    before = await createV2Backup({ source, directory, keyFile });
  await recoverUpgradeCopy(before.file, keyFile, destination, {
    preparationMarker: 'multi-service-billing-preparation-v1',
  });
  const platform = path.join(destination, 'platform'),
    db = new DatabaseSync(path.join(platform, 'platform.sqlite'));
  try {
    db.exec('PRAGMA foreign_keys=ON');
    const database = {
      db,
      key: readKey(path.join(platform, 'platform.key')),
      transaction(fn) {
        db.exec('BEGIN IMMEDIATE');
        try {
          const value = fn();
          db.exec('COMMIT');
          return value;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
    };
    migrateMultiServiceBilling(database, platform, { offline: true });
    validatePaidSchema(db);
    if (
      db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').all().length
    )
      throw Error('Prepared billing integrity failed.');
  } finally {
    db.close();
  }
  syncFile(path.join(platform, 'platform.sqlite'));
  syncDirectory(platform);
  if (fingerprint() !== original) throw Error('Source changed during offline preparation.');
  const prepared = await createV2Backup({ source: destination, directory, keyFile });
  fs.unlinkSync(path.join(destination, '.restore-in-progress'));
  syncDirectory(destination);
  return {
    previousSchema: 19,
    schema: 20,
    sourceUnchanged: true,
    keysAndSessionsPreserved: true,
    cabinetSchemaUnchanged: true,
    paymentNetworkEnabled: false,
    beforeArchive: before.file,
    preparedArchive: prepared.file,
    requiresStoppedSourceBeforeSwitch: true,
  };
}
module.exports = { prepareMultiServiceBilling };
