const { configuration } = require('../config.cjs');
const { createMultiServer } = require('./server.cjs');
const { configuredMax } = require('../modules/notifications/max-adapter.cjs');
const { MAX_USERNAME } = require('../modules/notifications/max-connections.cjs');
const { fail } = require('../../shared/errors.cjs');
const { createMaxProtectedConfig } = require('../infrastructure/max-protected-config.cjs');
const {
  notificationSchema: resolveNotificationSchema,
  assertPreparedNotifications,
} = require('./startup-schema.cjs');
// Only an explicit enable reads secrets or calls /me. Never applies migrations or subscribes.
async function createConfiguredMultiServer(
  options = {},
  { environment = process.env, fetchImpl = fetch } = {},
) {
  const config = configuration(
    { ...options, releaseGate: options.releaseGate ?? environment.CARTOTECA_RELEASE_GATE === '1' },
    environment,
  );
  const notificationSchema = resolveNotificationSchema(config, environment);
  if (notificationSchema >= 15)
    assertPreparedNotifications(config.dataDir, notificationSchema, {
      databaseOwner: options.databaseOwner,
    });
  if (config.releaseGate || config.processRole === 'preflight' || !config.maxEnabled)
    return createMultiServer({ ...config, notificationSchema });
  // Protected file is read only after explicit enable; never loaded by default preview.
  const protectedConfig = environment.MAX_PROTECTED_CONFIG
    ? await createMaxProtectedConfig(environment.MAX_PROTECTED_CONFIG).load()
    : null;
  const secret = environment.MAX_WEBHOOK_SECRET || protectedConfig?.webhookSecret || '';
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret))
    throw fail(503, 'Настройте секрет приёма MAX в защищённой конфигурации.');
  const bot = configuredMax({
    enabled: true,
    token: environment.MAX_BOT_TOKEN || protectedConfig?.token || '',
    fetchImpl,
  });
  if (!bot) throw fail(503, 'Настройте токен MAX в защищённой конфигурации.');
  const identity = await bot.initialize();
  if (identity.username !== MAX_USERNAME) throw fail(409, 'Токен относится к другому MAX-боту.');
  return createMultiServer({
    ...config,
    notificationSchema,
    commonNotificationsEnabled: true,
    maxConnectionsEnabled: true,
    maxAutostart: options.maxAutostart !== false,
    maxBot: bot,
    maxBotIdentity: identity,
    maxWebhookSecret: secret,
  });
}
const createPreflightServer = (options = {}, dependencies) =>
  createConfiguredMultiServer({ ...options, processRole: 'preflight' }, dependencies);
module.exports = {
  createConfiguredMultiServer,
  createPreflightServer,
  assertPreparedNotifications,
};
