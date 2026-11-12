const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { installProfile } = require('./helpers/postgres-profile123.cjs');
const { backupProfile } = require('../src/server/infrastructure/postgres/backup-profile.cjs');
const { publicStatus } = require('../src/server/infrastructure/backup/agent.cjs');
const { readBackupStatus } = require('../src/server/infrastructure/backup/status.cjs');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-pg-status123-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const config = {
    source: path.join(directory, 'assets'),
    statusFile: path.join(directory, 'status.json'),
    cadenceHours: 24,
    remote: {},
  };
  const installed = installProfile(config),
    archive = path.join(directory, 'synthetic.enc');
  fs.writeFileSync(archive, 'synthetic-status-reference');
  const now = Date.now();
  const status = publicStatus(config, [
    {
      state: 'protected',
      started: now,
      finished: now,
      detail: { file: archive, localAt: now, remoteAt: now, drillAt: now },
    },
  ]);
  fs.writeFileSync(config.statusFile, JSON.stringify(status));
  const runtime = {
    storageBackend: 'postgres',
    dataDir: config.source,
    postgres: {
      host: 'postgres',
      port: 5432,
      database: 'synthetic',
      user: 'synthetic_app',
      password: 'other-app-password',
    },
    postgresPin: { version: 1, host: 'postgres', address: '127.0.0.1' },
  };
  return { directory, config, runtime, status, ...installed };
}
test('operator pinned endpoint and runtime logical host bind the same database/assets/application role without hashing secrets', (t) => {
  const f = fixture(t);
  assert.deepEqual(backupProfile(f.config), backupProfile(f.runtime));
  assert.deepEqual(
    backupProfile({
      ...f.config,
      connection: { ...f.config.connection, password: 'changed-private-password' },
    }),
    backupProfile(f.config),
  );
  const status = readBackupStatus(f.config.statusFile, f.runtime);
  assert.equal(status.health, 'protected');
  assert.equal(status.state, 'protected');
  assert.equal(Object.hasOwn(status, 'postgresProfile'), false);
  for (const secret of [
    f.marker.migrationId,
    f.marker.platformStoreId,
    backupProfile(f.config).identity,
    'private-password',
  ])
    assert.equal(JSON.stringify(status).includes(secret), false);
  assert.equal(
    readBackupStatus(f.config.statusFile).health,
    'unavailable',
    'unscoped readers cannot trust a native receipt',
  );
});
test('independent PostgreSQL status configuration needs no archive key or application env file', (t) => {
  const f = fixture(t),
    passwordFile = path.join(f.directory, 'synthetic-owner-secret');
  fs.writeFileSync(passwordFile, 'synthetic-operator-password\n');
  const config =
    require('../src/server/infrastructure/backup/agent-config.cjs').backupStatusConfiguration({
      CARTOTECA_DATA_DIR: f.config.source,
      BACKUP_STATUS_FILE: f.config.statusFile,
      CARTOTECA_POSTGRES_PROFILE: 'local',
      CARTOTECA_PG_HOST: '127.0.0.1',
      CARTOTECA_PG_PORT: '5432',
      CARTOTECA_PG_DATABASE: 'synthetic',
      CARTOTECA_PG_USER: 'synthetic_owner',
      CARTOTECA_PG_PASSWORD_FILE: passwordFile,
      BACKUP_POSTGRES_APPLICATION_ROLE: 'synthetic_app',
    });
  assert.equal(Object.hasOwn(config, 'keyFile'), false);
  assert.equal(Object.hasOwn(config, 'directory'), false);
  assert.deepEqual(backupProfile(config), backupProfile(f.runtime));
});
test('retained status fails closed for a different database, role, endpoint, changed lineage or missing assets', (t) => {
  const f = fixture(t);
  for (const change of [
    { postgres: { ...f.runtime.postgres, database: 'foreign_database' } },
    { postgres: { ...f.runtime.postgres, user: 'foreign_app' } },
    { postgresPin: { ...f.runtime.postgresPin, address: '127.0.0.2' } },
  ])
    assert.equal(
      readBackupStatus(f.config.statusFile, { ...f.runtime, ...change }).health,
      'unavailable',
    );
  // Refreshing the JSON timestamp cannot make a foreign recovery point current.
  fs.writeFileSync(
    f.config.statusFile,
    JSON.stringify({ ...f.status, observedAt: Date.now() + 1000 }),
  );
  fs.writeFileSync(f.filename, JSON.stringify({ ...f.marker, migrationId: randomUUID() }));
  assert.equal(readBackupStatus(f.config.statusFile, f.runtime).health, 'unavailable');
  fs.unlinkSync(f.filename);
  assert.equal(readBackupStatus(f.config.statusFile, f.runtime).health, 'unavailable');
});
test('a retained legacy SQLite status does not confirm a PostgreSQL recovery point while legacy shape remains unchanged', (t) => {
  const f = fixture(t),
    legacy = { ...f.status };
  delete legacy.postgresProfile;
  fs.writeFileSync(f.config.statusFile, JSON.stringify(legacy));
  assert.equal(readBackupStatus(f.config.statusFile, f.runtime).health, 'unavailable');
  assert.equal(readBackupStatus(f.config.statusFile).health, 'protected');
  assert.deepEqual(
    Object.keys(readBackupStatus(f.config.statusFile)).sort(),
    Object.keys(readBackupStatus(f.config.statusFile, { storageBackend: 'sqlite' })).sort(),
  );
});
