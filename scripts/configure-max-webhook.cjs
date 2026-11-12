const { configuration } = require('../src/server/config.cjs');
const { assertPreparedNotifications } = require('../src/server/application/max-startup.cjs');
const { configuredMax } = require('../src/server/modules/notifications/max-adapter.cjs');
const { MAX_USERNAME } = require('../src/server/modules/notifications/max-connections.cjs');
const {
  createMaxProtectedConfig,
} = require('../src/server/infrastructure/max-protected-config.cjs');

// Explicit external mutation command. Never imported/called by application startup.
(async () => {
  if (process.argv.length !== 3 || process.argv[2] !== '--register')
    throw Error('Registration requires explicit --register.');
  const config = configuration();
  if (!config.maxEnabled || !config.origin.startsWith('https://'))
    throw Error('Enable a prepared HTTPS MAX deployment before registration.');
  assertPreparedNotifications(config.dataDir);
  const protectedConfig = process.env.MAX_PROTECTED_CONFIG
    ? await createMaxProtectedConfig(process.env.MAX_PROTECTED_CONFIG).load()
    : null;
  const secret = process.env.MAX_WEBHOOK_SECRET || protectedConfig?.webhookSecret || '';
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw Error('Webhook secret required.');
  const bot = configuredMax({
    enabled: true,
    token: process.env.MAX_BOT_TOKEN || protectedConfig?.token || '',
  });
  if (!bot || (await bot.initialize()).username !== MAX_USERNAME) throw Error('Different bot.');
  const url = new URL('/api/max/webhook', config.origin).href;
  const existing = await bot.subscriptions();
  if (existing.some((entry) => entry.url !== url))
    throw Error('Other subscriptions exist; do not replace them automatically.');
  await bot.subscribe(url, secret);
  console.log('Приём событий MAX зарегистрирован. Токен и секрет не выводятся.');
})().catch(() => {
  console.error(
    'Подключение событий MAX не завершено. Проверьте бот, HTTPS, схему и защищённую конфигурацию; другие подписки не удалялись.',
  );
  process.exitCode = 1;
});
