const path = require('node:path');
const {
  createMaxProtectedConfig,
} = require('../src/server/infrastructure/max-protected-config.cjs');
const { createMaxSetupServer } = require('../src/server/application/max-setup-server.cjs');
const args = process.argv.slice(2);
const port =
  args.length === 2 && args[0] === '--port' && /^\d{1,5}$/.test(args[1]) ? Number(args[1]) : 0;
if ((args.length && (!port || port > 65535)) || process.platform !== 'win32')
  throw Error('Run local MAX setup on Windows without token arguments.');
const file = path.resolve(__dirname, '../private/max-bot.dpapi');
const server = createMaxSetupServer({ store: createMaxProtectedConfig(file) });
server.listen(port, '127.0.0.1', () =>
  console.log('MAX_SETUP_URL=http://127.0.0.1:' + server.address().port + '/'),
);
server.on('error', () => {
  console.error('Локальное окно MAX не запущено.');
  process.exitCode = 1;
});
