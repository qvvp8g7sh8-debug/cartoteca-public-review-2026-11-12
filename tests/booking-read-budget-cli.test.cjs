const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createStorage } = require('../storage.cjs');
const { createPlatformStore } = require('../platform-store.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { createBackupKey } = require('../src/server/infrastructure/backup/service.cjs');
const budgetStore = require('../src/server/infrastructure/booking-read-budget-store.cjs');
const cli = path.resolve(__dirname, '../scripts/prepare-booking-read-budget.cjs');
const now = 1900000000000;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-read-budget-cli-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('cartoteca-read-budget-cli-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const source = path.join(root, 'source');
  const platformDir = path.join(source, 'platform');
  createStorage(source).close();
  createPlatformStore(platformDir).close();
  const db = createPlatformDatabase(platformDir);
  try {
    require('../src/server/migrations/012-max-connections.cjs').migrateMaxConnections(
      db,
      platformDir,
    );
    require('../src/server/migrations/013-notification-queue.cjs').migrateNotificationQueue(
      db,
      platformDir,
    );
    require('../src/server/migrations/014-notification-channels.cjs').migrateNotificationChannels(
      db,
      platformDir,
    );
    require('../src/server/migrations/015-max-inbox.cjs').migrateMaxInbox(db, platformDir);
    require('../src/server/migrations/016-staff-max.cjs').migrateStaffMax(db, platformDir);
    require('../src/server/migrations/017-staff-push.cjs').migrateStaffPush(db, platformDir);
  } finally {
    db.closeWriter();
    db.db.close();
  }
  const platform = createPlatformStore(platformDir, { notificationSchema: 17 });
  try {
    platform.bookingPublicLimits.consume('read', '', 'synthetic-client', '', now);
    platform.bookingPublicLimits.consume(
      'submit',
      'synthetic-org',
      'synthetic-client',
      '+79990000000',
      now,
    );
  } finally {
    platform.close();
  }
  const keyFile = path.join(root, 'keys', 'synthetic-backup.key');
  createBackupKey(keyFile);
  return { root, source, keyFile, directory: path.join(root, 'archives') };
}

function argumentsFor(f, destination, rollback = false) {
  return [
    '--source',
    f.source,
    '--destination',
    destination,
    '--backups',
    f.directory,
    '--key',
    f.keyFile,
    '--offline',
    ...(rollback ? ['--rollback'] : []),
  ];
}

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

function fingerprint(directory) {
  const result = {};
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (!/-(wal|shm)$/.test(entry.name))
        result[path.relative(directory, file)] = createHash('sha256')
          .update(fs.readFileSync(file))
          .digest('hex');
    }
  }
  visit(directory);
  return result;
}

function inspect(directory, isolated = false) {
  const platform = new DatabaseSync(path.join(directory, 'platform/platform.sqlite'), {
    readOnly: true,
  });
  let budget;
  try {
    const registration = budgetStore.assertMode(
      platform,
      path.join(directory, 'platform'),
      isolated,
    );
    budget = isolated
      ? new DatabaseSync(path.join(directory, 'platform', budgetStore.filename), { readOnly: true })
      : platform;
    return {
      schema: platform.prepare('PRAGMA user_version').get().user_version,
      mode: registration?.mode || 'legacy',
      reads: budget
        .prepare('SELECT * FROM login_limits WHERE ' + budgetStore.readWhere + ' ORDER BY key')
        .all(),
      writes: platform
        .prepare(
          'SELECT * FROM login_limits WHERE NOT (' + budgetStore.readWhere + ') ORDER BY key',
        )
        .all(),
    };
  } finally {
    if (budget && budget !== platform) budget.close();
    platform.close();
  }
}

function assertReport(result, f, mode) {
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(
    Object.keys(report).sort(),
    [
      'componentVersion',
      'mode',
      'countersPreserved',
      'sourceUnchanged',
      'beforeArchive',
      'preparedArchive',
      'requiresStoppedSourceBeforeSwitch',
      'enabledByDefault',
    ].sort(),
  );
  assert.equal(report.componentVersion, 1);
  assert.equal(report.mode, mode);
  assert.equal(report.countersPreserved, 2);
  assert.equal(report.sourceUnchanged, true);
  assert.equal(report.requiresStoppedSourceBeforeSwitch, true);
  assert.equal(report.enabledByDefault, false);
  assert.notEqual(report.beforeArchive, report.preparedArchive);
  for (const archive of [report.beforeArchive, report.preparedArchive]) {
    assert.equal(path.dirname(archive), f.directory);
    assert.match(path.basename(archive), /^cartoteca-v2-.*\.enc$/);
    assert.ok(fs.statSync(archive).isFile());
  }
  return report;
}

test('CLI prepares schema17 forward and rollback copies with latest limits, archives and unchanged source', (t) => {
  const f = fixture(t);
  const before = inspect(f.source);
  const sourceFiles = fingerprint(f.source);
  const destination = path.join(f.root, 'isolated-copy');
  assertReport(run(argumentsFor(f, destination)), f, 'isolated');
  assert.deepEqual(fingerprint(f.source), sourceFiles);
  assert.deepEqual(inspect(f.source), before);
  assert.equal(fs.existsSync(path.join(destination, '.restore-in-progress')), false);
  const isolated = inspect(destination, true);
  assert.equal(isolated.schema, 17);
  assert.deepEqual(isolated.reads, before.reads);
  assert.deepEqual(isolated.writes, before.writes);

  const current = createPlatformStore(path.join(destination, 'platform'), {
    notificationSchema: 17,
    sharedCabinetWrites: true,
    isolatedReadBudgets: true,
  });
  try {
    current.bookingPublicLimits.consume('read', '', 'synthetic-client', '', now + 1000);
  } finally {
    current.close();
  }
  const updated = inspect(destination, true);
  assert.ok(updated.reads.every((row) => row.failures === 2));
  const isolatedFiles = fingerprint(destination);
  const rollback = path.join(f.root, 'legacy-copy');
  assertReport(run(argumentsFor({ ...f, source: destination }, rollback, true)), f, 'legacy');
  assert.deepEqual(fingerprint(destination), isolatedFiles);
  assert.equal(fs.existsSync(path.join(rollback, '.restore-in-progress')), false);
  const restored = inspect(rollback);
  assert.equal(restored.schema, 17);
  assert.deepEqual(restored.reads, updated.reads);
  assert.deepEqual(restored.writes, before.writes);
});

test('CLI rejects incomplete or unknown arguments before accessing any supplied path', (t) => {
  const f = fixture(t),
    destination = path.join(f.root, 'invalid-copy');
  const valid = argumentsFor(f, destination);
  for (const args of [
    [],
    valid.slice(0, -1),
    [...valid, '--unknown'],
    [...valid, '--rollback', '--extra'],
    valid.map((value, index) => (index === 1 ? '' : value)),
    valid.map((value, index) => (index === 3 ? '--unknown' : value)),
  ]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Usage: /);
    assert.equal(result.stderr.includes(f.root), false);
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.existsSync(f.directory), false);
  }
});

test('CLI failure is sanitized, retains incomplete marker and never changes its stopped source', (t) => {
  const f = fixture(t),
    destination = path.join(f.root, 'failed-copy');
  const before = fingerprint(f.source);
  const result = run(argumentsFor(f, destination, true));
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr.trim(),
    'Read-budget preparation failed. Original retained; do not activate incomplete copy.',
  );
  assert.deepEqual(fingerprint(f.source), before);
  assert.equal(
    fs.readFileSync(path.join(destination, '.restore-in-progress'), 'utf8'),
    'booking-read-budget-preparation-v1',
  );
  assert.equal(fs.existsSync(path.join(f.source, '.restore-in-progress')), false);
  assert.equal(fs.readdirSync(f.directory).filter((name) => name.endsWith('.enc')).length, 1);
  assert.equal(run(argumentsFor(f, destination)).status, 1);
});

test('runtime image ships the read-budget preparation CLI alongside its source dependency', () => {
  const dockerfile = fs.readFileSync(path.resolve(__dirname, '../Dockerfile'), 'utf8');
  assert.match(dockerfile, /^COPY src\/server \.\/src\/server$/m);
  assert.match(dockerfile, /^COPY src\/shared \.\/src\/shared$/m);
  assert.doesNotMatch(dockerfile, /^COPY src \.\/src$/m);
  assert.ok(
    dockerfile
      .split('\n')
      .some(
        (line) =>
          line.startsWith('COPY ') &&
          line.split(/\s+/).includes('scripts/prepare-booking-read-budget.cjs') &&
          line.trim().endsWith('./scripts/'),
      ),
  );
});
