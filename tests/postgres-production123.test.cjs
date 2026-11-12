const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { configuration } = require('../src/server/config.cjs');
const {
  serverConnection,
  connectionSettings,
  privateAddress,
  productionPostgresProfile,
  secretFile,
  secretValue,
  operatorServerConnection,
} = require('../src/server/infrastructure/postgres/connection.cjs');
const { createPostgresServer } = require('../src/server/application/postgres-server.cjs');
const connection = {
  host: 'postgres',
  port: 5432,
  database: 'synthetic',
  user: 'cartoteca_app',
  password: 'synthetic-only-password',
};
const production = {
  storageBackend: 'postgres',
  postgresProfile: 'production-v1',
  postgresAllowedHosts: ['postgres'],
  postgres: connection,
  production: true,
  origin: 'https://synthetic.test',
  host: '0.0.0.0',
};

test('explicit production PostgreSQL profile admits only its exact configured private host and retains local/SQLite gates', () => {
  const config = configuration(production, {});
  assert.equal(config.postgres.host, 'postgres');
  assert.equal(config.production, true);
  assert.equal(productionPostgresProfile(config), true);
  assert.equal(configuration({ ...production, releaseGate: true }, {}).releaseGate, true);
  for (const changes of [
    { postgresProfile: 'local' },
    { postgresAllowedHosts: [] },
    { postgres: { ...connection, host: 'another-private-service' } },
    { postgres: { ...connection, host: '8.8.8.8' }, postgresAllowedHosts: ['8.8.8.8'] },
    { storageBackend: 'sqlite' },
    { origin: 'http://synthetic.test' },
  ])
    assert.throws(() => configuration({ ...production, ...changes }, {}));
  assert.throws(() => configuration({ storageBackend: 'postgres', postgres: connection }, {}));
  assert.equal(
    configuration(
      { storageBackend: 'postgres', postgres: { ...connection, host: '127.0.0.1' } },
      {},
    ).postgresProfile,
    'local',
  );
  assert.equal(productionPostgresProfile({ ...config, storageBackend: 'sqlite' }), false);
  assert.throws(() =>
    configuration({ storageBackend: 'sqlite' }, { CARTOTECA_POSTGRES_PROFILE: 'production-v1' }),
  );
  assert.throws(() =>
    connectionSettings('postgres://user:password@postgres/synthetic?sslmode=disable', {
      profile: 'production-v1',
      allowedHosts: ['postgres'],
    }),
  );
});

test('production DNS admission checks every answer and pins the private numeric address before pg connects', async () => {
  let calls = 0;
  const lookup = async (host, options) => {
    calls++;
    assert.equal(host, 'postgres');
    assert.equal(options.all, true);
    return [
      { address: '172.30.42.2', family: 4 },
      { address: 'fd30:ca47:42::2', family: 6 },
    ];
  };
  const admitted = await serverConnection(connection, {
    profile: 'production-v1',
    allowedHosts: ['postgres'],
    lookup,
  });
  assert.equal(admitted.host, '172.30.42.2');
  assert.equal(calls, 1);
  const pin = { version: 1, host: connection.host, address: admitted.host };
  const transferred = configuration(
    JSON.parse(JSON.stringify({ ...production, postgresPin: pin })),
    {},
  );
  assert.equal(transferred.postgres.host, 'postgres');
  assert.deepEqual(transferred.postgresAllowedHosts, ['postgres']);
  const pinned = await serverConnection(transferred.postgres, {
    profile: transferred.postgresProfile,
    allowedHosts: transferred.postgresAllowedHosts,
    pin: transferred.postgresPin,
    lookup: () => {
      throw Error('Pinned address must not be resolved again');
    },
  });
  for (const invalid of [
    { ...pin, address: '8.8.8.8' },
    { ...pin, host: 'another-service' },
    { ...pin, version: 2 },
    { ...pin, unexpected: true },
  ])
    assert.throws(() => configuration({ ...production, postgresPin: invalid }, {}));
  assert.equal(pinned.host, admitted.host);
  for (const answers of [
    [],
    [{ address: '8.8.8.8', family: 4 }],
    [
      { address: '172.30.42.2', family: 4 },
      { address: '203.0.113.4', family: 4 },
    ],
    [{ address: '169.254.169.254', family: 4 }],
    [{ address: '::ffff:8.8.8.8', family: 6 }],
  ])
    await assert.rejects(
      serverConnection(connection, {
        profile: 'production-v1',
        allowedHosts: ['postgres'],
        lookup: async () => answers,
      }),
    );
  for (const value of ['127.0.0.1', '10.0.1.2', '172.16.1.2', '192.168.1.2', '::1', 'fd30::2'])
    assert.equal(privateAddress(value), true, value);
  for (const value of [
    '8.8.8.8',
    '0.0.0.0',
    '169.254.169.254',
    '100.64.0.1',
    '2001:4860:4860::8888',
  ])
    assert.equal(privateAddress(value), false, value);
});

test('file secrets are bounded regular files, preserve intentional spaces and cannot silently compete with direct credentials', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-pg-profile123-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^cartoteca-pg-profile123-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, 'password');
  fs.writeFileSync(file, ' synthetic-file-password \n', { mode: 0o600 });
  assert.equal(secretFile(file), ' synthetic-file-password ');
  assert.throws(() =>
    secretValue(
      { CARTOTECA_PG_PASSWORD_FILE: file, CARTOTECA_PG_PASSWORD: 'must-not-win' },
      'CARTOTECA_PG_PASSWORD',
    ),
  );
  const environment = {
    NODE_ENV: 'production',
    APP_ORIGIN: 'https://synthetic.test',
    CARTOTECA_STORAGE_BACKEND: 'postgres',
    CARTOTECA_POSTGRES_PROFILE: 'production-v1',
    CARTOTECA_PG_ALLOWED_HOSTS: '127.0.0.1',
    CARTOTECA_PG_HOST: '127.0.0.1',
    CARTOTECA_PG_DATABASE: 'synthetic',
    CARTOTECA_PG_USER: 'cartoteca_app',
    CARTOTECA_PG_PASSWORD_FILE: file,
  };
  assert.equal(configuration({}, environment).postgres.password, ' synthetic-file-password ');
  assert.throws(
    () =>
      configuration(
        {},
        {
          ...environment,
          CARTOTECA_PG_PASSWORD_FILE: undefined,
          CARTOTECA_PG_PASSWORD: 'raw-production-secret',
        },
      ),
    /secret file/,
  );
  assert.equal(
    configuration(
      {
        ...production,
        postgres: { ...connection, host: '127.0.0.1' },
        postgresAllowedHosts: ['127.0.0.1'],
      },
      { ...environment, CARTOTECA_PG_PASSWORD: 'unused-direct' },
    ).postgres.password,
    connection.password,
  );
  assert.equal(
    configuration({ storageBackend: 'sqlite' }, { CARTOTECA_PG_PASSWORD: 'unused-direct' })
      .storageBackend,
    'sqlite',
  );
  assert.equal(
    (await operatorServerConnection(undefined, environment)).password,
    ' synthetic-file-password ',
  );
  await assert.rejects(
    operatorServerConnection(undefined, {
      ...environment,
      CARTOTECA_PG_PASSWORD_FILE: undefined,
      CARTOTECA_PG_PASSWORD: 'raw-production-secret',
    }),
    /secret file/,
  );
  await assert.rejects(
    operatorServerConnection(undefined, {
      ...environment,
      CARTOTECA_POSTGRES_URL: 'postgres://user:password@127.0.0.1/synthetic',
    }),
    /secret file/,
  );
  assert.equal(
    (
      await operatorServerConnection(
        { ...connection, host: '127.0.0.1' },
        { ...environment, CARTOTECA_POSTGRES_URL: 'unused-direct' },
      )
    ).password,
    connection.password,
  );
  for (const text of ['', 'x'.repeat(4097), 'one\ntwo', 'one\0two']) {
    fs.writeFileSync(file, text);
    assert.throws(() => secretFile(file));
  }
  assert.throws(() => secretFile(directory));
});

test('production factory derives only registered technical flags and preserves configured providers and manual-save policy', async () => {
  let received;
  const sentinel = new EventEmitter();
  let closeState = 'open',
    released = 0;
  sentinel.close = (callback) => {
    closeState = 'closed';
    sentinel.emit('close');
    callback?.();
  };
  sentinel.isolationStatus = () => ({ closeState });
  const authority = {
    state: 'held',
    release: async () => {
      released = 1;
    },
  };
  const options = {
    ...production,
    maxEnabled: true,
    pushEnabled: true,
    paymentNetworkEnabled: false,
    assistantAppointmentSavingEnabled: false,
    telegramBot: { synthetic: true },
    supportDelivery: { email: { synthetic: true } },
  };
  const result = await createPostgresServer(options, {
    environment: {},
    acquireAuthority: async () => authority,
    prepare: async (config) => ({
      ...config,
      notificationSchema: 19,
      assistantStateBackend: 'rows-v1',
      isolatedReadBudgets: true,
      sharedCabinetWrites: true,
      readBudgetVersion: 1,
    }),
    createServer: async (config) => {
      received = config;
      return sentinel;
    },
  });
  assert.equal(result, sentinel);
  assert.equal(received.maxEnabled, true);
  assert.equal(received.pushEnabled, true);
  assert.equal(received.paymentNetworkEnabled, false);
  assert.equal(received.assistantAppointmentSavingEnabled, false);
  assert.deepEqual(received.telegramBot, options.telegramBot);
  assert.deepEqual(received.supportDelivery, options.supportDelivery);
  assert.equal(received.assistantStateBackend, 'rows-v1');
  assert.equal(received.readBudgetVersion, 1);
  await new Promise((resolve, reject) =>
    sentinel.close((error) => (error ? reject(error) : resolve())),
  );
  assert.equal(released, 1);
  await assert.rejects(
    createPostgresServer(
      { storageBackend: 'sqlite' },
      {
        environment: {},
        prepare: () => {
          throw Error('SQLite must never reach PG preparation');
        },
      },
    ),
  );
});

test('native production guard rejects SQLite/local-profile bypass before spawning any owner', async () => {
  const { startNativeApplication } = require('../src/server/infrastructure/native-application.cjs');
  let spawned = 0;
  const spawn = () => {
    spawned++;
    throw Error('Synthetic spawn stop');
  };
  for (const config of [
    { production: true, storageBackend: 'sqlite' },
    { ...production, postgresProfile: 'local' },
    { ...production, releaseGate: true, postgresAllowedHosts: [] },
  ])
    await assert.rejects(startNativeApplication({ config, spawn }), /local profile/);
  assert.equal(spawned, 0);
  await assert.rejects(
    startNativeApplication({ config: configuration(production, {}), spawn }),
    /unavailable/,
  );
  assert.equal(spawned, 1, 'only the validated PG server profile can reach owner startup');
});

test('production lifetime authority remains held when native shutdown cannot prove executor exit', async () => {
  const server = new EventEmitter();
  let released = 0;
  server.isolationStatus = () => ({ closeState: 'failed' });
  server.close = (callback) => {
    server.emit('close');
    callback(
      Object.assign(Error('Synthetic unconfirmed close'), { code: 'NATIVE_SHUTDOWN_FAILED' }),
    );
  };
  const value = await createPostgresServer(production, {
    environment: {},
    prepare: async (config) => config,
    createServer: async () => server,
    acquireAuthority: async () => ({
      state: 'held',
      release: async () => {
        released++;
      },
    }),
  });
  await assert.rejects(
    new Promise((resolve, reject) => value.close((error) => (error ? reject(error) : resolve()))),
    { code: 'NATIVE_SHUTDOWN_FAILED' },
  );
  assert.equal(released, 0, 'an unconfirmed executor must not make a second gateway admissible');
});

test('release gate is normalized from env before fan-out and explicit configuration stays boolean', () => {
  assert.equal(configuration({}, { CARTOTECA_RELEASE_GATE: '1' }).releaseGate, true);
  assert.equal(
    configuration({ releaseGate: undefined }, { CARTOTECA_RELEASE_GATE: '1' }).releaseGate,
    true,
  );
  assert.equal(configuration({ releaseGate: true }, {}).releaseGate, true);
  assert.equal(
    configuration({ releaseGate: false }, { CARTOTECA_RELEASE_GATE: '1' }).releaseGate,
    false,
    'explicit boolean retains the established max-startup override contract',
  );
  assert.equal(configuration({}, {}).releaseGate, false);
  assert.throws(() => configuration({ releaseGate: '1' }, {}), /release gate/);
  const transferred = JSON.parse(
    JSON.stringify(configuration(production, { CARTOTECA_RELEASE_GATE: '1' })),
  );
  assert.equal(
    configuration(transferred, {}).releaseGate,
    true,
    'private IPC cannot lose the resolved env gate',
  );
});

test('production factory preserves the normalized explicit gate across technical profile preparation', async () => {
  const server = new EventEmitter();
  let closeState = 'open',
    received;
  server.isolationStatus = () => ({ closeState });
  server.close = (callback) => {
    closeState = 'closed';
    server.emit('close');
    callback?.();
  };
  await createPostgresServer(
    { ...production, releaseGate: true },
    {
      environment: {},
      prepare: async (config) => ({ ...config, releaseGate: false }),
      acquireAuthority: async () => ({ state: 'held', release: async () => {} }),
      createServer: async (config) => {
        received = config;
        return server;
      },
    },
  );
  assert.equal(
    received.releaseGate,
    true,
    'technical metadata cannot clear the already resolved maintenance gate',
  );
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
