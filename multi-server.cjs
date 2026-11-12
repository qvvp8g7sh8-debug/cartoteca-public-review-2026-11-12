const { createMultiServer } = require('./src/server/application/server.cjs');
const { configuration } = require('./src/server/config.cjs');
if (require.main === module) {
  const config = configuration();
  if (!['combined', 'web'].includes(config.processRole))
    throw Error('HTTP start requires combined/web; use start:background for the background role.');
  const lifecycle =
    require('./src/server/application/entrypoint-lifecycle.cjs').createEntrypointLifecycle();
  const create =
    config.storageBackend === 'postgres'
      ? require('./src/server/application/postgres-server.cjs').createPostgresServer
      : require('./src/server/application/max-startup.cjs').createConfiguredMultiServer;
  create(config)
    .then((server) => {
      if (!lifecycle.attach(server)) return;
      server.listen(config.port, config.host, () =>
        console.log(`Картотека v2: http://${config.host}:${server.address().port}`),
      );
    })
    .catch(() => {
      console.error('Картотека не запущена. Проверьте подготовку данных и защищённые настройки.');
      lifecycle.stop(1);
    });
}
module.exports = { createMultiServer };
