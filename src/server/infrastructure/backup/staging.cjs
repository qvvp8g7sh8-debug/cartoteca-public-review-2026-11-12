const fs = require('node:fs');
const path = require('node:path');
const { safeTree, plainFile } = require('./snapshot.cjs');
const { syncFile, syncDirectory } = require('./durable.cjs');
const markerName = '.backup-stage.json';

function markBackupStage(stage, purpose, ownership = {}) {
  if (!ownership.backupJobId || !ownership.destinationId) return;
  const file = path.join(stage, markerName);
  fs.writeFileSync(
    file,
    JSON.stringify({
      format: 1,
      purpose,
      jobId: ownership.backupJobId,
      destinationId: ownership.destinationId,
      createdAt: Date.now(),
    }),
    { flag: 'wx', mode: 0o600 },
  );
  syncFile(file);
  syncDirectory(stage);
}
function cleanupBackupStages(
  config,
  rows,
  { leaseCheck = () => {}, now = Date.now(), onRemoved = () => {} } = {},
) {
  const completed = new Map(
    rows
      .filter(
        (row) =>
          Number.isSafeInteger(row.finished) &&
          ['local_only', 'protected', 'failed', 'interrupted'].includes(row.state),
      )
      .map((row) => [row.id, row]),
  );
  let removed = 0;
  for (const [directory, prefix, purpose] of [
    [config.directory, '.cartoteca-v2-', 'backup-copy'],
    [config.workDirectory, '.cartoteca-drill-', 'backup-drill'],
  ]) {
    safeTree(directory);
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith(prefix))
        continue;
      const stage = path.resolve(directory, entry.name),
        file = path.join(stage, markerName);
      if (path.dirname(stage) !== path.resolve(directory)) throw Error('BACKUP_FAILED');
      const markerStat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!markerStat?.isFile() || markerStat.isSymbolicLink() || markerStat.size > 2048) continue;
      let marker;
      try {
        marker = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      const job = completed.get(marker.jobId);
      if (
        marker.format !== 1 ||
        marker.purpose !== purpose ||
        marker.destinationId !== config.destinationId ||
        !job ||
        job.destination !== config.destinationId ||
        !Number.isSafeInteger(marker.createdAt) ||
        marker.createdAt > job.finished ||
        now - marker.createdAt < config.leaseMilliseconds
      )
        continue;
      leaseCheck();
      safeTree(stage);
      plainFile(file);
      const current = fs.lstatSync(file);
      if (
        ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some((key) => current[key] !== markerStat[key])
      )
        throw Error('BACKUP_FAILED');
      // Only a direct child carrying our marker for a finished, same-destination
      // job is removable. Unmarked/manual/recovery directories are never scanned.
      fs.rmSync(stage, { recursive: true, force: false });
      onRemoved(marker.jobId);
      syncDirectory(directory);
      removed++;
    }
  }
  return removed;
}
module.exports = { markBackupStage, cleanupBackupStages };
