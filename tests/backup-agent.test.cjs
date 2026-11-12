const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { backupConfiguration } = require('../src/server/infrastructure/backup/agent-config.cjs');
const { createBackupJournal } = require('../src/server/infrastructure/backup/journal.cjs');
const { checkCapacity } = require('../src/server/infrastructure/backup/capacity.cjs');
const { atomicJson } = require('../src/server/infrastructure/backup/durable.cjs');
const { readBackupStatus } = require('../src/server/infrastructure/backup/status.cjs');
const { runBackup, publicStatus } = require('../src/server/infrastructure/backup/agent.cjs');
const {
  retentionPlan,
  applyRetention,
} = require('../src/server/infrastructure/backup/retention.cjs');
const { fingerprints } = require('../src/server/infrastructure/backup/s3-storage.cjs');
const { createBackupKey } = require('../src/server/infrastructure/backup/service.cjs');
const { adminFixture } = require('./helpers/admin-fixture.cjs');

function fixture(t, source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-backup-agent-'));
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^cartoteca-backup-agent-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const environment = {
    CARTOTECA_DATA_DIR: source || path.join(directory, 'data'),
    BACKUP_DIR: path.join(directory, 'archives'),
    BACKUP_KEY_FILE: path.join(directory, 'keys', 'backup.key'),
    BACKUP_STATE_DIR: path.join(directory, 'state'),
    BACKUP_WORK_DIR: path.join(directory, 'work'),
    BACKUP_STATUS_FILE: path.join(directory, 'status', 'status.json'),
  };
  fs.mkdirSync(environment.CARTOTECA_DATA_DIR, { recursive: true });
  createBackupKey(environment.BACKUP_KEY_FILE);
  const config = backupConfiguration(environment);
  return { directory, environment, config, cleanup: (fn) => cleanups.push(fn) };
}
function fakeWork(config, overrides = {}) {
  return {
    capacity: () => ({ availableBytes: 10000000000 }),
    create: async () => {
      fs.mkdirSync(config.directory, { recursive: true });
      const file = path.join(config.directory, 'cartoteca-v2-synthetic.enc');
      fs.writeFileSync(file, 'synthetic-encrypted-placeholder');
      return { file, verified: true, archiveBytes: 31, snapshotMilliseconds: 1 };
    },
    drill: async () => ({ restored: true }),
    ...overrides,
  };
}

test('native protection proof requires actual restored application startup and rejects a legacy or incomplete drill', async (t) => {
  for (const valid of [false, true]) {
    const { config } = fixture(t);
    require('./helpers/postgres-profile123.cjs').installProfile(config);
    const work = fakeWork(config);
    work.verifyProfile = async (value) => ({
      config: value,
      profile: require('../src/server/infrastructure/postgres/backup-profile.cjs').backupProfile(
        value,
      ),
    });
    const create = work.create;
    work.create = async () => ({ ...(await create()), backend: 'postgres' });
    work.drill = async () =>
      valid
        ? { backend: 'postgres', restored: true, started: true, notificationsPaused: true }
        : { restored: true };
    if (!valid) {
      await assert.rejects(runBackup(config, work), /BACKUP_DRILL_FAILED/);
      continue;
    }
    const result = await runBackup(config, work);
    assert.equal(result.backend, 'postgres');
    assert.equal(result.verified, true);
    assert.deepEqual(result.drill, {
      backend: 'postgres',
      restored: true,
      started: true,
      notificationsPaused: true,
    });
    assert.equal(result.state, 'local_only');
  }
});
test('backup configuration isolates data, key, archives, private state and public status; rejects partial or insecure S3', (t) => {
  const { config, environment } = fixture(t);
  assert.equal(config.remote, null);
  assert.throws(
    () => backupConfiguration({ ...environment, BACKUP_STATE_DIR: config.source }),
    /BACKUP_PATHS_OVERLAP/,
  );
  assert.throws(
    () => backupConfiguration({ ...environment, BACKUP_S3_ACCESS_KEY: 'synthetic' }),
    /BACKUP_S3_CONFIGURATION/,
  );
  const s3 = {
    BACKUP_S3_ENDPOINT: 'http://insecure.test',
    BACKUP_S3_REGION: 'synthetic-1',
    BACKUP_S3_BUCKET: 'synthetic-bucket',
    BACKUP_S3_ACCESS_KEY: 'synthetic',
    BACKUP_S3_SECRET_KEY: 'synthetic',
  };
  assert.throws(() => backupConfiguration({ ...environment, ...s3 }), /BACKUP_S3_CONFIGURATION/);
  const remote = backupConfiguration({
    ...environment,
    ...s3,
    BACKUP_S3_ENDPOINT: 'https://storage.test',
  });
  assert.notEqual(remote.destinationId, config.destinationId);
  fs.writeFileSync(config.keyFile, Buffer.alloc(32, 123));
  assert.notEqual(
    backupConfiguration(environment).destinationId,
    config.destinationId,
    'a changed archive key cannot reuse successful scheduled receipts',
  );
});
test('journal serializes separate connections, prevents expired owner from finishing, and records interruption', (t) => {
  const { config, cleanup } = fixture(t);
  let now = 1000;
  const first = createBackupJournal(config.stateDirectory, {
    clock: () => now,
    leaseMilliseconds: 100,
  });
  const second = createBackupJournal(config.stateDirectory, {
    clock: () => now,
    leaseMilliseconds: 100,
  });
  cleanup(() => {
    first.close();
    second.close();
  });
  first.begin(config.destinationId);
  assert.throws(() => second.begin(config.destinationId), /BACKUP_BUSY/);
  now += 101;
  second.begin(config.destinationId);
  assert.throws(() => first.heartbeat(), /BACKUP_LEASE_LOST/);
  assert.throws(() => first.update('protected', {}, true), /BACKUP_LEASE_LOST/);
  second.update('protected', {}, true);
  assert.deepEqual(
    second.rows(config.destinationId).map((row) => row.state),
    ['protected', 'interrupted'],
  );
});
test('completed scheduled slot is idempotent; a changed destination needs a new recovery point', (t) => {
  const { config, cleanup } = fixture(t),
    journal = createBackupJournal(config.stateDirectory);
  cleanup(() => journal.close());
  journal.begin(config.destinationId, 'daily:synthetic');
  journal.update('protected', {}, true);
  assert.equal(journal.begin(config.destinationId, 'daily:synthetic'), null);
  assert.ok(journal.begin('different-destination', 'daily:synthetic'));
  journal.update('failed', {}, true);
});
test('status reads at most thirteen jobs while preserving older recovery receipts and missing-file fallback', (t) => {
  const { config, cleanup } = fixture(t);
  const { DatabaseSync } = require('node:sqlite');
  const journal = createBackupJournal(config.stateDirectory);
  cleanup(() => journal.close());
  fs.mkdirSync(config.directory);
  const file = path.join(config.directory, 'cartoteca-v2-synthetic.enc');
  fs.writeFileSync(file, 'synthetic');
  const now = Date.now();
  const db = new DatabaseSync(path.join(config.stateDirectory, 'backup-journal.sqlite'));
  try {
    db.exec('BEGIN IMMEDIATE');
    const insert = db.prepare('INSERT INTO jobs VALUES(?,?,NULL,?,?,?,?)');
    insert.run(
      'older-recovery',
      config.destinationId,
      now - 2000,
      now - 1999,
      'protected',
      JSON.stringify({ file, localAt: now - 2000, remoteAt: now - 2000, drillAt: now - 2000 }),
    );
    insert.run(
      'missing-file',
      config.destinationId,
      now - 1900,
      now - 1899,
      'local_only',
      JSON.stringify({ file: file + '.missing', localAt: now - 1900 }),
    );
    for (let index = 0; index < 1500; index++)
      insert.run(
        'failed-' + index,
        config.destinationId,
        now - 1500 + index,
        now - 1500 + index,
        'failed',
        '{}',
      );
    insert.run(
      'different-destination',
      'other',
      now,
      now,
      'protected',
      JSON.stringify({
        file,
        localAt: now,
        remoteAt: now,
        drillAt: now,
      }),
    );
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  const all = journal.rows(config.destinationId);
  const bounded = journal.statusRows(config.destinationId);
  assert.equal(all.length, 1502);
  assert.equal(bounded.length, 11);
  const expected = publicStatus(config, all),
    actual = publicStatus(config, bounded);
  delete expected.observedAt;
  delete actual.observedAt;
  assert.deepEqual(actual, expected);
  assert.equal(actual.lastLocalAt, now - 2000);
  assert.equal(actual.recent.length, 10);
  assert.deepEqual(journal.statusRows('unknown'), []);
});
test('worker rejects relative directories and key paths instead of depending on its current directory', (t) => {
  const { environment } = fixture(t);
  for (const name of [
    'CARTOTECA_DATA_DIR',
    'BACKUP_DIR',
    'BACKUP_KEY_FILE',
    'BACKUP_STATE_DIR',
    'BACKUP_WORK_DIR',
    'BACKUP_STATUS_FILE',
  ])
    assert.throws(
      () => backupConfiguration({ ...environment, [name]: 'relative-path' }),
      /BACKUP_CONFIGURATION/,
    );
});
test('capacity fails before snapshot and preserves existing data', async (t) => {
  const { config } = fixture(t);
  fs.writeFileSync(path.join(config.source, 'synthetic.sqlite'), 'original');
  assert.throws(
    () => checkCapacity(config, () => ({ bavail: 1, bsize: 4096 })),
    /BACKUP_DISK_SPACE/,
  );
  assert.equal(fs.readFileSync(path.join(config.source, 'synthetic.sqlite'), 'utf8'), 'original');
  const result = checkCapacity(config, () => ({ bavail: 1024 ** 3, bsize: 4096 }));
  assert.equal(result.sourceBytes, 8);
});
test('status is bounded, strips all secret/clinical/path fields and rejects stale/future success', (t) => {
  const { config } = fixture(t),
    now = Date.now();
  const value = {
    format: 1,
    observedAt: now,
    cadenceHours: 24,
    remoteConfigured: true,
    state: 'protected',
    lastLocalAt: now,
    lastRemoteAt: now,
    lastDrillAt: now,
    keyFile: 'SECRET',
    clients: ['patient'],
    endpoint: 'https://secret.test',
    recent: [{ state: 'protected', startedAt: now, file: 'SECRET' }],
  };
  atomicJson(config.statusFile, value);
  const status = readBackupStatus(config.statusFile);
  assert.equal(status.health, 'protected');
  assert.doesNotMatch(JSON.stringify(status), /SECRET|patient|secret.test|keyFile|endpoint/);
  atomicJson(config.statusFile, { ...value, observedAt: now - 27 * 3600000 });
  assert.equal(readBackupStatus(config.statusFile).health, 'stale');
  atomicJson(config.statusFile, { ...value, lastRemoteAt: now + 86400000 });
  assert.equal(readBackupStatus(config.statusFile).health, 'incomplete');
  fs.writeFileSync(config.statusFile, 'x'.repeat(32769));
  assert.equal(readBackupStatus(config.statusFile).health, 'unavailable');
  assert.equal(readBackupStatus('').health, 'unconfigured');
});
test('local-only run does not claim independent protection; disk failure is journalled', async (t) => {
  const { config } = fixture(t);
  const result = await runBackup(config, fakeWork(config));
  assert.equal(result.state, 'local_only');
  assert.equal(readBackupStatus(config.statusFile).health, 'incomplete');
  assert.ok(readBackupStatus(config.statusFile).lastDrillAt);
  await assert.rejects(
    runBackup(
      config,
      fakeWork(config, {
        capacity: () => {
          throw Error('BACKUP_DISK_SPACE');
        },
      }),
    ),
    /BACKUP_DISK_SPACE/,
  );
  assert.equal(readBackupStatus(config.statusFile).error, 'BACKUP_DISK_SPACE');
});
test('upload or drill failures cannot publish protected; verified local archive is kept', async (t) => {
  const { config } = fixture(t);
  config.remote = { synthetic: true };
  await assert.rejects(
    runBackup(
      config,
      fakeWork(config, {
        remote: {
          upload: async () => {
            throw Error('BACKUP_REMOTE_CHECKSUM');
          },
        },
      }),
    ),
    /BACKUP_REMOTE_CHECKSUM/,
  );
  assert.equal(readBackupStatus(config.statusFile).health, 'failed');
  assert.equal(readBackupStatus(config.statusFile).lastRemoteAt, null);
  assert.equal(fs.readdirSync(config.directory).length, 1);
  await assert.rejects(
    runBackup(
      config,
      fakeWork(config, {
        remote: { upload: async () => ({ versionId: 'synthetic' }) },
        drill: async () => {
          throw Error('BACKUP_DRILL_FAILED');
        },
      }),
    ),
    /BACKUP_DRILL_FAILED/,
  );
  assert.equal(readBackupStatus(config.statusFile).health, 'failed');
});
test('real synthetic full backup restores and starts with outbound workers disabled without changing source', async (t) => {
  const platform = await adminFixture(t);
  const { config } = fixture(t, platform.directory);
  const before = platform.store.admin.overview(platform.admin.accountId);
  const result = await runBackup(config);
  assert.equal(result.state, 'local_only');
  assert.deepEqual(platform.store.admin.overview(platform.admin.accountId), before);
  assert.equal(fs.readdirSync(config.workDirectory).length, 0);
  assert.equal(readBackupStatus(config.statusFile).state, 'local_only');
  const journal = createBackupJournal(config.stateDirectory);
  assert.ok(journal.rows(config.destinationId)[0].detail.snapshotMilliseconds >= 0);
  journal.close();
});
test('prune is explicit, keeps newest three and unknown files; fresh remote verification required for each deletion', async (t) => {
  const { config } = fixture(t);
  fs.mkdirSync(config.directory);
  const now = Date.now(),
    rows = [];
  for (let index = 0; index < 5; index++) {
    const file = path.join(config.directory, 'cartoteca-v2-synthetic-' + index + '.enc');
    fs.writeFileSync(file, 'synthetic-' + index);
    const checksum = await fingerprints(file);
    rows.push({
      id: String(index),
      state: 'protected',
      finished: now - index,
      detail: {
        file,
        drillAt: now,
        remote: {
          ...checksum,
          versionId: 'v' + index,
          retainUntil: new Date(now + 30 * 86400000).toISOString(),
        },
      },
    });
  }
  const unknown = path.join(config.directory, 'cartoteca-v2-manual.enc');
  fs.writeFileSync(unknown, 'manual');
  assert.equal(retentionPlan(config, rows).length, 2);
  assert.throws(() => retentionPlan({ ...config, localCopies: 1 }, rows), /BACKUP_CONFIGURATION/);
  fs.renameSync(rows[0].detail.file, rows[0].detail.file + '.hidden');
  assert.equal(
    retentionPlan(config, rows).length,
    1,
    'missing local copy must not count toward three preserved archives',
  );
  fs.renameSync(rows[0].detail.file + '.hidden', rows[0].detail.file);
  fs.writeFileSync(rows[0].detail.file, 'damaged preserved copy');
  await assert.rejects(
    applyRetention(config, rows, { verify: async () => true }),
    /BACKUP_REMOTE_CHECKSUM/,
  );
  fs.writeFileSync(rows[0].detail.file, 'synthetic-0');
  await assert.rejects(
    applyRetention(config, rows, {
      verify: async (receipt) => {
        if (receipt.versionId === 'v3')
          fs.writeFileSync(rows[3].detail.file, 'changed during verification');
      },
    }),
    /BACKUP_REMOTE_CHECKSUM/,
  );
  fs.writeFileSync(rows[3].detail.file, 'synthetic-3');
  assert.equal(fs.readdirSync(config.directory).length, 6);
  await assert.rejects(
    applyRetention(config, rows, {
      verify: async () => {
        throw Error('BACKUP_REMOTE_FAILED');
      },
    }),
    /BACKUP_REMOTE_FAILED/,
  );
  assert.equal(fs.readdirSync(config.directory).length, 6);
  const verified = [];
  const removed = await applyRetention(config, rows, {
    verify: async (receipt) => verified.push(receipt.versionId),
  });
  assert.deepEqual(removed, ['3', '4']);
  assert.deepEqual(verified, ['v0', 'v3', 'v4']);
  assert.equal(fs.existsSync(unknown), true);
  assert.equal(fs.readdirSync(config.directory).length, 4);
  assert.equal(retentionPlan(config, rows, now + 27 * 3600000).length, 0);
});
