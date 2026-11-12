const path = require('node:path');
const { localOrigins } = require('./http/local-network.cjs');
const { processRole } = require('./application/process-role.cjs');
const root = path.resolve(__dirname, '../..');
function boundedInteger(value, minimum, maximum, name) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum)
    throw Error('Invalid ' + name + '.');
  return number;
}
function configuration(overrides = {}, environment = process.env) {
  const config = {
    dataDir: environment.CARTOTECA_DATA_DIR || path.join(root, 'runtime'),
    backupStatusFile: environment.BACKUP_STATUS_FILE || '',
    origin: environment.APP_ORIGIN || '',
    production: environment.NODE_ENV === 'production',
    trustedProxies: (environment.TRUSTED_PROXIES || '').split(','),
    port: Number(environment.PORT) || 4174,
    host: environment.BIND_HOST || '127.0.0.1',
    additionalOrigins: [],
    maxEnabled: environment.CARTOTECA_MAX_ENABLED === '1',
    pushEnabled: environment.CARTOTECA_PUSH_ENABLED === '1',
    scheduledNotifications: environment.CARTOTECA_SCHEDULED_NOTIFICATIONS === '1',
    notificationMaintenanceEnabled: environment.CARTOTECA_NOTIFICATION_MAINTENANCE === '1',
    paymentNetworkEnabled: environment.CARTOTECA_PAYMENT_NETWORK_ENABLED === '1',
    assistantAppointmentSavingEnabled: environment.CARTOTECA_ASSISTANT_APPOINTMENT_SAVING === '1',
    assistantStateBackend: environment.CARTOTECA_ASSISTANT_STATE_BACKEND || 'file',
    sharedCabinetWrites: environment.CARTOTECA_SHARED_CABINET_WRITES === '1',
    isolatedReadBudgets: environment.CARTOTECA_ISOLATED_READ_BUDGETS === '1',
    processRole: environment.CARTOTECA_PROCESS_ROLE || 'combined',
    storageBackend: environment.CARTOTECA_STORAGE_BACKEND || 'sqlite',
    ...overrides,
  };
  config.releaseGate = overrides.releaseGate ?? environment.CARTOTECA_RELEASE_GATE === '1';
  if (typeof config.releaseGate !== 'boolean') throw Error('Invalid release gate flag.');
  if (!['sqlite', 'postgres'].includes(config.storageBackend))
    throw Error('Invalid storage backend.');
  if (config.storageBackend === 'postgres') {
    const pgConnection = require('./infrastructure/postgres/connection.cjs');
    config.postgresProfile =
      config.postgresProfile || environment.CARTOTECA_POSTGRES_PROFILE || 'local';
    config.postgresAllowedHosts = pgConnection.allowedHosts(
      config.postgresAllowedHosts || environment.CARTOTECA_PG_ALLOWED_HOSTS,
    );
    if (
      (config.production || config.releaseGate || environment.CARTOTECA_RELEASE_GATE === '1') &&
      config.postgresProfile !== 'production-v1'
    )
      throw Error('Production PostgreSQL requires its explicit server profile.');
    if (
      config.postgresProfile === 'production-v1' &&
      !config.postgres &&
      environment.CARTOTECA_PG_PASSWORD
    )
      throw Error('Production PostgreSQL credentials require a secret file.');
    const supplied = config.postgres || {
      host: environment.CARTOTECA_PG_HOST || '127.0.0.1',
      port: Number(environment.CARTOTECA_PG_PORT || 5432),
      database: environment.CARTOTECA_PG_DATABASE || '',
      user: environment.CARTOTECA_PG_USER || '',
      password: pgConnection.secretValue(environment, 'CARTOTECA_PG_PASSWORD') || '',
    };
    config.postgres = pgConnection.connectionSettings(supplied, {
      profile: config.postgresProfile,
      allowedHosts: config.postgresAllowedHosts,
    });
    if (config.postgresPin) {
      if (config.postgresProfile !== 'production-v1')
        throw Error('Private PostgreSQL pins require the server profile.');
      pgConnection.validatePin(config.postgresPin, config.postgres.host);
    }
  } else {
    if (
      config.postgresProfile === 'production-v1' ||
      environment.CARTOTECA_POSTGRES_PROFILE === 'production-v1'
    )
      throw Error('The PostgreSQL server profile cannot run SQLite.');
    config.postgres = null;
  }
  if (typeof config.paymentNetworkEnabled !== 'boolean')
    throw Error('Invalid payment network flag.');
  if (typeof config.notificationMaintenanceEnabled !== 'boolean')
    throw Error('Invalid notification maintenance flag.');
  if (!['file', 'rows-v1'].includes(config.assistantStateBackend))
    throw Error('Invalid assistant state backend.');
  config.processRole = processRole(config.processRole);
  const readBudgetVersion =
    overrides.readBudgetVersion ?? environment.CARTOTECA_READ_BUDGET_VERSION ?? 0;
  if (![0, 1, '0', '1'].includes(readBudgetVersion)) throw Error('Invalid read-budget version.');
  config.readBudgetVersion = Number(readBudgetVersion);
  // Opt-in approval is separate from the registered copy's identity/schema checks.
  if (
    config.readBudgetVersion === 1 &&
    (config.sharedCabinetWrites !== true || config.isolatedReadBudgets !== true)
  )
    throw Error('Read-budget version 1 requires shared cabinet writes and isolated read budgets');
  if (
    config.isolatedReadBudgets &&
    (config.production || config.releaseGate || environment.CARTOTECA_RELEASE_GATE === '1') &&
    (config.readBudgetVersion !== 1 || config.sharedCabinetWrites !== true)
  )
    throw Error('Isolated read budgets require approved version 1 and shared cabinet writes');
  const memoryVersion =
    overrides.nativeMemoryBudgetVersion ?? environment.CARTOTECA_NATIVE_MEMORY_BUDGET_VERSION ?? 0;
  if (![0, 1, '0', '1'].includes(memoryVersion))
    throw Error('Invalid native memory budget version.');
  config.nativeMemoryBudgetVersion = Number(memoryVersion);
  config.nativeMemoryBudgetMiB = boundedInteger(
    overrides.nativeMemoryBudgetMiB ?? environment.CARTOTECA_NATIVE_MEMORY_BUDGET_MIB ?? 0,
    0,
    8192,
    'native memory budget MiB',
  );
  if (
    (config.nativeMemoryBudgetVersion === 0 && config.nativeMemoryBudgetMiB !== 0) ||
    (config.nativeMemoryBudgetVersion === 1 &&
      ![1536, 2560, 4096, 8192].includes(config.nativeMemoryBudgetMiB))
  )
    throw Error('Invalid managed native memory profile.');
  // Explicit operator capacity, never inferred from host CPUs or client input.
  config.nativeQueryWorkers = boundedInteger(
    overrides.nativeQueryWorkers ?? 2,
    2,
    6,
    'native query workers',
  );
  if (
    config.nativeQueryWorkers !== 2 &&
    (config.storageBackend !== 'postgres' ||
      config.postgresRevisionProfile !== 3 ||
      config.nativeMemoryBudgetVersion !== 1)
  )
    throw Error('Additional query workers require managed PostgreSQL profile 3.');
  config.nativeCommandOwners = boundedInteger(
    overrides.nativeCommandOwners ?? 2,
    2,
    4,
    'native command owners',
  );
  if (
    ([4096, 8192].includes(config.nativeMemoryBudgetMiB) || config.nativeCommandOwners > 2) &&
    (config.storageBackend !== 'postgres' ||
      config.postgresRevisionProfile !== 3 ||
      config.nativeMemoryBudgetVersion !== 1 ||
      ![4096, 8192].includes(config.nativeMemoryBudgetMiB) ||
      config.nativeCommandIsolation === false)
  )
    throw Error('Additional command owners require managed PostgreSQL profile 3 at 4096/8192 MiB.');
  if (config.nativeQueryWorkers > 4 && ![4096, 8192].includes(config.nativeMemoryBudgetMiB))
    throw Error('Additional query workers require the 4096/8192 MiB native profile.');
  if (
    Object.hasOwn(config, 'nativeDirectorySnapshots180') &&
    typeof config.nativeDirectorySnapshots180 !== 'boolean'
  )
    throw Error('Invalid native directory snapshot option.');
  if (
    config.nativeDirectorySnapshots180 === true &&
    (config.storageBackend !== 'postgres' ||
      config.postgresRevisionProfile !== 3 ||
      config.nativeMemoryBudgetVersion !== 1)
  )
    throw Error('Native directory snapshots require managed PostgreSQL profile 3.');
  if (
    Object.hasOwn(config, 'nativeQueryAffinity184') &&
    typeof config.nativeQueryAffinity184 !== 'boolean'
  )
    throw Error('Invalid native query affinity option.');
  if (
    config.nativeQueryAffinity184 === true &&
    (config.storageBackend !== 'postgres' ||
      config.postgresRevisionProfile !== 3 ||
      config.nativeMemoryBudgetVersion !== 1 ||
      config.nativeMemoryBudgetMiB !== 8192 ||
      config.nativeDirectorySnapshots180 !== true)
  )
    throw Error('Native query affinity requires managed PostgreSQL 8192 MiB directory snapshots.');
  config.cabinetSchema = boundedInteger(
    overrides.cabinetSchema ?? environment.CARTOTECA_CABINET_SCHEMA ?? 0,
    0,
    2,
    'cabinet schema',
  );
  // A local capacity, not permission to run several assistant executors.
  config.assistantDialogueCapacity = boundedInteger(
    overrides.assistantDialogueCapacity ?? environment.CARTOTECA_ASSISTANT_DIALOGUE_CAPACITY ?? 100,
    1,
    10000,
    'assistant dialogue capacity',
  );
  config.tenantCacheLimit = boundedInteger(
    overrides.tenantCacheLimit ?? environment.CARTOTECA_TENANT_CACHE_LIMIT ?? 64,
    1,
    1024,
    'tenant cache limit',
  );
  config.tenantIdleMs = boundedInteger(
    overrides.tenantIdleMs ?? environment.CARTOTECA_TENANT_IDLE_MS ?? 0,
    0,
    86400000,
    'tenant idle timeout',
  );
  const maximumReadCacheMiB = config.nativeMemoryBudgetMiB === 8192 ? 1152 : 512;
  config.tenantReadCacheBytes = boundedInteger(
    overrides.tenantReadCacheBytes ??
      boundedInteger(
        environment.CARTOTECA_READ_CACHE_MIB ?? 64,
        0,
        maximumReadCacheMiB,
        'read cache MiB',
      ) *
        1024 *
        1024,
    0,
    maximumReadCacheMiB * 1024 * 1024,
    'read cache bytes',
  );
  config.dataDir = path.resolve(config.dataDir);
  config.additionalOrigins = localOrigins(config.additionalOrigins);
  if (config.additionalOrigins.length && (config.origin || config.production))
    throw Error('Wi-Fi HTTP нельзя смешивать с APP_ORIGIN/production.');
  if (config.origin && new URL(config.origin).origin !== config.origin)
    throw Error('APP_ORIGIN must be an exact origin.');
  if (config.production && !config.origin.startsWith('https://'))
    throw Error('Production requires HTTPS APP_ORIGIN.');
  return config;
}
module.exports = { configuration, root };
