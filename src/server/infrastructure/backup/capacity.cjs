const fs = require('node:fs');
const path = require('node:path');
const { safeTree, plainFile } = require('./snapshot.cjs');

function sourceBytes(directory) {
  safeTree(directory);
  let size = 0;
  function walk(root) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      if (entry.isSymbolicLink()) throw Error('BACKUP_UNSAFE_SOURCE');
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        plainFile(file);
        size += fs.statSync(file).size;
      } else throw Error('BACKUP_UNSAFE_SOURCE');
      if (!Number.isSafeInteger(size)) throw Error('BACKUP_SOURCE_TOO_LARGE');
    }
  }
  walk(directory);
  return size;
}
function capacityRequirements(config, size, statfs, factor = 4) {
  if (!Number.isSafeInteger(size) || size < 0) throw Error('BACKUP_SOURCE_TOO_LARGE');
  const requirements = [];
  // Snapshot + encrypted archive + authenticated tar + recovered validation files.
  // Check both volumes independently; a restore drill is intentionally separate.
  for (const directory of [config.directory, config.workDirectory]) {
    safeTree(directory);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = statfs(directory),
      available = Number(info.bavail) * Number(info.bsize);
    const required = size * factor + config.reserveBytes;
    if (!Number.isSafeInteger(required)) throw Error('BACKUP_SOURCE_TOO_LARGE');
    if (!Number.isSafeInteger(available) || available < required) throw Error('BACKUP_DISK_SPACE');
    requirements.push({ availableBytes: available, requiredBytes: required });
  }
  return {
    sourceBytes: size,
    availableBytes: Math.min(...requirements.map((item) => item.availableBytes)),
  };
}
function checkCapacity(config, statfs = fs.statfsSync) {
  if (postgresSource(config)) throw Error('BACKUP_POSTGRES_SIZE_REQUIRED');
  return capacityRequirements(config, sourceBytes(config.source), statfs);
}
async function checkCapacityForBackend(config, statfs = fs.statfsSync) {
  if (!postgresSource(config)) return checkCapacity(config, statfs);
  const size = await require('../postgres/backup-service.cjs').estimatePostgresBytes({
    source: config.source,
    connection: config.connection,
    connectionOptions: config.connectionOptions,
  });
  return { ...capacityRequirements(config, size, statfs, 6), estimated: true, backend: 'postgres' };
}
function postgresSource(config) {
  const postgres = fs.existsSync(path.join(config.source, 'postgresql-runtime.json'));
  if (
    (config.storageBackend !== undefined &&
      !['sqlite', 'postgres'].includes(config.storageBackend)) ||
    (config.storageBackend === 'postgres' && !postgres) ||
    (config.storageBackend === 'sqlite' && postgres)
  )
    throw Error('BACKUP_CONFIGURATION');
  return postgres;
}
module.exports = { checkCapacity, checkCapacityForBackend, sourceBytes };
