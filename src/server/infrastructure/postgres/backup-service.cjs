const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { operatorServerConnection } = require('./connection.cjs');
const {
  writeArchive,
  extractArchive,
  digest,
  limits,
  archiveKind,
} = require('../backup/archive.cjs');
const { safeTree, plainFile, readKey } = require('../backup/snapshot.cjs');
const { syncFile, syncDirectory } = require('../backup/durable.cjs');
const { markBackupStage } = require('../backup/staging.cjs');
const { snapshotPostgres, estimatePostgresBytes: estimate } = require('./backup-snapshot.cjs');
const { validatePostgresDirectory } = require('./backup-verify.cjs');
const { restoreVerifiedPostgres } = require('./backup-restore.cjs');
const { validPostgresArchiveName } = require('./backup-rows.cjs');
function within(child, parent) {
  const relative = path.relative(parent, child);
  return (
    !relative ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  );
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
    throw Error('Unsafe PostgreSQL backup staging cleanup.');
  fs.rmSync(stage, { recursive: true, force: true });
}
async function withClient(connection, callback, connectionOptions) {
  const client = new Client(
    await operatorServerConnection(connection, process.env, connectionOptions),
  );
  try {
    await client.connect();
    return await callback(client);
  } finally {
    await client.end();
  }
}
async function withVerifiedPostgresArchive(
  file,
  keyFile,
  { workDirectory = path.dirname(path.resolve(file)) } = {},
  callback,
) {
  file = path.resolve(file);
  safeTree(path.dirname(file));
  plainFile(file);
  if (archiveKind(file) !== 'postgres') throw Error('Not a PostgreSQL backup archive.');
  const stage = stageFor(path.resolve(workDirectory));
  try {
    const { recovered, seen } = await extractArchive(file, readKey(keyFile), stage, limits, {
      backend: 'postgres',
      validateName: validPostgresArchiveName,
    });
    const { manifest, counts } = await validatePostgresDirectory(recovered, seen);
    return await callback({ recovered, manifest, counts });
  } finally {
    removeStage(stage, workDirectory);
  }
}
async function verifyPostgresBackup(file, keyFile, options = {}) {
  return withVerifiedPostgresArchive(file, keyFile, options, async ({ counts }) => counts);
}
async function createPostgresBackup({
  source,
  directory,
  keyFile,
  connection,
  connectionOptions,
  applicationRole = 'cartoteca_app',
  backupJobId,
  destinationId,
}) {
  const started = Date.now();
  source = path.resolve(source);
  directory = path.resolve(directory);
  keyFile = path.resolve(keyFile);
  if (
    within(source, directory) ||
    within(directory, source) ||
    within(keyFile, source) ||
    within(keyFile, directory)
  )
    throw Error('Keep backup source, archive destination and key separate.');
  const key = readKey(keyFile),
    stage = stageFor(directory),
    data = path.join(stage, 'data');
  fs.mkdirSync(data, { mode: 0o700 });
  const name =
      'cartoteca-v2-pg-' +
      new Date().toISOString().replace(/[:.]/g, '-') +
      '-' +
      crypto.randomBytes(4).toString('hex') +
      '.enc',
    partial = path.join(stage, name),
    target = path.join(directory, name);
  try {
    markBackupStage(stage, 'backup-copy', { backupJobId, destinationId });
    const snapshotStarted = Date.now(),
      snapshot = await withClient(
        connection,
        (client) => snapshotPostgres(client, { source, stage: data, applicationRole }),
        connectionOptions,
      );
    const snapshotMilliseconds = Date.now() - snapshotStarted,
      files = [];
    for (const name of snapshot.names)
      files.push({
        name,
        size: fs.statSync(path.join(data, name)).size,
        sha256: await digest(path.join(data, name)),
      });
    const manifest = {
      format: 2,
      backend: 'postgres',
      postgresFormat: 1,
      createdAt: new Date().toISOString(),
      profile: snapshot.profile,
      ...(snapshot.revisionProfile ? { revisionProfile: snapshot.revisionProfile } : {}),
      stores: snapshot.stores,
      files,
    };
    fs.writeFileSync(path.join(data, 'manifest.json'), JSON.stringify(manifest), {
      flag: 'wx',
      mode: 0o600,
    });
    const localChecksum = await writeArchive(
      data,
      ['manifest.json', ...snapshot.names],
      partial,
      key,
      { backend: 'postgres', validateName: validPostgresArchiveName },
    );
    const counts = await verifyPostgresBackup(partial, keyFile, { workDirectory: stage });
    syncFile(partial);
    fs.linkSync(partial, target);
    syncDirectory(directory);
    return {
      file: target,
      localChecksum,
      ...counts,
      verified: true,
      backend: 'postgres',
      snapshotMilliseconds,
      durationMilliseconds: Date.now() - started,
      archiveBytes: fs.statSync(target).size,
      sqlRowBytes: snapshot.rowBytes,
    };
  } finally {
    removeStage(stage, directory);
  }
}
async function restorePostgresBackup(
  file,
  keyFile,
  destination,
  {
    connection,
    connectionOptions,
    applicationRole = 'cartoteca_app',
    offline = false,
    upgradeCopy = false,
    ...options
  } = {},
) {
  if (!offline) throw Error('PostgreSQL restore requires an explicitly offline fresh target.');
  destination = path.resolve(destination);
  safeTree(path.dirname(destination));
  if (fs.existsSync(destination)) throw Error('Restore destination must be new.');
  return withVerifiedPostgresArchive(
    file,
    keyFile,
    { workDirectory: path.dirname(destination) },
    ({ recovered, manifest }) =>
      withClient(
        connection,
        (client) =>
          restoreVerifiedPostgres(client, {
            recovered,
            manifest,
            destination,
            applicationRole,
            offline,
            upgradeCopy,
            ...options,
          }),
        connectionOptions,
      ),
  );
}
async function estimatePostgresBytes({ source, connection, connectionOptions }) {
  return withClient(
    connection,
    async (client) => (await estimate({ source, client })).sourceBytes,
    connectionOptions,
  );
}
module.exports = {
  createPostgresBackup,
  verifyPostgresBackup,
  restorePostgresBackup,
  withVerifiedPostgresArchive,
  estimatePostgresBytes,
  validPostgresArchiveName,
};
