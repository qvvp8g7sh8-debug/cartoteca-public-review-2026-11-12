const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { postgresPreviewConfiguration } = require('../scripts/start-postgres.cjs');
const dataDir = path.join(os.tmpdir(), 'synthetic-postgres-preview-config');
const environment = {
  CARTOTECA_PG_HOST: '127.0.0.1',
  CARTOTECA_PG_PORT: '5432',
  CARTOTECA_PG_DATABASE: 'synthetic',
  CARTOTECA_PG_USER: 'synthetic_app',
  CARTOTECA_PG_PASSWORD: 'synthetic-test-only',
  CARTOTECA_MAX_ENABLED: '1',
  CARTOTECA_PUSH_ENABLED: '1',
  CARTOTECA_PAYMENT_NETWORK_ENABLED: '1',
  CARTOTECA_ASSISTANT_APPOINTMENT_SAVING: '1',
  CARTOTECA_DATA_DIR: dataDir,
};
test('executable PostgreSQL preview keeps real deliveries/payments and assistant saving off despite enabled environment/options', () => {
  const overrides = {
    dataDir,
    maxEnabled: true,
    pushEnabled: true,
    paymentNetworkEnabled: true,
    assistantAppointmentSavingEnabled: true,
    telegramBot: {},
    supportBot: {},
    sendMail: () => {},
    supportDelivery: { telegram: () => {}, email: () => {} },
    telegramIdentityAutostart: true,
    telegramAutostart: true,
    maxAutostart: true,
    pushAutostart: true,
    supportAutostart: true,
    adminEmailAutostart: true,
    bookingPublicationAutostart: true,
  };
  for (const options of [{}, overrides]) {
    const config = postgresPreviewConfiguration(options, environment);
    for (const key of [
      'maxEnabled',
      'pushEnabled',
      'paymentNetworkEnabled',
      'assistantAppointmentSavingEnabled',
      'telegramIdentityAutostart',
      'telegramAutostart',
      'maxAutostart',
      'pushAutostart',
      'supportAutostart',
      'adminEmailAutostart',
      'bookingPublicationAutostart',
    ])
      assert.equal(config[key], false, key);
    for (const key of ['telegramBot', 'supportBot', 'sendMail'])
      assert.equal(config[key], null, key);
    assert.deepEqual(config.supportDelivery, { telegram: null, email: null });
    assert.equal(config.storageBackend, 'postgres');
    assert.equal(config.dataDir, path.resolve(dataDir));
  }
});
test('PostgreSQL preview retains explicit assets, loopback, production and release gates', () => {
  assert.throws(() => postgresPreviewConfiguration({}, {}));
  for (const addition of [
    { NODE_ENV: 'production' },
    { CARTOTECA_RELEASE_GATE: '1' },
    { CARTOTECA_PG_HOST: '192.0.2.1' },
    { BIND_HOST: '0.0.0.0' },
  ])
    assert.throws(() => postgresPreviewConfiguration({}, { ...environment, ...addition }));
  assert.throws(() => postgresPreviewConfiguration({ releaseGate: true }, environment));
});
