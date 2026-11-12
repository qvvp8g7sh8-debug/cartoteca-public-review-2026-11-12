const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { backupConfiguration } = require('../src/server/infrastructure/backup/agent-config.cjs');
const {
  createBackupKey,
  createV2Backup,
  restoreV2Backup,
  recoverUpgradeCopy,
} = require('../src/server/infrastructure/backup/service.cjs');
const native = require('../src/server/infrastructure/postgres/backup-service.cjs');
const {
  applicationRole,
  localConnection,
} = require('../src/server/infrastructure/postgres/connection.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-pg-backup-wiring-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('cartoteca-pg-backup-wiring-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const env = {
    CARTOTECA_DATA_DIR: path.join(root, 'data'),
    BACKUP_DIR: path.join(root, 'archives'),
    BACKUP_KEY_FILE: path.join(root, 'keys', 'backup.key'),
    BACKUP_STATE_DIR: path.join(root, 'state'),
    BACKUP_WORK_DIR: path.join(root, 'work'),
    BACKUP_STATUS_FILE: path.join(root, 'status', 'status.json'),
    CARTOTECA_BACKUP_POSTGRES_URL:
      'postgresql://synthetic_owner:synthetic-password@127.0.0.1:5432/synthetic_first',
    BACKUP_POSTGRES_APPLICATION_ROLE: 'synthetic_app',
  };
  fs.mkdirSync(env.CARTOTECA_DATA_DIR);
  createBackupKey(env.BACKUP_KEY_FILE);
  const platformStoreId = randomUUID(),
    rootCabinetStoreId = randomUUID(),
    profile = {
      version: 1,
      backend: 'postgres',
      migrationId: randomUUID(),
      notificationSchema: 11,
      cabinetSchema: 0,
      cabinetTemplates: { 1: 'a'.repeat(64), 2: 'b'.repeat(64) },
      platformStoreId,
      rootCabinetStoreId,
      budgetStoreId: null,
      stores: [
        {
          kind: 'platform',
          storeId: platformStoreId,
          organizationId: null,
          relativeDirectory: 'platform',
          schemaVersion: 11,
        },
        {
          kind: 'cabinet',
          storeId: rootCabinetStoreId,
          organizationId: null,
          relativeDirectory: '.',
          schemaVersion: 1,
        },
      ],
    };
  const marker = path.join(env.CARTOTECA_DATA_DIR, 'postgresql-runtime.json');
  fs.writeFileSync(marker, JSON.stringify(profile), { flag: 'wx' });
  return { root, env, profile, marker };
}
test('native backup destination identity follows SQL database and asset lineage, never the operator password', (t) => {
  const f = fixture(t),
    current = backupConfiguration(f.env);
  assert.equal(current.applicationRole, 'synthetic_app');
  assert.deepEqual(current.postgresIdentity, [f.profile.migrationId, f.profile.platformStoreId]);
  const changedPassword = backupConfiguration({
    ...f.env,
    CARTOTECA_BACKUP_POSTGRES_URL: f.env.CARTOTECA_BACKUP_POSTGRES_URL.replace(
      'synthetic-password',
      'another-private-password',
    ),
  });
  assert.equal(changedPassword.destinationId, current.destinationId);
  assert.notEqual(
    backupConfiguration({
      ...f.env,
      CARTOTECA_BACKUP_POSTGRES_URL: f.env.CARTOTECA_BACKUP_POSTGRES_URL.replace(
        'synthetic_first',
        'synthetic_second',
      ),
    }).destinationId,
    current.destinationId,
  );
  fs.writeFileSync(f.marker, JSON.stringify({ ...f.profile, migrationId: randomUUID() }));
  assert.notEqual(backupConfiguration(f.env).destinationId, current.destinationId);
  assert.throws(
    () => backupConfiguration({ ...f.env, BACKUP_POSTGRES_APPLICATION_ROLE: 'invalid;role' }),
    /application role/,
  );
  assert.equal(applicationRole(undefined, { CARTOTECA_PG_USER: 'fallback_app' }), 'fallback_app');
  assert.equal(applicationRole('explicit_app', f.env), 'explicit_app');
});

test('server backup configuration keeps explicit private host admission and FILE credentials without a loopback fallback', (t) => {
  const f = fixture(t),
    secret = path.join(f.root, 'operator-password');
  fs.writeFileSync(secret, 'synthetic-private-password\n');
  const environment = {
    ...f.env,
    CARTOTECA_BACKUP_POSTGRES_URL: undefined,
    CARTOTECA_POSTGRES_PROFILE: 'production-v1',
    CARTOTECA_PG_ALLOWED_HOSTS: 'postgres',
    CARTOTECA_PG_HOST: 'postgres',
    CARTOTECA_PG_PORT: '5432',
    CARTOTECA_PG_DATABASE: 'synthetic_first',
    CARTOTECA_PG_USER: 'synthetic_owner',
    CARTOTECA_PG_PASSWORD_FILE: secret,
  };
  const config = backupConfiguration(environment);
  assert.equal(config.connection.host, 'postgres');
  assert.equal(config.connection.password, 'synthetic-private-password');
  assert.deepEqual(config.connectionOptions, {
    profile: 'production-v1',
    allowedHosts: ['postgres'],
  });
  assert.throws(() => backupConfiguration({ ...environment, CARTOTECA_PG_ALLOWED_HOSTS: 'other' }));
  assert.throws(() => backupConfiguration({ ...environment, CARTOTECA_PG_PASSWORD: 'raw-secret' }));
  assert.throws(
    () => backupConfiguration({ ...environment, CARTOTECA_STORAGE_BACKEND: 'sqlite' }),
    /BACKUP_CONFIGURATION/,
  );
  fs.renameSync(f.marker, f.marker + '.synthetic-hold');
  assert.throws(
    () => backupConfiguration({ ...environment, CARTOTECA_STORAGE_BACKEND: 'postgres' }),
    /BACKUP_CONFIGURATION/,
  );
});

test('backup and capacity reject lost PostgreSQL lineage or a foreign SQLite backend before opening either database', async (t) => {
  const f = fixture(t),
    config = backupConfiguration(f.env);
  const {
    checkCapacity,
    checkCapacityForBackend,
  } = require('../src/server/infrastructure/backup/capacity.cjs');
  let nativeCalls = 0,
    capacityCalls = 0;
  t.mock.method(native, 'createPostgresBackup', async () => {
    nativeCalls++;
    throw Error('Native database must not open.');
  });
  t.mock.method(native, 'estimatePostgresBytes', async () => {
    nativeCalls++;
    throw Error('Native database must not open.');
  });
  const statfs = () => {
    capacityCalls++;
    throw Error('Capacity must not scan a foreign backend.');
  };
  for (const storageBackend of ['sqlite', 'unknown']) {
    const mismatch = { ...config, storageBackend };
    await assert.rejects(createV2Backup(mismatch), /BACKUP_CONFIGURATION/);
    assert.throws(() => checkCapacity(mismatch, statfs), /BACKUP_CONFIGURATION/);
    await assert.rejects(checkCapacityForBackend(mismatch, statfs), /BACKUP_CONFIGURATION/);
  }
  // Configuration was obtained successfully before the asset marker disappeared.
  fs.renameSync(f.marker, f.marker + '.synthetic-hold');
  await assert.rejects(createV2Backup(config), /BACKUP_CONFIGURATION/);
  assert.throws(() => checkCapacity(config, statfs), /BACKUP_CONFIGURATION/);
  await assert.rejects(checkCapacityForBackend(config, statfs), /BACKUP_CONFIGURATION/);
  assert.equal(nativeCalls, 0);
  assert.equal(capacityCalls, 0);
  assert.equal(fs.existsSync(path.join(config.source, 'platform', 'platform.sqlite')), false);
  assert.equal(fs.existsSync(path.join(config.source, 'cabinet.sqlite')), false);
});
test('common backup dispatch validates and propagates the configured native application role for create, restore and upgrade copy', async (t) => {
  const f = fixture(t),
    config = backupConfiguration(f.env),
    archive = path.join(f.root, 'native.enc');
  fs.writeFileSync(archive, 'CARTOPG1', { flag: 'wx' });
  t.mock.method(native, 'createPostgresBackup', async (options) => options);
  t.mock.method(
    native,
    'restorePostgresBackup',
    async (file, key, destination, options) => options,
  );
  const previous = process.env.BACKUP_POSTGRES_APPLICATION_ROLE;
  process.env.BACKUP_POSTGRES_APPLICATION_ROLE = 'configured_app';
  t.after(() => {
    if (previous === undefined) delete process.env.BACKUP_POSTGRES_APPLICATION_ROLE;
    else process.env.BACKUP_POSTGRES_APPLICATION_ROLE = previous;
  });
  const created = await createV2Backup({
    source: config.source,
    directory: config.directory,
    keyFile: config.keyFile,
    connection: config.connection,
  });
  assert.equal(created.applicationRole, 'configured_app');
  const restored = await restoreV2Backup(archive, config.keyFile, path.join(f.root, 'restored'), {
    connection: config.connection,
    offline: true,
  });
  assert.equal(restored.applicationRole, 'configured_app');
  const upgraded = await recoverUpgradeCopy(archive, config.keyFile, path.join(f.root, 'upgrade'), {
    connection: config.connection,
    offline: true,
    applicationRole: 'explicit_app',
  });
  assert.equal(upgraded.applicationRole, 'explicit_app');
  assert.equal(upgraded.upgradeCopy, true);
  await assert.rejects(
    createV2Backup({
      source: config.source,
      connection: config.connection,
      applicationRole: 'invalid;role',
    }),
    /application role/,
  );
  await assert.rejects(
    restoreV2Backup(archive, config.keyFile, path.join(f.root, 'bad'), {
      connection: config.connection,
      applicationRole: 'invalid;role',
    }),
    /application role/,
  );
});

test('local PostgreSQL operator URLs reject remote routing, options and fragments', () => {
  for (const url of [
    'postgresql://owner:synthetic@outside.example.test:5432/synthetic',
    'postgresql://owner:synthetic@127.0.0.1:5432/synthetic?host=outside.example.test',
    'postgresql://owner:synthetic@127.0.0.1:5432/synthetic?options=-csearch_path%3Dpublic',
    'postgresql://owner:synthetic@127.0.0.1:5432/synthetic#fragment',
  ])
    assert.throws(() => localConnection(url), /local PostgreSQL|operator connection/);
  assert.equal(
    localConnection('postgresql://owner:synthetic@127.0.0.1:5432/synthetic').host,
    '127.0.0.1',
  );
});

test('both restore APIs reject missing and malformed archives through Promise without publishing a destination', async (t) => {
  const f = fixture(t),
    missing = path.join(f.root, 'absent.enc'),
    malformed = path.join(f.root, 'malformed.enc');
  fs.writeFileSync(malformed, 'CARTOBK3malformed', { flag: 'wx' });
  for (const [name, restore] of [
    ['restore', restoreV2Backup],
    ['upgrade', recoverUpgradeCopy],
  ])
    for (const [kind, archive] of [
      ['missing', missing],
      ['malformed', malformed],
    ]) {
      const destination = path.join(f.root, name + '-' + kind);
      let result;
      assert.doesNotThrow(() => {
        result = restore(archive, f.env.BACKUP_KEY_FILE, destination);
      });
      assert.ok(result instanceof Promise);
      await assert.rejects(result);
      assert.equal(fs.existsSync(destination), false);
    }
  assert.equal(
    fs.readdirSync(f.root).some((name) => name.startsWith('.cartoteca-v2-')),
    false,
  );
});

test('unknown preparation markers reject before format inspection for SQLite, PostgreSQL and missing archives', async (t) => {
  const f = fixture(t),
    sources = [
      path.join(f.root, 'sqlite.enc'),
      path.join(f.root, 'postgres.enc'),
      path.join(f.root, 'missing.enc'),
    ];
  fs.writeFileSync(sources[0], 'CARTOBK3', { flag: 'wx' });
  fs.writeFileSync(sources[1], 'CARTOPG1', { flag: 'wx' });
  const original = fs.lstatSync;
  let inspections = 0;
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    if (sources.includes(path.resolve(String(file)))) {
      inspections++;
      throw Error('Archive inspected before marker validation.');
    }
    return original(file, ...args);
  });
  const destination = path.join(f.root, 'must-not-appear');
  for (const source of sources)
    for (const preparationMarker of [null, false, '', '2', 'unknown-preparation', {}]) {
      const result = recoverUpgradeCopy(source, f.env.BACKUP_KEY_FILE, destination, {
        preparationMarker,
      });
      assert.ok(result instanceof Promise);
      await assert.rejects(result, /Unsupported offline preparation marker/);
    }
  assert.equal(inspections, 0);
  assert.equal(fs.existsSync(destination), false);
});
