const fs = require('node:fs');
const path = require('node:path');
const { createV2Backup, recoverUpgradeCopy } = require('../infrastructure/backup/service.cjs');
const { safeTree } = require('../infrastructure/backup/snapshot.cjs');
const { syncDirectory } = require('../infrastructure/backup/durable.cjs');
const { migrateBookingPublicLinks } = require('./001-booking-public-links.cjs');

// A preparation tool, never an application-startup hook or a live-data switch.
async function prepareBookingPublicLinksCopy({
  source,
  destination,
  directory,
  keyFile,
  offline = false,
  rollback = false,
}) {
  if (offline !== true) throw Error('Stop all writers before public booking links preparation');
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
    throw Error('Public booking links destination must be new and source complete');
  const before = await createV2Backup({ source, directory, keyFile });
  await recoverUpgradeCopy(before.file, keyFile, destination, {
    preparationMarker: 'booking-public-links-preparation-v1',
  });
  const marker = path.join(destination, '.restore-in-progress');
  // Keep this durable marker on any failure, so the incomplete copy cannot start.
  const result = migrateBookingPublicLinks(path.join(destination, 'platform'), { rollback });
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
module.exports = { prepareBookingPublicLinksCopy };
