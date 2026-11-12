const { configuration } = require('../src/server/config.cjs');
const { createEntrypointLifecycle } = require('../src/server/application/entrypoint-lifecycle.cjs');
const readinessChecks = new WeakMap();
async function startPostgresServer(options = {}, dependencies = {}) {
  const environment = dependencies.environment || process.env;
  const config = (dependencies.configuration || configuration)(options, environment);
  const create =
    dependencies.createServer ||
    require('../src/server/application/postgres-server.cjs').createPostgresServer;
  const {
    attachPostgresReadiness,
    technicalReadiness,
  } = require('../src/server/infrastructure/postgres/readiness.cjs');
  const attach = dependencies.attachReadiness || attachPostgresReadiness;
  const inspect = dependencies.technicalReadiness || technicalReadiness;
  const server = await create(config);
  let readiness, failure;
  const failed = (error) => {
    failure = error || Error('PostgreSQL startup owner stopped.');
  };
  const closed = () => failed();
  server.on('backgroundError', failed);
  server.on('error', failed);
  server.once('close', closed);
  const assertReady = () => {
    if (failure || !inspect(server.isolationStatus()).ready)
      throw failure || Error('PostgreSQL startup owner is not ready.');
  };
  readinessChecks.set(server, assertReady);
  try {
    assertReady();
    readiness = await attach(server, {
      socketPath:
        environment.CARTOTECA_POSTGRES_READINESS_SOCKET || '/tmp/cartoteca-postgres-readiness.sock',
      dataDir: config.dataDir,
    });
    assertReady();
    server.localPort = config.port;
    server.localHost = config.host;
    return server;
  } catch (error) {
    await readiness?.close().catch(() => {});
    server.closeAllConnections?.();
    await new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
    throw error;
  }
}
function run() {
  const lifecycle = createEntrypointLifecycle();
  startPostgresServer()
    .then((server) => {
      if (!lifecycle.attach(server)) return;
      try {
        readinessChecks.get(server)();
        server.once('error', () => {
          console.error('PostgreSQL server listener failed.');
          lifecycle.stop(1);
        });
        server.listen(server.localPort, server.localHost, () =>
          console.log('PostgreSQL server is ready.'),
        );
      } catch {
        lifecycle.stop(1);
      }
    })
    .catch(() => {
      console.error('PostgreSQL server did not start; prepared data was not replaced.');
      lifecycle.stop(1);
    });
}
if (require.main === module) run();
module.exports = { startPostgresServer };
