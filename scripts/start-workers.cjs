const cluster = require('node:cluster');
const {
  createConfiguredMultiServer,
  createPreflightServer,
} = require('../src/server/application/max-startup.cjs');
const { configuration } = require('../src/server/config.cjs');
const count = Number(process.env.WEB_CONCURRENCY || 2);
if (!Number.isSafeInteger(count) || count < 1 || count > 16)
  throw Error('WEB_CONCURRENCY must be an integer from 1 to 16.');
const config = configuration();
if (config.storageBackend === 'postgres')
  throw Error(
    'Use start:postgres: stateful assistant ownership is isolated from parallel query workers.',
  );
if (config.assistantAppointmentSavingEnabled === true && count > 1)
  throw Error('Assistant automatic saving requires WEB_CONCURRENCY=1.');
if (!['combined', 'web'].includes(config.processRole))
  throw Error('HTTP workers require the combined or web process role.');
if (cluster.isPrimary) {
  // Apply migrations once before parallel startup. No listener, bot polling or clinical reads.
  createPreflightServer(config)
    .then((preflight) => {
      preflight.once('close', launch);
      preflight.close();
    })
    .catch(() => {
      console.error('Проверка запуска не пройдена. Проверьте подготовленную схему данных.');
      process.exitCode = 1;
    });
  function launch() {
    let stopping = false,
      restarts = [],
      ready = new Set();
    const stop = (code = 0) => {
      if (stopping) return;
      stopping = true;
      process.exitCode = code;
      for (const worker of Object.values(cluster.workers)) worker.send('stop');
      const deadline = setTimeout(() => {
        for (const worker of Object.values(cluster.workers)) worker.kill();
        process.exit(code);
      }, 5000);
      deadline.unref();
      cluster.disconnect(() => {
        clearTimeout(deadline);
        process.exit(code);
      });
    };
    process.on('SIGINT', () => stop());
    process.on('SIGTERM', () => stop());
    process.on('message', (message) => {
      if (message === 'stop') stop();
    });
    cluster.on('message', (worker, message) => {
      if (message?.ready) {
        ready.add(worker.id);
        if (ready.size === count) {
          console.log(
            `Картотека: ${count} рабочих процессов, http://${config.host}:${message.port}`,
          );
          if (process.send) process.send({ ready: true, port: message.port, workers: count });
        }
      }
    });
    cluster.on('exit', (worker) => {
      ready.delete(worker.id);
      if (stopping) return;
      const now = Date.now();
      restarts = restarts.filter((time) => time > now - 30000);
      restarts.push(now);
      if (restarts.length > 3) {
        console.error('Не удалось запустить рабочие процессы. Проверьте конфигурацию.');
        stop(1);
        return;
      }
      setTimeout(() => {
        if (!stopping) cluster.fork();
      }, 1000);
    });
    for (let i = 0; i < count; i++) cluster.fork();
  }
} else {
  const lifecycle =
    require('../src/server/application/entrypoint-lifecycle.cjs').createEntrypointLifecycle();
  createConfiguredMultiServer(config)
    .then((server) => {
      if (!lifecycle.attach(server)) return;
      server.listen(config.port, config.host, () =>
        process.send({ ready: true, port: server.address().port }),
      );
    })
    .catch(() => {
      console.error(
        'Не удалось запустить рабочий процесс. Проверьте подготовку данных и защищённые настройки.',
      );
      lifecycle.stop(1);
    });
}
