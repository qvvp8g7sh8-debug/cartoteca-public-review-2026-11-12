const path = require('node:path');
const { configuration } = require('../src/server/config.cjs');
const {
  preparedPostgresProfile,
} = require('../src/server/infrastructure/postgres/prepared-profile.cjs');
function postgresPreviewConfiguration(options = {}, environment = process.env) {
  if (!options.dataDir && !environment.CARTOTECA_DATA_DIR)
    throw Error('Choose the separately prepared PostgreSQL asset directory.');
  const config = configuration(
    {
      ...options,
      dataDir: path.resolve(options.dataDir || environment.CARTOTECA_DATA_DIR),
      storageBackend: 'postgres',
    },
    environment,
  );
  if (
    config.production ||
    config.releaseGate ||
    !['127.0.0.1', '::1', 'localhost'].includes(config.host)
  )
    throw Error('PostgreSQL preview requires an explicit local profile.');
  // Resolved environment/options must not undo the executable preview's safety
  // defaults. Prepared copies may retain provider credentials and memberships.
  return {
    ...config,
    maxEnabled: false,
    pushEnabled: false,
    paymentNetworkEnabled: false,
    assistantAppointmentSavingEnabled: false,
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
  };
}
async function startPostgresPreview(options = {}, environment = process.env) {
  const config = postgresPreviewConfiguration(options, environment);
  const prepared = await preparedPostgresProfile(config.postgres, config.dataDir);
  require('./start-isolated.cjs').runLocalPreview({ ...config, ...prepared });
}
if (require.main === module)
  startPostgresPreview().catch(() => {
    console.error(
      'Локальный PostgreSQL не запущен. Проверьте отдельные подготовленные данные и подключение.',
    );
    process.exitCode = 1;
  });
module.exports = { startPostgresPreview, postgresPreviewConfiguration };
