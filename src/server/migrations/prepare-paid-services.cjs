const fs = require('node:fs');
const path = require('node:path');
const { createV2Backup, recoverUpgradeCopy } = require('../infrastructure/backup/service.cjs');
const { safeTree } = require('../infrastructure/backup/snapshot.cjs');
const { syncFile, syncDirectory } = require('../infrastructure/backup/durable.cjs');
const { createPlatformDatabase } = require('../infrastructure/platform-database.cjs');
const { migratePaidServices, rollbackEmptyPaidServices } = require('./019-paid-services.cjs');

// Preserve the original and its capabilities. The caller must stop all writers first.
async function preparePaidServicesUpgrade({
  source,
  destination,
  directory,
  keyFile,
  offline = false,
  rollback = false,
  sharedCabinetWrites = false,
  isolatedReadBudgets = false,
}) {
  if (offline !== true) throw Error('Stop writers before preparing paid services storage.');
  source = path.resolve(source);
  destination = path.resolve(destination);
  directory = path.resolve(directory);
  keyFile = path.resolve(keyFile);
  const within = (child, parent) => {
    const relative = path.relative(parent, child);
    return (
      !relative ||
      (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
    );
  };
  if (
    within(source, destination) ||
    within(destination, source) ||
    within(destination, directory) ||
    within(directory, destination) ||
    within(keyFile, destination)
  )
    throw Error('Keep original, prepared copy, archives and key separate.');
  safeTree(source);
  safeTree(path.dirname(destination));
  if (fs.existsSync(destination))
    throw Error('Paid services preparation requires a new destination.');
  if (fs.existsSync(path.join(source, '.restore-in-progress')))
    throw Error('Source preparation is incomplete.');
  const before = await createV2Backup({ source, directory, keyFile });
  await recoverUpgradeCopy(before.file, keyFile, destination);
  const marker = path.join(destination, '.restore-in-progress');
  fs.writeFileSync(marker, 'paid-services-preparation', { flag: 'wx', mode: 0o600 });
  syncFile(marker);
  syncDirectory(destination);
  let database;
  try {
    const platformDirectory = path.join(destination, 'platform');
    database = createPlatformDatabase(platformDirectory, {
      notificationSchema: rollback ? 19 : 18,
      sharedCabinetWrites,
      isolatedReadBudgets,
    });
    if (rollback) rollbackEmptyPaidServices(database);
    else migratePaidServices(database, platformDirectory);
    if (
      database.db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
      database.db.prepare('PRAGMA foreign_key_check').all().length
    )
      throw Error('Paid services copy integrity check failed.');
    database.db.close();
    database = null;
    syncFile(path.join(platformDirectory, 'platform.sqlite'));
    syncDirectory(platformDirectory);
    const prepared = await createV2Backup({ source: destination, directory, keyFile });
    fs.unlinkSync(marker);
    syncDirectory(destination);
    return {
      schema: rollback ? 18 : 19,
      sourceUnchanged: true,
      billingConfiguredByDefault: false,
      paidServicesEnabledByDefault: false,
      sessionsRevoked: false,
      clientBindingsPreserved: true,
      requiresStoppedSourceBeforeSwitch: true,
      beforeArchive: before.file,
      preparedArchive: prepared.file,
    };
  } finally {
    database?.db.close();
  }
}
module.exports = { preparePaidServicesUpgrade };
