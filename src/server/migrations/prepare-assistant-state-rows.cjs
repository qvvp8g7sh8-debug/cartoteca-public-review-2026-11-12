const fs = require('node:fs');
const path = require('node:path');
const { createV2Backup, recoverUpgradeCopy } = require('../infrastructure/backup/service.cjs');
const { safeTree } = require('../infrastructure/backup/snapshot.cjs');
const { syncDirectory } = require('../infrastructure/backup/durable.cjs');
const { migrateAssistantStateRows, MARKER } = require('./001-assistant-state-rows.cjs');
async function prepareAssistantStateRowsCopy({
  source,
  destination,
  directory,
  keyFile,
  offline = false,
  rollback = false,
}) {
  if (offline !== true) throw Error('Stop every writer before assistant rows preparation');
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
    throw Error('Assistant rows destination must be new and source complete');
  const before = await createV2Backup({ source, directory, keyFile });
  await recoverUpgradeCopy(before.file, keyFile, destination, { preparationMarker: MARKER });
  const result = migrateAssistantStateRows(path.join(destination, 'platform'), { rollback });
  const prepared = await createV2Backup({ source: destination, directory, keyFile });
  fs.unlinkSync(path.join(destination, '.restore-in-progress'));
  syncDirectory(destination);
  return {
    ...result,
    sourceUnchanged: true,
    beforeArchive: before.file,
    preparedArchive: prepared.file,
    requiresStoppedSourceBeforeSwitch: true,
  };
}
module.exports = { prepareAssistantStateRowsCopy };
