const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { snapshotDatabases, readKey, plainFile, safeTree } = require('./snapshot.cjs');
const { writeArchive, extractArchive, digest, archiveKind } = require('./archive.cjs');
const { validateRecovered, revokeRestoredCredentials } = require('./validation.cjs');
const { syncFile, syncDirectory } = require('./durable.cjs');
const { markBackupStage } = require('./staging.cjs');
function within(child, parent) {
  const relative = path.relative(parent, child);
  return (
    !relative ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  );
}
function separate(source, target) {
  if (within(source, target) || within(target, source))
    throw Error('Data and backup directories must be independent.');
}
function stageFor(directory) {
  safeTree(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(directory, '.cartoteca-v2-'));
}
function removeStage(stage, parent) {
  if (
    path.dirname(path.resolve(stage)) !== path.resolve(parent) ||
    !path.basename(stage).startsWith('.cartoteca-v2-') ||
    !fs.lstatSync(stage).isDirectory()
  )
    throw Error('Unsafe staging cleanup.');
  fs.rmSync(stage, { recursive: true, force: true });
}
function createBackupKey(filename) {
  filename = path.resolve(filename);
  const parent = path.dirname(filename);
  safeTree(parent);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  // Provisioning is explicit. Never generate a replacement while creating/verifying a backup.
  fs.writeFileSync(filename, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
  syncFile(filename);
  syncDirectory(parent);
  return filename;
}
async function verifyV2Backup(
  source,
  keyFile,
  { workDirectory = path.dirname(path.resolve(source)) } = {},
) {
  if (archiveKind(source) === 'postgres')
    return require('../postgres/backup-service.cjs').verifyPostgresBackup(source, keyFile, {
      workDirectory,
    });
  source = path.resolve(source);
  safeTree(path.dirname(source));
  plainFile(source);
  const key = readKey(keyFile),
    stage = stageFor(workDirectory);
  try {
    const { recovered, seen } = await extractArchive(source, key, stage);
    return (await validateRecovered(recovered, seen)).counts;
  } finally {
    removeStage(stage, workDirectory);
  }
}
function assertPreparationMarker(upgradeCopy, preparationMarker) {
  if (
    preparationMarker !== undefined &&
    (!upgradeCopy ||
      ![
        'booking-read-budget-preparation-v1',
        'booking-public-links-preparation-v1',
        'paid-services-preparation-v1',
        'multi-service-billing-preparation-v1',
        'notification-queue-maintenance-preparation-v1',
        'assistant-state-rows-preparation-v1',
      ].includes(preparationMarker))
  )
    throw Error('Unsupported offline preparation marker');
}
async function recoverArchive(source, keyFile, destination, upgradeCopy, preparationMarker) {
  assertPreparationMarker(upgradeCopy, preparationMarker);
  destination = path.resolve(destination);
  safeTree(path.dirname(destination));
  if (fs.existsSync(destination)) throw Error('Restore destination must not exist.');
  const parent = path.dirname(destination),
    stage = stageFor(parent);
  try {
    safeTree(path.dirname(path.resolve(source)));
    plainFile(source);
    const { recovered, seen } = await extractArchive(source, readKey(keyFile), stage),
      { manifest, counts } = await validateRecovered(recovered, seen);
    // Normal disaster recovery MUST revoke capabilities. Only the explicit offline
    // upgrade-copy entry point preserves them; it must never replace a live source.
    if (!upgradeCopy) revokeRestoredCredentials(recovered, manifest);
    if (fs.existsSync(destination))
      throw Error('Restore destination appeared during verification.');
    // Reserve the name exclusively, then move into our own empty directory (Windows rename
    // cannot replace an existing directory). No pre-existing runtime can be overwritten.
    fs.mkdirSync(destination, { mode: 0o700 });
    const marker = path.join(destination, '.restore-in-progress');
    fs.writeFileSync(marker, preparationMarker || '2', { flag: 'wx', mode: 0o600 });
    syncFile(marker);
    syncDirectory(destination);
    try {
      for (const name of fs.readdirSync(recovered))
        fs.renameSync(path.join(recovered, name), path.join(destination, name));
      if (!preparationMarker) fs.unlinkSync(marker);
      syncDirectory(destination);
    } catch (error) {
      throw Error('Restore publication failed; retain the new destination for investigation.', {
        cause: error,
      });
    }
    return {
      ...counts,
      notificationsPaused: !upgradeCopy,
      sessionsRevoked: !upgradeCopy,
      ...(upgradeCopy ? { upgradeCopy: true } : {}),
    };
  } finally {
    removeStage(stage, parent);
  }
}
const restoreV2Backup = async (source, keyFile, destination, options = {}) =>
  archiveKind(source) === 'postgres'
    ? require('../postgres/backup-service.cjs').restorePostgresBackup(
        source,
        keyFile,
        destination,
        {
          ...options,
          applicationRole: require('../postgres/connection.cjs').applicationRole(
            options.applicationRole,
          ),
          connection: options.connection,
        },
      )
    : recoverArchive(source, keyFile, destination, false);
// Not a restore mode exposed by the backup CLI/HTTP. The source must be stopped
// before a later switch; running both copies would duplicate capabilities/delivery.
const recoverUpgradeCopy = async (
  source,
  keyFile,
  destination,
  { preparationMarker, ...options } = {},
) => {
  assertPreparationMarker(true, preparationMarker);
  if (archiveKind(source) === 'postgres') {
    if (preparationMarker)
      throw Error('Use explicit PostgreSQL structural migrations for this archive.');
    return require('../postgres/backup-service.cjs').restorePostgresBackup(
      source,
      keyFile,
      destination,
      {
        ...options,
        upgradeCopy: true,
        applicationRole: require('../postgres/connection.cjs').applicationRole(
          options.applicationRole,
        ),
        connection: options.connection,
      },
    );
  }
  return recoverArchive(source, keyFile, destination, true, preparationMarker);
};
async function createV2Backup({
  source,
  directory,
  keyFile,
  backupJobId,
  destinationId,
  connection,
  connectionOptions,
  applicationRole,
  storageBackend,
}) {
  const postgres = fs.existsSync(path.join(source, 'postgresql-runtime.json'));
  if (
    (storageBackend !== undefined && !['sqlite', 'postgres'].includes(storageBackend)) ||
    (storageBackend === 'postgres' && !postgres) ||
    (storageBackend === 'sqlite' && postgres)
  )
    throw Error('BACKUP_CONFIGURATION');
  if (postgres)
    return require('../postgres/backup-service.cjs').createPostgresBackup({
      source,
      directory,
      keyFile,
      backupJobId,
      destinationId,
      applicationRole: require('../postgres/connection.cjs').applicationRole(applicationRole),
      connection,
      connectionOptions,
    });
  const started = Date.now();
  source = path.resolve(source);
  directory = path.resolve(directory);
  keyFile = path.resolve(keyFile);
  separate(source, directory);
  if (within(keyFile, source) || within(keyFile, directory))
    throw Error('Store the backup key separately from data and archives.');
  const key = readKey(keyFile),
    stage = stageFor(directory),
    data = path.join(stage, 'data');
  fs.mkdirSync(data, { mode: 0o700 });
  const name =
      'cartoteca-v2-' +
      new Date().toISOString().replace(/[:.]/g, '-') +
      '-' +
      crypto.randomBytes(4).toString('hex') +
      '.enc',
    target = path.join(directory, name),
    partial = path.join(stage, name);
  try {
    markBackupStage(stage, 'backup-copy', { backupJobId, destinationId });
    const snapshotStarted = Date.now(),
      snapshot = snapshotDatabases(source, data),
      files = [];
    const snapshotMilliseconds = Date.now() - snapshotStarted;
    for (const name of snapshot.files) {
      const file = path.join(data, name);
      files.push({ name, size: fs.statSync(file).size, sha256: await digest(file) });
    }
    const manifest = {
      format: 2,
      createdAt: new Date().toISOString(),
      cabinets: snapshot.cabinets,
      organizations: snapshot.organizations,
      files,
    };
    fs.writeFileSync(path.join(data, 'manifest.json'), JSON.stringify(manifest), {
      flag: 'wx',
      mode: 0o600,
    });
    const localChecksum = await writeArchive(
      data,
      ['manifest.json', ...snapshot.files],
      partial,
      key,
    );
    // Both decryptability and every database/key/photo/reference are tested before publication.
    const counts = await verifyV2Backup(partial, keyFile, { workDirectory: stage });
    syncFile(partial);
    fs.linkSync(partial, target);
    syncDirectory(directory);
    return {
      file: target,
      localChecksum,
      ...counts,
      verified: true,
      snapshotMilliseconds,
      durationMilliseconds: Date.now() - started,
      archiveBytes: fs.statSync(target).size,
    };
  } finally {
    removeStage(stage, directory);
  }
}
module.exports = {
  createV2Backup,
  verifyV2Backup,
  restoreV2Backup,
  recoverUpgradeCopy,
  createBackupKey,
};
