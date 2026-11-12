const fs = require('node:fs');
const path = require('node:path');
const { configuration, root } = require('../src/server/config.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const { createIsolatedServer } = require('../src/server/application/isolated-server.cjs');

const options = configuration({
  host: '127.0.0.1',
  port: 4174,
  origin: '',
  additionalOrigins: [],
  production: false,
  assistantCodexEnabled: true,
  assistantLocalSpeechEnabled: true,
  assistantWhisperDirectory: path.resolve(root, '../tools/whisper'),
  assistantWhisperThreads: 4,
  maxEnabled: false,
  pushEnabled: false,
  maxAutostart: false,
  pushAutostart: false,
  telegramIdentityAutostart: false,
  bookingPublicationAutostart: false,
  notificationMaintenanceEnabled: false,
  paymentNetworkEnabled: false,
  telegramAutostart: false,
  supportAutostart: false,
  adminEmailAutostart: false,
  telegramBot: null,
  sendMail: null,
  supportDelivery: { telegram: null, email: null },
});
const relative = path.relative(root, options.dataDir);
if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep))
  throw Error('Local preview requires an existing project-scoped data directory.');
if (!fs.existsSync(path.join(options.dataDir, 'platform', 'platform.sqlite')))
  throw Error('Local preview will not create a new empty platform database.');

async function startPreview() {
  const lifecycle =
    require('../src/server/application/entrypoint-lifecycle.cjs').createEntrypointLifecycle();
  try {
    const server =
      process.env.CARTOTECA_LOCAL_ISOLATION === '0'
        ? createMultiServer(options)
        : await createIsolatedServer(options);
    if (!lifecycle.attach(server)) return server;
    server.on('error', (error) => {
      console.error('Local preview could not listen:', error.code || 'UNKNOWN');
      lifecycle.stop(1);
    });
    server.listen(options.port, options.host, () =>
      console.log('Local preview: http://127.0.0.1:4174/; external deliveries disabled.'),
    );
    return server;
  } catch {
    console.error('Local preview could not initialize isolated application owners.');
    lifecycle.stop(1);
  }
}
if (require.main === module) void startPreview();
module.exports = { startPreview };
