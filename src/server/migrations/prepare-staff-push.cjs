const fs = require('node:fs'),
  path = require('node:path');
const { createV2Backup, recoverUpgradeCopy } = require('../infrastructure/backup/service.cjs');
const { safeTree } = require('../infrastructure/backup/snapshot.cjs');
const { createPlatformDatabase } = require('../infrastructure/platform-database.cjs');
const { migrateStaffPush } = require('./017-staff-push.cjs');
// Same safety contract as MAX: create a separate complete copy, never mutate the source.
async function prepareStaffPushUpgrade({ source, destination, directory, keyFile }) {
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
  if (fs.existsSync(destination)) throw Error('Push preparation requires a new destination.');
  const before = await createV2Backup({ source, directory, keyFile });
  await recoverUpgradeCopy(before.file, keyFile, destination);
  const marker = path.join(destination, '.restore-in-progress');
  fs.writeFileSync(marker, 'staff-push-preparation', { flag: 'wx', mode: 0o600 });
  let database;
  try {
    const platformDirectory = path.join(destination, 'platform');
    database = createPlatformDatabase(platformDirectory, { notificationSchema: 16 });
    migrateStaffPush(database, platformDirectory);
    if (
      database.db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
      database.db.prepare('PRAGMA foreign_key_check').all().length
    )
      throw Error('Push copy integrity check failed.');
    database.db.close();
    database = null;
    const prepared = await createV2Backup({ source: destination, directory, keyFile });
    fs.unlinkSync(marker);
    return {
      schema: 17,
      sourceUnchanged: true,
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
module.exports = { prepareStaffPushUpgrade };
