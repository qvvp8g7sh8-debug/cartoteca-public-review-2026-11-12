const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createV2Backup, recoverUpgradeCopy } = require('../infrastructure/backup/service.cjs');
const { cabinetPaths, safeTree, readKey } = require('../infrastructure/backup/snapshot.cjs');
const { syncFile, syncDirectory } = require('../infrastructure/backup/durable.cjs');
const { createPlatformDatabase } = require('../infrastructure/platform-database.cjs');
const { configureSqlite } = require('../infrastructure/sqlite-configuration.cjs');
const {
  migrateNotificationSchedule,
  rollbackNotificationSchedule,
} = require('./018-notification-schedule.cjs');
const { migrateCabinetRecords, rollbackCabinetRecords } = require('./002-cabinet-records.cjs');
const { codec, checkPhotos } = require('./prepare-cabinet-records.cjs');

function within(child, parent) {
  const relative = path.relative(parent, child);
  return (
    !relative ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  );
}
function integrity(db) {
  if (
    db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
    db.prepare('PRAGMA foreign_key_check').all().length
  )
    throw Error('Structural copy integrity failed');
}

// Whole-tree preparation. The deployment gate must stop ALL writers before invoking it.
// The reverse path materializes the latest authoritative records, never an old snapshot.
async function prepareStructuralUpgrade({
  source,
  destination,
  directory,
  keyFile,
  offline = false,
  rollback = false,
}) {
  if (offline !== true) throw Error('Stop writers before preparing structural storage');
  source = path.resolve(source);
  destination = path.resolve(destination);
  directory = path.resolve(directory);
  keyFile = path.resolve(keyFile);
  if (
    within(source, destination) ||
    within(destination, source) ||
    within(destination, directory) ||
    within(directory, destination) ||
    within(keyFile, destination)
  )
    throw Error('Keep original, prepared copy, archives and key separate');
  safeTree(source);
  safeTree(path.dirname(destination));
  if (fs.existsSync(destination)) throw Error('Structural destination must be new');
  if (fs.existsSync(path.join(source, '.restore-in-progress')))
    throw Error('Source preparation is incomplete');
  const before = await createV2Backup({ source, directory, keyFile });
  await recoverUpgradeCopy(before.file, keyFile, destination);
  const marker = path.join(destination, '.restore-in-progress');
  fs.writeFileSync(marker, 'structural-preparation', { flag: 'wx', mode: 0o600 });
  syncFile(marker);
  syncDirectory(destination);
  let platform;
  let cabinets = 0;
  const expected = rollback ? 18 : 17;
  try {
    const platformDirectory = path.join(destination, 'platform');
    platform = createPlatformDatabase(platformDirectory, { notificationSchema: expected });
    // Refuse unsettled cross-database intents before changing any cabinet on downgrade.
    if (rollback) rollbackNotificationSchedule(platform);
    for (const relative of cabinetPaths(destination, platform.db).cabinets) {
      const cabinet = path.join(destination, relative);
      const file = path.join(cabinet, 'cabinet.sqlite');
      const db = new DatabaseSync(file);
      try {
        configureSqlite(db);
        const version = db.prepare('PRAGMA user_version').get().user_version;
        if (![1, 2].includes(version)) throw Error('Unexpected structural cabinet version');
        const key = readKey(path.join(cabinet, 'encryption.key'));
        if (version !== (rollback ? 1 : 2))
          (rollback ? rollbackCabinetRecords : migrateCabinetRecords)({ db, ...codec(key) });
        integrity(db);
        checkPhotos(db, cabinet, key);
        cabinets++;
      } finally {
        db.close();
      }
      syncFile(file);
      syncDirectory(cabinet);
    }
    if (!rollback) migrateNotificationSchedule(platform, platformDirectory);
    integrity(platform.db);
    platform.db.close();
    platform = null;
    syncFile(path.join(platformDirectory, 'platform.sqlite'));
    const prepared = await createV2Backup({ source: destination, directory, keyFile });
    fs.unlinkSync(marker);
    syncDirectory(destination);
    return {
      schema: rollback ? 17 : 18,
      cabinetSchema: rollback ? 1 : 2,
      cabinets,
      sourceUnchanged: true,
      sessionsRevoked: false,
      clientBindingsPreserved: true,
      scheduleEnabledByDefault: false,
      requiresStoppedSourceBeforeSwitch: true,
      beforeArchive: before.file,
      preparedArchive: prepared.file,
    };
  } finally {
    platform?.db.close();
  }
}
module.exports = { prepareStructuralUpgrade };
