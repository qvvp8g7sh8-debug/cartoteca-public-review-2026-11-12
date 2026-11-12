const { configuration } = require('../src/server/config.cjs');
const { createEntrypointLifecycle } = require('../src/server/application/entrypoint-lifecycle.cjs');

async function startIsolated(options = {}) {
  const config = configuration(options);
  if (
    config.production ||
    config.releaseGate ||
    !['127.0.0.1', '::1', 'localhost'].includes(config.host)
  )
    throw Error('Isolated start is an explicit local profile.');
  const { createIsolatedServer } = require('../src/server/application/isolated-server.cjs');
  const server = await createIsolatedServer(config);
  server.localPort = config.port;
  server.localHost = config.host;
  return server;
}
function runLocalPreview(options = {}) {
  const lifecycle = createEntrypointLifecycle();
  // The executable preview never initializes or delivers through real providers.
  // Programmatic callers may supply an explicitly configured local profile.
  startIsolated({
    maxEnabled: false,
    pushEnabled: false,
    paymentNetworkEnabled: false,
    telegramBot: null,
    supportBot: null,
    sendMail: null,
    supportDelivery: { telegram: null, email: null },
    telegramIdentityAutostart: false,
    telegramAutostart: false,
    maxAutostart: false,
    pushAutostart: false,
    supportAutostart: false,
    adminEmailAutostart: false,
    bookingPublicationAutostart: false,
    ...options,
  })
    .then((server) => {
      if (!lifecycle.attach(server)) return;
      server.once('error', () => {
        console.error('Изолированный локальный режим не смог открыть порт.');
        lifecycle.stop(1);
      });
      server.listen(server.localPort || 4174, server.localHost || '127.0.0.1', () => {
        console.log('Картотека: изолированный локальный режим готов.');
      });
    })
    .catch(() => {
      console.error('Изолированный локальный режим не запущен.');
      lifecycle.stop(1);
    });
}
if (require.main === module) runLocalPreview();
module.exports = { startIsolated, runLocalPreview };
