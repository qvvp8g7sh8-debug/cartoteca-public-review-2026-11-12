const { Client } = require('pg');
const { createHash } = require('node:crypto');
const { configuration } = require('../src/server/config.cjs');
const {
  preparePostgresRuntimeConfig,
} = require('../src/server/infrastructure/postgres/prepared-profile.cjs');
const { serverConnection } = require('../src/server/infrastructure/postgres/connection.cjs');
const { readRuntime } = require('../src/server/infrastructure/postgres/runtime.cjs');
const { digest } = require('../src/server/infrastructure/postgres/catalog-sqlite.cjs');
const {
  validatePostgresSchema,
  verifyAssetProfile,
} = require('../src/server/infrastructure/postgres/catalog-postgres.cjs');
const {
  readPostgresReadiness,
  defaultSocketPath,
} = require('../src/server/infrastructure/postgres/readiness.cjs');

function assistantSavingPolicy(config) {
  const configured = config.assistantAppointmentSavingEnabled;
  if (
    typeof configured !== 'boolean' ||
    config.paymentNetworkEnabled !== false ||
    (configured &&
      (config.notificationSchema !== 19 ||
        config.readBudgetVersion !== 1 ||
        config.bookingLinksVersion !== 1 ||
        config.sharedCabinetWrites !== true ||
        config.isolatedReadBudgets !== true))
  )
    throw Error('POSTGRES_SERVER_POLICY_REQUIRED');
  return {
    version: configured ? 1 : 0,
    configured,
    enabled: configured && config.releaseGate !== true,
  };
}
async function assistantAuthorityProof(client, marker, policy) {
  const key = createHash('sha256')
    .update('cartoteca:assistant-authority:' + marker.platformStoreId)
    .digest()
    .readBigInt64BE();
  const unsigned = BigInt.asUintN(64, key);
  // Read only the exact technical session lock. No account, clinical row,
  // provider credential, backend PID or SQL text enters the returned proof.
  const result = await client.query(
    `SELECT count(*)::integer AS holders FROM pg_locks l
     JOIN pg_stat_activity a ON a.pid=l.pid
     WHERE l.locktype='advisory' AND l.granted AND l.mode='ExclusiveLock'
       AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
       AND l.classid=$1::oid AND l.objid=$2::oid AND l.objsubid=1
       AND a.datid=l.database AND a.usename=current_user
       AND a.application_name='cartoteca-assistant-authority'`,
    [(unsigned >> 32n).toString(), (unsigned & 0xffffffffn).toString()],
  );
  const holders = result.rows[0]?.holders;
  if (!Number.isSafeInteger(holders) || holders !== (policy.enabled ? 1 : 0))
    throw Error('POSTGRES_ASSISTANT_AUTHORITY_UNCONFIRMED');
  return { required: policy.enabled, owned: holders === 1, holders };
}

// This probe never creates an application, opens encryption assets, or reads
// clinical rows. Live executor evidence comes from the existing private owner.
async function postgresReadiness(options = {}, environment = process.env) {
  const input = configuration(options, environment);
  if (
    input.storageBackend !== 'postgres' ||
    input.postgresProfile !== 'production-v1' ||
    input.production !== true
  )
    throw Error('POSTGRES_SERVER_PROFILE_REQUIRED');
  if (
    input.paymentNetworkEnabled !== false ||
    typeof input.assistantAppointmentSavingEnabled !== 'boolean'
  )
    throw Error('POSTGRES_SERVER_POLICY_REQUIRED');
  const config = await preparePostgresRuntimeConfig(input),
    marker = readRuntime(config.dataDir),
    assistantPolicy = assistantSavingPolicy(config);
  const executors = await readPostgresReadiness({
    socketPath: environment.CARTOTECA_POSTGRES_READINESS_SOCKET || defaultSocketPath,
    markerHash: digest(marker),
  });
  const client = new Client({
    ...(await serverConnection(config.postgres, {
      profile: config.postgresProfile,
      allowedHosts: config.postgresAllowedHosts,
      pin: config.postgresPin,
    })),
    query_timeout: 5000,
    statement_timeout: 5000,
  });
  let assistantAuthority;
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    for (const kind of new Set(marker.stores.map((row) => row.kind)))
      await validatePostgresSchema(client, { kind, applicationRole: client.user });
    await verifyAssetProfile(client, marker);
    assistantAuthority = await assistantAuthorityProof(client, marker, assistantPolicy);
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
  return {
    version: 1,
    backend: 'postgres',
    profile: 'production-v1',
    ready: executors.ready,
    schema: marker.notificationSchema,
    nativeSchema: true,
    rls: true,
    assetLineage: true,
    preparedModes: true,
    stores: marker.stores.length,
    readBudgetVersion: config.readBudgetVersion,
    bookingLinksVersion: config.bookingLinksVersion,
    assistantStateBackend: config.assistantStateBackend,
    sharedCabinetWrites: config.sharedCabinetWrites,
    paymentNetworkEnabled: config.paymentNetworkEnabled,
    assistantSavingVersion: assistantPolicy.version,
    assistantAppointmentSavingConfigured: assistantPolicy.configured,
    assistantAppointmentSavingEnabled: assistantPolicy.enabled,
    assistantAuthority,
    releaseGate: config.releaseGate,
    executors,
  };
}
async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--technical-output')
    throw Error('POSTGRES_PROBE_USAGE');
  const proof = await postgresReadiness();
  console.log(JSON.stringify(proof));
  if (!proof.ready) process.exitCode = 1;
}
if (require.main === module)
  main().catch(() => {
    console.log(
      JSON.stringify({ version: 1, backend: 'postgres', ready: false, code: 'POSTGRES_NOT_READY' }),
    );
    process.exitCode = 1;
  });
module.exports = { postgresReadiness, assistantSavingPolicy, assistantAuthorityProof };
