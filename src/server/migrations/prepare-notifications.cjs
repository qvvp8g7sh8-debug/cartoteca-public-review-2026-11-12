const fs = require('node:fs');
const path = require('node:path');
const {
  createV2Backup,
  restoreV2Backup,
  recoverUpgradeCopy,
} = require('../infrastructure/backup/service.cjs');
const { safeTree } = require('../infrastructure/backup/snapshot.cjs');
const { createPlatformDatabase } = require('../infrastructure/platform-database.cjs');
const { migrateMaxConnections } = require('./012-max-connections.cjs');
const { migrateNotificationQueue } = require('./013-notification-queue.cjs');
const { migrateNotificationChannels } = require('./014-notification-channels.cjs');
const { migrateMaxInbox } = require('./015-max-inbox.cjs');

// Offline function, never called by server startup. The working directory is never migrated.
async function prepareCopy({ source, destination, directory, keyFile }, preserveCapabilities) {
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
    within(destination, directory) ||
    within(directory, destination) ||
    within(keyFile, destination)
  )
    throw Error('Keep prepared data, archives and the backup key separate.');
  safeTree(path.dirname(destination));
  const relative = path.relative(source, destination);
  if (
    !relative ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) ||
    fs.existsSync(destination)
  )
    throw Error('Notification preparation requires a separate new destination.');
  // A complete externally encrypted archive is verified before recovering a separate copy.
  const backup = await createV2Backup({ source, directory, keyFile });
  const recover = preserveCapabilities ? recoverUpgradeCopy : restoreV2Backup;
  await recover(backup.file, keyFile, destination);
  const marker = path.join(destination, '.restore-in-progress');
  fs.writeFileSync(marker, 'notification-preparation', { flag: 'wx', mode: 0o600 });
  const platformDir = path.join(destination, 'platform');
  let database;
  try {
    // This entry point accepts only the existing schema-11 baseline; no partial resume.
    database = createPlatformDatabase(platformDir);
    if (database.db.prepare('PRAGMA user_version').get().user_version !== 11)
      throw Error(
        'Notification preparation requires schema 11; retain the copy for investigation.',
      );
    migrateMaxConnections(database, platformDir);
    migrateNotificationQueue(database, platformDir);
    migrateNotificationChannels(database, platformDir);
    migrateMaxInbox(database, platformDir);
    if (
      database.db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
      database.db.prepare('PRAGMA foreign_key_check').all().length
    )
      throw Error('Prepared notification copy integrity check failed.');
    database.db.close();
    database = null;
    // Includes verification of every new encrypted table, not only PRAGMA.
    const preparedBackup = await createV2Backup({ source: destination, directory, keyFile });
    fs.unlinkSync(marker);
    return {
      schema: 15,
      notificationsPaused: !preserveCapabilities,
      sessionsRevoked: !preserveCapabilities,
      requiresStoppedSourceBeforeSwitch: true,
      sourceUnchanged: true,
      beforeArchive: backup.file,
      preparedArchive: preparedBackup.file,
    };
  } finally {
    database?.db.close();
  }
}
const prepareNotificationCopy = (options) => prepareCopy(options, false);
const prepareNotificationUpgrade = (options) => prepareCopy(options, true);
module.exports = { prepareNotificationCopy, prepareNotificationUpgrade };
