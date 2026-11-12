const fs = require('node:fs');
const path = require('node:path');
const { createV2Backup, recoverUpgradeCopy } = require('../infrastructure/backup/service.cjs');
const { safeTree } = require('../infrastructure/backup/snapshot.cjs');
const { createPlatformDatabase } = require('../infrastructure/platform-database.cjs');
const { migrateNotificationSchedule } = require('./018-notification-schedule.cjs');

// No in-place upgrade: preserve the source, create/verify archives before/after.
async function prepareNotificationScheduleUpgrade({ source, destination, directory, keyFile }) {
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
    throw Error('Keep original, new copy, archives and key separate.');
  safeTree(path.dirname(destination));
  if (fs.existsSync(destination))
    throw Error('Notification schedule preparation requires a new destination.');
  const before = await createV2Backup({ source, directory, keyFile });
  await recoverUpgradeCopy(before.file, keyFile, destination);
  const marker = path.join(destination, '.restore-in-progress');
  fs.writeFileSync(marker, 'notification-schedule-preparation', { flag: 'wx', mode: 0o600 });
  let database;
  try {
    const platformDirectory = path.join(destination, 'platform');
    database = createPlatformDatabase(platformDirectory, { notificationSchema: 17 });
    migrateNotificationSchedule(database, platformDirectory);
    if (
      database.db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
      database.db.prepare('PRAGMA foreign_key_check').all().length
    )
      throw Error('Notification schedule copy integrity check failed.');
    database.db.close();
    database = null;
    const prepared = await createV2Backup({ source: destination, directory, keyFile });
    fs.unlinkSync(marker);
    return {
      schema: 18,
      sourceUnchanged: true,
      scheduleEnabledByDefault: false,
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
module.exports = { prepareNotificationScheduleUpgrade };
