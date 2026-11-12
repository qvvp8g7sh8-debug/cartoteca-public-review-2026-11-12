const { createConfiguredMultiServer } = require('../src/server/application/max-startup.cjs');
const { configuration } = require('../src/server/config.cjs');

// The same application and local databases, with no HTTP listener or second data owner.
async function startBackground(options = {}, dependencies) {
  let config = {
    ...configuration(options, dependencies?.environment),
    processRole: 'background',
  };
  let server, fatalError;
  const onFatal = () => {
    if (fatalError) return;
    fatalError = Object.assign(Error('Хранилище временно недоступно.'), {
      code: 'POSTGRES_EXECUTOR_FAILED',
    });
    if (server) {
      try {
        server.stopBackground?.();
      } finally {
        server.emit('backgroundError', fatalError);
      }
    }
  };
  // SQLite startup retains its existing dependency graph and lifecycle.
  if (config.storageBackend === 'postgres')
    config =
      await require('../src/server/infrastructure/postgres/initialize.cjs').initializePostgresOwner(
        config,
        { onFatal },
      );
  try {
    server = await createConfiguredMultiServer(config, dependencies);
    // A failed owner may report while asynchronous provider setup is pending.
    // Do not start jobs or announce readiness before the lifecycle can attach.
    if (fatalError) throw fatalError;
  } catch (error) {
    try {
      server?.close();
    } finally {
      await config.databaseOwner?.close();
    }
    throw error;
  }
  const keepAlive = setInterval(() => {}, 2147483647);
  server.once('close', () => clearInterval(keepAlive));
  try {
    server.startBackground();
    if (fatalError) throw fatalError;
  } catch (error) {
    server.close();
    throw error;
  }
  return server;
}

if (require.main === module) {
  const lifecycle =
    require('../src/server/application/entrypoint-lifecycle.cjs').createEntrypointLifecycle();
  startBackground()
    .then((server) => {
      if (!lifecycle.attach(server)) return;
      console.log('Картотека: фоновый процесс запущен без HTTP-порта.');
      process.send?.({ ready: true, role: 'background' });
    })
    .catch(() => {
      console.error('Фоновый процесс не запущен. Проверьте подготовку данных и настройки.');
      lifecycle.stop(1);
    });
}

module.exports = { startBackground };
