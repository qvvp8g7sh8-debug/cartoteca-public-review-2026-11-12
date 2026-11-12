const fs = require('node:fs');
const path = require('node:path');
const { plainFile, safeTree } = require('./snapshot.cjs');
const { fingerprints } = require('./s3-storage.cjs');
const { syncDirectory } = require('./durable.cjs');
function localArchives(config, rows) {
  return rows.filter((row) => {
    if (row.state !== 'protected' || !row.detail.file || !row.detail.remote || !row.detail.drillAt)
      return false;
    const file = path.resolve(row.detail.file);
    return (
      path.dirname(file) === config.directory &&
      /^cartoteca-v2-[a-zA-Z0-9-]+\.enc$/.test(path.basename(file)) &&
      fs.existsSync(file) &&
      fs.lstatSync(file).isFile()
    );
  });
}
async function assertChecksum(row) {
  const checksum = await fingerprints(row.detail.file);
  if (checksum.sha256 !== row.detail.remote.sha256 || checksum.bytes !== row.detail.remote.bytes)
    throw Error('BACKUP_REMOTE_CHECKSUM');
}

function retentionPlan(config, rows, now = Date.now()) {
  if (!Number.isInteger(config.localCopies) || config.localCopies < 3 || config.localCopies > 100)
    throw Error('BACKUP_CONFIGURATION');
  const completed = rows.filter(
    (row) =>
      row.state === 'protected' && row.detail.file && row.detail.remote && row.detail.drillAt,
  );
  const newest = completed[0];
  if (!newest || now - newest.finished > 26 * 3600000) return [];
  // Unknown/manual archives, partial directories, keys, and failed copies are never candidates.
  const candidates = localArchives(config, completed)
    .slice(config.localCopies)
    .filter((row) => Date.parse(row.detail.remote.retainUntil) > now + 86400000);
  return candidates.filter((row) => {
    const file = path.resolve(row.detail.file);
    return (
      path.dirname(file) === config.directory &&
      /^cartoteca-v2-[a-zA-Z0-9-]+\.enc$/.test(path.basename(file)) &&
      fs.existsSync(file) &&
      fs.lstatSync(file).isFile()
    );
  });
}
async function applyRetention(
  config,
  rows,
  remote,
  { leaseCheck = () => {}, now = Date.now() } = {},
) {
  if (!remote) throw Error('BACKUP_REMOTE_FAILED');
  safeTree(config.directory);
  const candidates = retentionPlan(config, rows, now),
    removed = [];
  // Recheck newest recovery point BEFORE any deletion, even if plan was produced days ago.
  const newest = rows.find(
    (row) => row.state === 'protected' && row.detail.drillAt && row.detail.remote,
  );
  if (candidates.length) await remote.verify(newest.detail.remote);
  if (candidates.length) {
    for (const row of localArchives(config, rows).slice(0, config.localCopies)) {
      leaseCheck();
      await assertChecksum(row);
    }
  }
  for (const row of candidates) {
    leaseCheck();
    const file = path.resolve(row.detail.file);
    plainFile(file);
    const original = fs.statSync(file);
    await assertChecksum(row);
    await remote.verify(row.detail.remote);
    leaseCheck();
    plainFile(file);
    const current = fs.statSync(file);
    if (
      ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some((name) => original[name] !== current[name])
    )
      throw Error('BACKUP_REMOTE_CHECKSUM');
    fs.unlinkSync(file);
    syncDirectory(config.directory);
    removed.push(row.id);
  }
  return removed;
}
module.exports = { retentionPlan, applyRetention };
