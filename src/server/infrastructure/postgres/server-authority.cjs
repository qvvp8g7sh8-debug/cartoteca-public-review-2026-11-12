const { Client } = require('pg');
const { createHash } = require('node:crypto');
const { readRuntime } = require('./runtime.cjs');
const { serverConnection } = require('./connection.cjs');
const { verifyAssetProfile } = require('./catalog-postgres.cjs');
function failure(code) {
  return Object.assign(Error('Экземпляр сервера PostgreSQL недоступен.'), { code, status: 503 });
}
async function acquirePostgresServerAuthority(
  config,
  { onLost, createClient = (settings) => new Client(settings) } = {},
) {
  const marker = readRuntime(config.dataDir);
  const connection = await serverConnection(config.postgres, {
    profile: config.postgresProfile,
    allowedHosts: config.postgresAllowedHosts,
    pin: config.postgresPin,
  });
  const client = createClient({
    ...connection,
    query_timeout: 5000,
    application_name: 'cartoteca-production-guardian',
  });
  const key = createHash('sha256')
    .update('cartoteca:postgres-server:v1:' + marker.platformStoreId)
    .digest()
    .readBigInt64BE()
    .toString();
  let state = 'starting',
    releasing;
  const lost = () => {
    if (state !== 'held') return;
    state = 'lost';
    onLost?.();
  };
  client.on('error', lost);
  try {
    await client.connect();
    await verifyAssetProfile(client, marker);
    const result = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS held', [key]);
    if (result.rows[0]?.held !== true) throw failure('POSTGRES_SERVER_ALREADY_RUNNING');
    state = 'held';
  } catch (error) {
    state = 'closed';
    await client.end().catch(() => {});
    throw error;
  }
  return {
    get state() {
      return state;
    },
    release() {
      if (releasing) return releasing;
      releasing = (async () => {
        const wasHeld = state === 'held';
        state = 'releasing';
        try {
          if (wasHeld) {
            const result = await client.query('SELECT pg_advisory_unlock($1::bigint) AS released', [
              key,
            ]);
            if (result.rows[0]?.released !== true)
              throw failure('POSTGRES_SERVER_AUTHORITY_RELEASE_FAILED');
          }
        } finally {
          await client.end();
          state = 'closed';
        }
      })();
      return releasing;
    },
  };
}
module.exports = { acquirePostgresServerAuthority };
