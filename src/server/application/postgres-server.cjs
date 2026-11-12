const { configuration } = require('../config.cjs');
const { preparePostgresRuntimeConfig } = require('../infrastructure/postgres/prepared-profile.cjs');
const {
  acquirePostgresServerAuthority,
} = require('../infrastructure/postgres/server-authority.cjs');
const { createIsolatedServer } = require('./isolated-server.cjs');
async function createPostgresServer(
  options = {},
  {
    prepare = preparePostgresRuntimeConfig,
    createServer = createIsolatedServer,
    acquireAuthority = acquirePostgresServerAuthority,
    environment = process.env,
  } = {},
) {
  const config = configuration(options, environment);
  if (config.storageBackend !== 'postgres')
    throw Error('The PostgreSQL server requires its explicit storage backend.');
  const prepared = { ...(await prepare(config)), releaseGate: config.releaseGate };
  // Only registered technical flags are derived. Provider and manual-save policy
  // remain the operator's configuration. One production gateway owns the set.
  if (prepared.postgresProfile !== 'production-v1') return createServer(prepared);
  let server, lostError;
  const authority = await acquireAuthority(prepared, {
    onLost: () => {
      if (lostError) return;
      lostError = Object.assign(Error('Экземпляр сервера PostgreSQL недоступен.'), {
        code: 'POSTGRES_SERVER_AUTHORITY_LOST',
        status: 503,
      });
      if (server) {
        server.closeAllConnections?.();
        server.close();
        server.emit('backgroundError', lostError);
      }
    },
  });
  if (lostError || authority.state !== 'held')
    throw lostError || Error('PostgreSQL server authority is unavailable.');
  // Constructor failure has no shutdown proof. The executable exits the failed
  // process; do not drop its lifetime fence while an executor may still exist.
  // Preparation can race an offline profile change while this gateway waits
  // for lifetime authority. Resolve it again under the same fence used by the
  // revision operator before deciding which executor topology may start.
  const guardedPrepared = {
    ...(await prepare({ ...prepared, postgresRevisionProfile: config.postgresRevisionProfile })),
    releaseGate: config.releaseGate,
  };
  if (lostError || authority.state !== 'held')
    throw lostError || Error('PostgreSQL server authority is unavailable.');
  server = await createServer(guardedPrepared);
  const originalClose = server.close.bind(server);
  let closing;
  const releaseIfConfirmed = () => {
    if (server.isolationStatus().closeState !== 'closed')
      throw Object.assign(Error('PostgreSQL server shutdown was not confirmed.'), {
        code: 'NATIVE_SHUTDOWN_FAILED',
      });
    return authority.release();
  };
  server.once('close', () => {
    if (server.isolationStatus().closeState === 'closed')
      void authority
        .release()
        .catch(() =>
          server.emit('backgroundError', Error('PostgreSQL server authority cleanup failed.')),
        );
  });
  server.close = (callback) => {
    if (!closing)
      closing = new Promise((resolve, reject) =>
        originalClose((error) => {
          if (error) return reject(error);
          Promise.resolve().then(releaseIfConfirmed).then(resolve, reject);
        }),
      );
    if (callback) void closing.then(() => callback(), callback);
    else void closing.catch((error) => server.emit('backgroundError', error));
    return server;
  };
  if (lostError || authority.state !== 'held') {
    server.close();
    throw lostError || Error('PostgreSQL server authority is unavailable.');
  }
  return server;
}
module.exports = { createPostgresServer };
