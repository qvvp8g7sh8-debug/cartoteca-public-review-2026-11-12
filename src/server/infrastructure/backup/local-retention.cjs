const fs = require('node:fs');
const path = require('node:path');
const { safeTree, plainFile } = require('./snapshot.cjs');
const { fingerprints } = require('./s3-storage.cjs');
const { verifyV2Backup } = require('./service.cjs');
const { syncDirectory } = require('./durable.cjs');

function localRecoveryPoints(config, rows, newestId) {
  if (config.remote || config.localCopies !== 3) throw Error('BACKUP_CONFIGURATION');
  const paths = new Set();
  return rows
    .filter(
      (row) =>
        row.state === 'local_only' &&
        Number.isSafeInteger(row.finished) &&
        row.detail?.localAt &&
        row.detail.drillAt &&
        row.detail.file &&
        (!row.destination || row.destination === config.destinationId),
    )
    .sort(
      (a, b) =>
        Number(b.id === newestId) - Number(a.id === newestId) ||
        b.finished - a.finished ||
        String(b.id).localeCompare(String(a.id)),
    )
    .filter((row) => {
      const file = path.resolve(row.detail.file);
      if (
        path.dirname(file) !== path.resolve(config.directory) ||
        !/^cartoteca-v2-[a-zA-Z0-9-]+\.enc$/.test(path.basename(file)) ||
        paths.has(file)
      )
        return false;
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!stat?.isFile() || stat.isSymbolicLink()) return false;
      paths.add(file);
      return true;
    });
}
function localRetentionPlan(config, rows, now = Date.now(), newestId) {
  const points = localRecoveryPoints(config, rows, newestId);
  if (!points[0] || points[0].finished > now + 60000 || now - points[0].finished > 26 * 3600000)
    return [];
  return points.slice(3);
}
function sameFile(before, after) {
  return ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((key) => before[key] === after[key]);
}
async function inspectPoint(config, row, verifyLegacy, leaseCheck) {
  leaseCheck();
  safeTree(config.directory);
  plainFile(row.detail.file);
  const before = fs.lstatSync(row.detail.file),
    expected = row.detail.localChecksum;
  if (expected) {
    const actual = await fingerprints(row.detail.file);
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes)
      throw Error('BACKUP_REMOTE_CHECKSUM');
  } else if (verifyLegacy) {
    // Older journal entries have no checksum. Authenticate and validate the
    // retained archive once before it can justify deletion of another copy.
    await verifyV2Backup(row.detail.file, config.keyFile, { workDirectory: config.workDirectory });
  }
  if (row.detail.archiveBytes !== undefined && before.size !== row.detail.archiveBytes)
    throw Error('BACKUP_REMOTE_CHECKSUM');
  leaseCheck();
  plainFile(row.detail.file);
  if (!sameFile(before, fs.lstatSync(row.detail.file))) throw Error('BACKUP_REMOTE_CHECKSUM');
  return { row, stat: before };
}
async function rotateLocalBackups(
  config,
  rows,
  { leaseCheck = () => {}, now = Date.now(), newestId, onRemoved = () => {} } = {},
) {
  safeTree(config.directory);
  const candidates = localRetentionPlan(config, rows, now, newestId),
    removed = [];
  if (!candidates.length) return removed;
  const kept = [];
  for (const row of localRecoveryPoints(config, rows, newestId).slice(0, 3))
    kept.push(await inspectPoint(config, row, true, leaseCheck));
  if (kept.length !== 3) throw Error('BACKUP_FAILED');
  for (const row of candidates) {
    const inspected = await inspectPoint(config, row, false, leaseCheck);
    for (const point of kept) {
      plainFile(point.row.detail.file);
      if (!sameFile(point.stat, fs.lstatSync(point.row.detail.file)))
        throw Error('BACKUP_REMOTE_CHECKSUM');
    }
    leaseCheck();
    safeTree(config.directory);
    plainFile(row.detail.file);
    if (!sameFile(inspected.stat, fs.lstatSync(row.detail.file)))
      throw Error('BACKUP_REMOTE_CHECKSUM');
    fs.unlinkSync(row.detail.file);
    onRemoved(row.id);
    syncDirectory(config.directory);
    removed.push(row.id);
  }
  return removed;
}
module.exports = { localRetentionPlan, rotateLocalBackups };
