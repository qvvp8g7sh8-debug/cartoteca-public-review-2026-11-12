const fs = require('node:fs');
const path = require('node:path');
const { createV2Backup, recoverUpgradeCopy } = require('../infrastructure/backup/service.cjs');
const { safeTree } = require('../infrastructure/backup/snapshot.cjs');
const { disjoint } = require('../infrastructure/backup/organization-inventory.cjs');
const { syncFile, syncDirectory } = require('../infrastructure/backup/durable.cjs');
const { createPlatformDatabase } = require('../infrastructure/platform-database.cjs');
const { migrateNotificationSchedule } = require('./018-notification-schedule.cjs');
const { migratePaidServices } = require('./019-paid-services.cjs');
const { validatePaidSchema } = require('../modules/billing/prepared-schema.cjs');
const { productionProof, verifyPreserved } = require('./paid-services-preservation.cjs');
const MARKER = 'paid-services-preparation-v1';
// A separate full transition. Never enables scheduler, migrates cabinets or revokes sessions.
async function preparePaidServicesProductionUpgrade({
  source,
  destination,
  directory,
  keyFile,
  offline = false,
}) {
  if (offline !== true)
    throw Error('Stop every writer before preparing paid services production data.');
  [source, destination, directory, keyFile] = [source, destination, directory, keyFile].map(
    (value) => path.resolve(value),
  );
  disjoint(source, destination, directory);
  const keyRelative = path.relative(destination, keyFile);
  if (
    !keyRelative ||
    (!keyRelative.startsWith('..' + path.sep) &&
      keyRelative !== '..' &&
      !path.isAbsolute(keyRelative))
  )
    throw Error('Keep the backup key outside the prepared copy.');
  safeTree(source);
  safeTree(path.dirname(destination));
  if (fs.existsSync(destination)) throw Error('Paid services destination must be new.');
  if (fs.existsSync(path.join(source, '.restore-in-progress')))
    throw Error('Source preparation is incomplete.');
  const original = productionProof(source);
  const before = await createV2Backup({ source, directory, keyFile });
  await recoverUpgradeCopy(before.file, keyFile, destination, { preparationMarker: MARKER });
  let database;
  try {
    const platformDirectory = path.join(destination, 'platform');
    database = createPlatformDatabase(platformDirectory, {
      notificationSchema: 17,
      sharedCabinetWrites: true,
      isolatedReadBudgets: true,
    });
    migrateNotificationSchedule(database, platformDirectory);
    migratePaidServices(database, platformDirectory);
    validatePaidSchema(database.db);
    if (
      database.db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
      database.db.prepare('PRAGMA foreign_key_check').all().length
    )
      throw Error('Paid services production copy integrity failed.');
    database.closeWriter();
    database.db.close();
    database = null;
    syncFile(path.join(platformDirectory, 'platform.sqlite'));
    syncDirectory(platformDirectory);
    const preservation = verifyPreserved(source, destination, original);
    const prepared = await createV2Backup({ source: destination, directory, keyFile });
    fs.unlinkSync(path.join(destination, '.restore-in-progress'));
    syncDirectory(destination);
    return {
      schema: 19,
      previousSchema: 17,
      sourceUnchanged: true,
      sessionsRevoked: false,
      clientBindingsPreserved: true,
      requiresStoppedSourceBeforeSwitch: true,
      readBudgetVersion: 1,
      bookingLinksVersion: 1,
      readBudgetStoreId: original.platform.readBudgetStoreId,
      publicLinksFingerprint: original.platform.publicLinksFingerprint,
      paymentNetworkEnabled: false,
      billingConfiguredByDefault: false,
      paidServicesEnabledByDefault: false,
      cabinetSchemaUnchanged: true,
      scheduleModeUnchanged: true,
      preservation,
      beforeArchive: before.file,
      preparedArchive: prepared.file,
    };
  } finally {
    if (database) {
      database.closeWriter();
      database.db.close();
    }
  }
}
module.exports = { preparePaidServicesProductionUpgrade, MARKER };
