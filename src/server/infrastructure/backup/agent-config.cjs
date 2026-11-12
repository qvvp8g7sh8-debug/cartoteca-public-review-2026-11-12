const path = require('node:path');
const crypto = require('node:crypto');
const { safeTree, readKey } = require('./snapshot.cjs');

function inside(child, parent) {
  const relative = path.relative(parent, child);
  return (
    !relative ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  );
}
function backupConfiguration(environment = process.env) {
  const required = (name) => {
    const value = environment[name];
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw Error('BACKUP_CONFIGURATION');
    return path.resolve(value);
  };
  const config = {
    source: required('CARTOTECA_DATA_DIR'),
    directory: required('BACKUP_DIR'),
    keyFile: required('BACKUP_KEY_FILE'),
    stateDirectory: required('BACKUP_STATE_DIR'),
    workDirectory: required('BACKUP_WORK_DIR'),
    statusFile: required('BACKUP_STATUS_FILE'),
    reserveBytes: 512 * 1024 ** 2,
    cadenceHours: 24,
    leaseMilliseconds: 2 * 60 * 60 * 1000,
    localCopies: 3,
    remote: null,
  };
  const hasPostgresMarker = require('node:fs').existsSync(
    path.join(config.source, 'postgresql-runtime.json'),
  );
  const requestedBackend = environment.CARTOTECA_STORAGE_BACKEND;
  if (
    (requestedBackend !== undefined && !['sqlite', 'postgres'].includes(requestedBackend)) ||
    (requestedBackend === 'postgres' && !hasPostgresMarker) ||
    (requestedBackend === 'sqlite' && hasPostgresMarker)
  )
    throw Error('BACKUP_CONFIGURATION');
  if (hasPostgresMarker) {
    config.storageBackend = 'postgres';
    config.applicationRole = require('../postgres/connection.cjs').applicationRole(
      undefined,
      environment,
    );
    const marker = require('../postgres/runtime.cjs').readRuntime(config.source);
    config.postgresIdentity = [marker.migrationId, marker.platformStoreId];
    config.connection = require('../postgres/connection.cjs').operatorSettings(
      undefined,
      environment,
    );
    config.connectionOptions = {
      profile: environment.CARTOTECA_POSTGRES_PROFILE || 'local',
      allowedHosts: require('../postgres/connection.cjs').allowedHosts(
        environment.CARTOTECA_PG_ALLOWED_HOSTS,
      ),
    };
  }
  const directories = [
    config.source,
    config.directory,
    config.stateDirectory,
    config.workDirectory,
    path.dirname(config.statusFile),
    path.dirname(config.keyFile),
  ];
  for (const directory of directories) safeTree(directory);
  for (let index = 0; index < directories.length; index++) {
    for (let other = index + 1; other < directories.length; other++) {
      if (
        inside(directories[index], directories[other]) ||
        inside(directories[other], directories[index])
      )
        throw Error('BACKUP_PATHS_OVERLAP');
    }
  }
  const names = ['ENDPOINT', 'REGION', 'BUCKET', 'ACCESS_KEY', 'SECRET_KEY'];
  if (names.some((name) => environment['BACKUP_S3_' + name])) {
    if (names.some((name) => !environment['BACKUP_S3_' + name]))
      throw Error('BACKUP_S3_CONFIGURATION');
    const endpoint = new URL(environment.BACKUP_S3_ENDPOINT);
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.pathname !== '/'
    )
      throw Error('BACKUP_S3_CONFIGURATION');
    const bucket = environment.BACKUP_S3_BUCKET,
      region = environment.BACKUP_S3_REGION;
    const prefix = environment.BACKUP_S3_PREFIX || 'cartoteca';
    if (
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
      !/^[a-zA-Z0-9-]{1,60}$/.test(region) ||
      !/^[a-zA-Z0-9/_-]{1,120}$/.test(prefix) ||
      prefix.split('/').some((part) => !part)
    )
      throw Error('BACKUP_S3_CONFIGURATION');
    config.remote = {
      endpoint: endpoint.origin,
      region,
      bucket,
      prefix,
      accessKey: environment.BACKUP_S3_ACCESS_KEY,
      secretKey: environment.BACKUP_S3_SECRET_KEY,
    };
  }
  // No credentials in journal/status. A changed destination invalidates old health receipts.
  config.destinationId = crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        config.source,
        config.directory,
        config.keyFile,
        crypto.createHash('sha256').update(readKey(config.keyFile)).digest('hex'),
        ...(config.storageBackend === 'postgres'
          ? [
              [
                'postgres',
                ...config.postgresIdentity,
                config.connection.host,
                config.connection.port,
                config.connection.database,
                config.applicationRole,
              ],
            ]
          : []),
        config.remote && [
          config.remote.endpoint,
          config.remote.bucket,
          config.remote.prefix,
          config.remote.region,
        ],
      ]),
    )
    .digest('hex');
  return config;
}
function backupStatusConfiguration(environment = process.env) {
  const source = environment.CARTOTECA_DATA_DIR,
    statusFile = environment.BACKUP_STATUS_FILE;
  if (![source, statusFile].every((value) => typeof value === 'string' && path.isAbsolute(value)))
    throw Error('BACKUP_CONFIGURATION');
  safeTree(source);
  safeTree(path.dirname(statusFile));
  const pg = require('../postgres/connection.cjs');
  return {
    storageBackend: 'postgres',
    source: path.resolve(source),
    statusFile: path.resolve(statusFile),
    applicationRole: pg.applicationRole(undefined, environment),
    connection: pg.operatorSettings(undefined, environment),
    connectionOptions: {
      profile: environment.CARTOTECA_POSTGRES_PROFILE || 'local',
      allowedHosts: pg.allowedHosts(environment.CARTOTECA_PG_ALLOWED_HOSTS),
    },
  };
}
module.exports = { backupConfiguration, backupStatusConfiguration, inside };
