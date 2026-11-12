const fs = require('node:fs');
const path = require('node:path');
const { backupConfiguration, inside } = require('./agent-config.cjs');
const { sourceBytes } = require('./capacity.cjs');
const { safeTree, plainFile } = require('./snapshot.cjs');
const { readBackupStatus } = require('./status.cjs');
const requiredNames = [
  'CARTOTECA_DATA_DIR',
  'BACKUP_DIR',
  'BACKUP_KEY_FILE',
  'BACKUP_STATE_DIR',
  'BACKUP_WORK_DIR',
  'BACKUP_STATUS_FILE',
];
const configurationErrors = new Set([
  'BACKUP_CONFIGURATION',
  'BACKUP_PATHS_OVERLAP',
  'BACKUP_S3_CONFIGURATION',
  'BACKUP_DISK_SPACE',
  'BACKUP_SOURCE_TOO_LARGE',
  'BACKUP_POSTGRES_SIZE_REQUIRED',
]);
function existingDirectory(directory) {
  safeTree(directory);
  let current = directory;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw Error('BACKUP_CONFIGURATION');
    current = parent;
  }
  if (!fs.lstatSync(current).isDirectory()) throw Error('BACKUP_CONFIGURATION');
  return current;
}
// Metadata/permissions only: no directory creation, journal, archive, DB open or network.
function backupPreflight(environment = process.env, { statfs = fs.statfsSync, sourceSize } = {}) {
  const missing = requiredNames.filter((name) => !environment[name]);
  if (missing.length) return { ok: false, code: 'BACKUP_CONFIGURATION', missing, exitCode: 2 };
  try {
    const config = backupConfiguration(environment);
    if (!fs.statSync(config.source).isDirectory()) throw Error('BACKUP_CONFIGURATION');
    const postgres = fs.existsSync(path.join(config.source, 'postgresql-runtime.json'));
    if (postgres) require('../postgres/runtime.cjs').readRuntime(config.source);
    for (const name of postgres ? ['platform.key'] : ['platform.sqlite', 'platform.key'])
      plainFile(path.join(config.source, 'platform', name));
    if (postgres && !Number.isSafeInteger(sourceSize)) throw Error('BACKUP_POSTGRES_SIZE_REQUIRED');
    const size = postgres ? sourceSize : sourceBytes(config.source),
      required = size * (postgres ? 6 : 4) + config.reserveBytes;
    if (!Number.isSafeInteger(required)) throw Error('BACKUP_SOURCE_TOO_LARGE');
    let available = Number.MAX_SAFE_INTEGER;
    for (const directory of [
      config.directory,
      config.stateDirectory,
      config.workDirectory,
      path.dirname(config.statusFile),
    ]) {
      const existing = existingDirectory(directory);
      fs.accessSync(existing, fs.constants.W_OK);
      if (![config.directory, config.workDirectory].includes(directory)) continue;
      const info = statfs(existing),
        bytes = Number(info.bavail) * Number(info.bsize);
      if (!Number.isSafeInteger(bytes) || bytes < required) throw Error('BACKUP_DISK_SPACE');
      available = Math.min(available, bytes);
    }
    return {
      ok: true,
      code: config.remote ? 'BACKUP_REMOTE_NOT_VERIFIED' : 'BACKUP_LOCAL_ONLY',
      exitCode: 0,
      localAttemptReady: true,
      archiveVerified: false,
      remoteAttemptReady: Boolean(config.remote),
      independentProtectionVerified: false,
      sourceBytes: size,
      requiredBytes: required,
      availableBytes: available,
      next: config.remote
        ? ['RUN_BACKUP_AND_RESTORE_DRILL', 'CONNECT_INDEPENDENT_MONITOR']
        : [
            'SELECT_EXTERNAL_STORAGE',
            'RUN_BACKUP_AND_RESTORE_DRILL',
            'CONNECT_INDEPENDENT_MONITOR',
          ],
    };
  } catch (error) {
    return {
      ok: false,
      code: configurationErrors.has(error.message) ? error.message : 'BACKUP_CONFIGURATION',
      exitCode: 2,
    };
  }
}
async function backupPreflightAsync(environment = process.env, options = {}) {
  if (
    !environment.CARTOTECA_DATA_DIR ||
    !fs.existsSync(path.join(environment.CARTOTECA_DATA_DIR, 'postgresql-runtime.json'))
  )
    return backupPreflight(environment, options);
  try {
    const config = backupConfiguration(environment);
    const sourceSize = await require('../postgres/backup-service.cjs').estimatePostgresBytes({
      source: config.source,
      connection: config.connection,
      connectionOptions: config.connectionOptions,
    });
    return backupPreflight(environment, { ...options, sourceSize });
  } catch {
    return { ok: false, code: 'BACKUP_CONFIGURATION', exitCode: 2 };
  }
}
function evaluateBackupStatus(status, now = Date.now()) {
  const fresh = (value) =>
    Number.isSafeInteger(value) && value > 0 && value <= now + 60000 && now - value < 26 * 3600000;
  let code = 'BACKUP_UNAVAILABLE',
    exitCode = 2;
  if (status.health === 'unavailable') code = 'BACKUP_UNAVAILABLE';
  else if (!status.configured) code = 'BACKUP_UNCONFIGURED';
  else if (!fresh(status.observedAt)) code = 'BACKUP_STALE';
  else if (['failed', 'interrupted'].includes(status.state)) code = 'BACKUP_FAILED';
  else if (!fresh(status.lastLocalAt) || !fresh(status.lastDrillAt))
    code = 'BACKUP_RECOVERY_POINT_STALE';
  else if (!status.remoteConfigured) {
    code = 'BACKUP_LOCAL_ONLY';
    exitCode = 1;
  } else if (!fresh(status.lastRemoteAt)) code = 'BACKUP_REMOTE_STALE';
  else if (status.maintenanceError) {
    code = 'BACKUP_MAINTENANCE_FAILED';
    exitCode = 1;
  } else {
    code = 'BACKUP_PROTECTED';
    exitCode = 0;
  }
  return {
    code,
    exitCode,
    severity: ['ok', 'warning', 'critical'][exitCode],
    remoteConfigured: status.remoteConfigured === true,
    checkedAt: now,
    lastLocalAt: fresh(status.lastLocalAt) ? status.lastLocalAt : null,
    lastRemoteAt: fresh(status.lastRemoteAt) ? status.lastRemoteAt : null,
    lastDrillAt: fresh(status.lastDrillAt) ? status.lastDrillAt : null,
  };
}
function monitorBackup(file) {
  if (file && (typeof file !== 'string' || !path.isAbsolute(file)))
    return evaluateBackupStatus({ configured: true, health: 'unavailable' });
  const status = readBackupStatus(file);
  return evaluateBackupStatus(status);
}
async function readBackupStatusForProfile(file, config) {
  if (config?.storageBackend !== 'postgres') return readBackupStatus(file, config);
  try {
    const verified = await require('../postgres/backup-profile.cjs').verifyCurrentBackupProfile(
      config,
    );
    return readBackupStatus(file, verified.config);
  } catch {
    return { configured: true, health: 'unavailable' };
  }
}
async function monitorBackupForProfile(file, config) {
  return evaluateBackupStatus(await readBackupStatusForProfile(file, config));
}
async function archiveRestoreDrill({ archive, keyFile, workDirectory, connection }) {
  const paths = [archive, keyFile, workDirectory];
  if (paths.some((value) => typeof value !== 'string' || !path.isAbsolute(value)))
    throw Error('BACKUP_DRILL_CONFIGURATION');
  archive = path.resolve(archive);
  keyFile = path.resolve(keyFile);
  workDirectory = path.resolve(workDirectory);
  // Work must be outside both the archive and key directories, in either direction.
  for (const directory of [path.dirname(archive), path.dirname(keyFile)])
    if (inside(workDirectory, directory) || inside(directory, workDirectory))
      throw Error('BACKUP_DRILL_CONFIGURATION');
  safeTree(path.dirname(archive));
  safeTree(path.dirname(keyFile));
  safeTree(workDirectory);
  plainFile(archive);
  plainFile(keyFile);
  const { performance } = require('node:perf_hooks');
  const started = performance.now();
  const { restoreDrill } = require('./drill.cjs');
  const result = await restoreDrill(archive, keyFile, workDirectory, { connection });
  return {
    ...result,
    durationMilliseconds: Math.round(performance.now() - started),
    productionReplaced: false,
  };
}
module.exports = {
  backupPreflight,
  backupPreflightAsync,
  evaluateBackupStatus,
  monitorBackup,
  monitorBackupForProfile,
  readBackupStatusForProfile,
  archiveRestoreDrill,
};
