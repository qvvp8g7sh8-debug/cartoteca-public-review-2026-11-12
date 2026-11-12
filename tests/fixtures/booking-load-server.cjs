const path = require('node:path');
const os = require('node:os');
const { createMultiServer } = require('../../multi-server.cjs');
const directory = path.resolve(process.argv[2]);
if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('cartoteca-classic-'))
  throw Error('Only a synthetic load fixture may be served');
const server = createMultiServer({ dataDir: directory, production: false, origin: '',
  trustedProxies: [], telegramBot: null, supportBot: null, sendMail: null,
  telegramAutostart: false, supportAutostart: false, maxEnabled: false,
  maxConnectionsEnabled: false, commonNotificationsEnabled: false,
  metricsEnabled: true, metricsEmit: () => {} });
server.listen(0, '127.0.0.1', () => process.send({ ready: true, port: server.address().port }));
process.on('message', async message => {
  if (message.type === 'metrics') process.send({ metrics: server.requestMetrics.snapshot({ reset: true }) });
  if (message.type === 'stop') {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    process.exit(0);
  }
});
process.on('disconnect', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
