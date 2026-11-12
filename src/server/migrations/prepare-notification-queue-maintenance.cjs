const fs = require('node:fs');
const path = require('node:path');
const { createV2Backup, recoverUpgradeCopy } = require('../infrastructure/backup/service.cjs');
const { safeTree } = require('../infrastructure/backup/snapshot.cjs');
const { syncDirectory } = require('../infrastructure/backup/durable.cjs');
const { migrateNotificationMaintenance } = require('./001-notification-queue-maintenance.cjs');
async function prepareNotificationMaintenanceCopy({
  source,
  destination,
  directory,
  keyFile,
  offline = false,
  rollback = false,
}) {
  if (offline !== true) throw Error('Stop all writers before notification maintenance preparation');
  [source, destination, directory, keyFile] = [source, destination, directory, keyFile].map(
    (value) => path.resolve(value),
  );
  const within = (child, parent) => {
    const relative = path.relative(parent, child);
    return (
      !relative ||
      (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
    );
  };
  if (
    within(source, destination) ||
    within(destination, source) ||
    within(destination, directory) ||
    within(directory, destination) ||
    within(keyFile, destination)
  )
    throw Error('Keep source, copy, archives and key separate');
  safeTree(source);
  safeTree(path.dirname(destination));
  if (fs.existsSync(destination) || fs.existsSync(path.join(source, '.restore-in-progress')))
    throw Error('Notification maintenance destination must be new and source complete');
  const before = await createV2Backup({ source, directory, keyFile });
  await recoverUpgradeCopy(before.file, keyFile, destination, {
    preparationMarker: 'notification-queue-maintenance-preparation-v1',
  });
  const marker = path.join(destination, '.restore-in-progress');
  const result = migrateNotificationMaintenance(path.join(destination, 'platform'), { rollback });
  const prepared = await createV2Backup({ source: destination, directory, keyFile });
  fs.unlinkSync(marker);
  syncDirectory(destination);
  return {
    ...result,
    sourceUnchanged: true,
    beforeArchive: before.file,
    preparedArchive: prepared.file,
    requiresStoppedSourceBeforeSwitch: true,
  };
}
module.exports = { prepareNotificationMaintenanceCopy };
