const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { Client } = require('pg');
const { markerName, readRuntime } = require('./runtime.cjs');
const { digest } = require('./catalog-sqlite.cjs');
const { operatorServerConnection, validatePin } = require('./connection.cjs');
const { validatePostgresSchema, verifyAssetProfile } = require('./catalog-postgres.cjs');
const profiles = new WeakMap();
function backupProfile(config) {
  if (config?.storageBackend !== 'postgres') return null;
  const connection = config.postgres || config.connection;
  const address = config.postgresPin
    ? validatePin(config.postgresPin, connection?.host)
    : connection?.host;
  const role = config.applicationRole || connection?.user;
  const localAlias =
    address === 'localhost' &&
    config.postgresProfile !== 'production-v1' &&
    config.connectionOptions?.profile !== 'production-v1';
  if (
    !connection ||
    (!net.isIP(address) && !localAlias) ||
    !Number.isSafeInteger(connection.port) ||
    connection.port < 1 ||
    connection.port > 65535 ||
    ![connection.database, role].every(
      (value) => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value),
    )
  )
    throw Error('BACKUP_CONFIGURATION');
  const source = path.resolve(config.source || config.dataDir),
    filename = path.join(source, markerName);
  const info = fs.lstatSync(filename, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16n * 1024n * 1024n)
    throw Error('BACKUP_CONFIGURATION');
  const stamp = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
  const target = JSON.stringify([source, address, connection.port, connection.database, role]);
  const previous = profiles.get(config);
  if (previous?.stamp === stamp && previous.target === target) return previous.profile;
  const marker = readRuntime(source);
  const current = fs.lstatSync(filename, { bigint: true });
  if (
    [current.dev, current.ino, current.size, current.mtimeNs, current.ctimeNs].join(':') !== stamp
  )
    throw Error('BACKUP_CONFIGURATION');
  const profile = {
    version: 1,
    backend: 'postgres',
    identity: digest([
      address,
      connection.port,
      connection.database,
      role,
      marker.platformStoreId,
      marker.migrationId,
      digest(marker),
    ]),
  };
  profiles.set(config, { stamp, target, profile });
  return profile;
}
function sameProfile(actual, expected) {
  return (
    actual?.version === 1 &&
    actual.backend === 'postgres' &&
    typeof actual.identity === 'string' &&
    /^[a-f0-9]{64}$/.test(actual.identity) &&
    actual.identity === expected?.identity
  );
}
// Independent operator check: authenticate to the current endpoint and attest
// technical schema/role/lineage. No application, key, photo or clinical row read.
async function verifyCurrentBackupProfile(config) {
  if (config?.storageBackend !== 'postgres') return { config, profile: null };
  const connection = await operatorServerConnection(
    config.connection,
    process.env,
    config.connectionOptions,
  );
  const production =
    (config.connectionOptions?.profile || process.env.CARTOTECA_POSTGRES_PROFILE) ===
    'production-v1';
  const pinned = {
    ...config,
    connection,
    connectionOptions: production
      ? { profile: 'production-v1', allowedHosts: [connection.host] }
      : { profile: 'local' },
  };
  const profile = backupProfile(pinned),
    marker = readRuntime(pinned.source);
  const client = new Client({ ...connection, query_timeout: 5000, statement_timeout: 5000 });
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    for (const kind of new Set(marker.stores.map((row) => row.kind)))
      await validatePostgresSchema(client, { kind, applicationRole: config.applicationRole });
    await verifyAssetProfile(client, marker);
    await client.query('COMMIT');
    if (!sameProfile(backupProfile(pinned), profile)) throw Error('BACKUP_CONFIGURATION');
    return { config: pinned, profile };
  } finally {
    await client.end();
  }
}
module.exports = { backupProfile, sameProfile, verifyCurrentBackupProfile };
