const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createPlatformStore } = require('../platform-store.cjs');
const {
  createBackupKey,
  createV2Backup,
  verifyV2Backup,
  restoreV2Backup,
} = require('../src/server/infrastructure/backup/service.cjs');
const {
  prepareBookingReadBudgetCopy,
} = require('../src/server/migrations/prepare-booking-read-budget.cjs');
const { restoreDrill } = require('../src/server/infrastructure/backup/drill.cjs');
const {
  extractArchive,
  writeArchive,
  digest,
} = require('../src/server/infrastructure/backup/archive.cjs');
const {
  dataInventory,
  inventoryFingerprint,
  componentFingerprint,
} = require('../src/server/infrastructure/backup/organization-inventory.cjs');
const store = require('../src/server/infrastructure/booking-read-budget-store.cjs');
const addressKey = 'booking-budget:read-address:synthetic',
  siteKey = 'booking-budget:site-read:synthetic';

function connection(root, name = 'platform.sqlite') {
  return new DatabaseSync(path.join(root, 'platform', name));
}
function counters(root, isolated = false) {
  const db = connection(root, isolated ? store.filename : 'platform.sqlite');
  try {
    return db
      .prepare(
        'SELECT key,failures,window_started,blocked_until FROM login_limits WHERE ' +
          store.readWhere +
          ' ORDER BY key',
      )
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-budget-backup-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^cartoteca-budget-backup-/);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const source = path.join(root, 'source'),
    directory = path.join(root, 'archives'),
    keyFile = path.join(root, 'backup.key');
  const platform = createPlatformStore(path.join(source, 'platform'));
  platform.close();
  createBackupKey(keyFile);
  const db = connection(source),
    now = Date.now();
  try {
    const put = db.prepare(
      'INSERT INTO login_limits(key,failures,window_started,blocked_until) VALUES(?,?,?,?)',
    );
    put.run(addressKey, 239, now, now + 60000);
    put.run(siteKey, 19999, now, now + 60000);
    put.run('synthetic-login-attempt', 2, now, now + 60000);
  } finally {
    db.close();
  }
  const options = { source, directory, keyFile };
  return {
    root,
    source,
    directory,
    keyFile,
    options,
    prepare: (destination, changes = {}) =>
      prepareBookingReadBudgetCopy({ ...options, destination, offline: true, ...changes }),
  };
}

test('ordinary disaster restore keeps read windows before migration and in isolated/rolled-back modes; drill starts correct mode', async (t) => {
  const f = fixture(t),
    expected = counters(f.source);
  const original = await createV2Backup(f.options),
    originalRestored = path.join(f.root, 'original-restored');
  await restoreV2Backup(original.file, f.keyFile, originalRestored);
  assert.deepEqual(counters(originalRestored), expected);
  const sourceFingerprint = inventoryFingerprint(dataInventory(f.source));
  const isolated = path.join(f.root, 'isolated'),
    prepared = await f.prepare(isolated);
  assert.equal(inventoryFingerprint(dataInventory(f.source)), sourceFingerprint);
  assert.equal(prepared.mode, 'isolated');
  assert.deepEqual(counters(isolated, true), expected);
  assert.deepEqual(counters(isolated), []);
  assert.equal((await verifyV2Backup(prepared.preparedArchive, f.keyFile)).organizations, 0);
  const isolatedRestored = path.join(f.root, 'isolated-restored');
  await restoreV2Backup(prepared.preparedArchive, f.keyFile, isolatedRestored);
  assert.deepEqual(counters(isolatedRestored, true), expected);
  const db = connection(isolatedRestored);
  try {
    assert.equal(
      db.prepare("SELECT count(*) n FROM login_limits WHERE key='synthetic-login-attempt'").get().n,
      0,
    );
  } finally {
    db.close();
  }
  assert.deepEqual(
    await restoreDrill(prepared.preparedArchive, f.keyFile, path.join(f.root, 'drill')),
    {
      restored: true,
      started: true,
      notificationsPaused: true,
    },
  );
  const rollback = path.join(f.root, 'rollback'),
    rolled = await f.prepare(rollback, { source: isolated, rollback: true });
  assert.equal(rolled.mode, 'legacy');
  assert.deepEqual(counters(rollback), expected);
  assert.deepEqual(counters(rollback, true), expected);
  const rolledRestored = path.join(f.root, 'rollback-restored');
  await restoreV2Backup(rolled.preparedArchive, f.keyFile, rolledRestored);
  assert.deepEqual(counters(rolledRestored), expected);
  assert.deepEqual(counters(rolledRestored, true), expected);
  const restored = createPlatformStore(path.join(rolledRestored, 'platform'));
  restored.close();
});

test('backup rejects missing, unregistered and identity-mismatched budget stores without publishing a new archive', async (t) => {
  const f = fixture(t),
    isolated = path.join(f.root, 'isolated');
  const prepared = await f.prepare(isolated),
    file = path.join(isolated, 'platform', store.filename);
  const baseline = fs.readdirSync(f.directory).sort();
  fs.renameSync(file, file + '.held');
  await assert.rejects(createV2Backup({ ...f.options, source: isolated }), /budget.*missing/i);
  fs.renameSync(file + '.held', file);
  const db = connection(isolated, store.filename);
  try {
    db.prepare('UPDATE budget_meta SET store_id=?').run('00000000-0000-0000-0000-000000000000');
  } finally {
    db.close();
  }
  await assert.rejects(createV2Backup({ ...f.options, source: isolated }), /identity mismatch/i);
  fs.copyFileSync(file, path.join(f.source, 'platform', store.filename));
  await assert.rejects(createV2Backup(f.options), /Unregistered/);
  assert.deepEqual(fs.readdirSync(f.directory).sort(), baseline);
  // A valid authenticated archive with a removed inventory entry must also fail.
  const stage = path.join(f.root, 'extracted');
  fs.mkdirSync(stage);
  const key = fs.readFileSync(f.keyFile),
    { recovered } = await extractArchive(prepared.preparedArchive, key, stage);
  const manifestFile = path.join(recovered, 'manifest.json'),
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.files = manifest.files.filter((entry) => entry.name !== 'platform/' + store.filename);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const forged = path.join(f.root, 'omitted-budget.enc');
  await writeArchive(
    recovered,
    ['manifest.json', ...manifest.files.map((entry) => entry.name)],
    forged,
    key,
  );
  const destination = path.join(f.root, 'must-not-exist');
  await assert.rejects(restoreV2Backup(forged, f.keyFile, destination), /registration mismatch/);
  assert.equal(fs.existsSync(destination), false);
});

test('organization and platform fingerprints include budget counters, and logical state survives a full copy', async (t) => {
  const f = fixture(t),
    isolated = path.join(f.root, 'isolated');
  const prepared = await f.prepare(isolated),
    before = dataInventory(isolated),
    platformBefore = componentFingerprint(path.join(isolated, 'platform'), 'platform');
  assert.ok(before.some((row) => row.name === 'platform/' + store.filename));
  const restored = path.join(f.root, 'restored');
  const { recoverUpgradeCopy } = require('../src/server/infrastructure/backup/service.cjs');
  await recoverUpgradeCopy(prepared.preparedArchive, f.keyFile, restored);
  assert.deepEqual(dataInventory(restored), before);
  const db = connection(isolated, store.filename);
  try {
    db.prepare('UPDATE login_limits SET failures=failures+1 WHERE key=?').run(addressKey);
  } finally {
    db.close();
  }
  assert.notEqual(inventoryFingerprint(dataInventory(isolated)), inventoryFingerprint(before));
  assert.notEqual(
    componentFingerprint(path.join(isolated, 'platform'), 'platform'),
    platformBefore,
  );
});

test('snapshot acquires budget after platform and includes an in-flight writer only after its commit', async (t) => {
  const f = fixture(t),
    isolated = path.join(f.root, 'isolated');
  await f.prepare(isolated);
  const stage = path.join(f.root, 'snapshot');
  fs.mkdirSync(stage);
  const budget = connection(isolated, store.filename);
  budget.exec('BEGIN IMMEDIATE');
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    const { DatabaseSync } = require('node:sqlite');
    const { snapshotDatabases } = require(${JSON.stringify(path.resolve('src/server/infrastructure/backup/snapshot.cjs'))});
    const exec = DatabaseSync.prototype.exec;
    let begins = 0;
    DatabaseSync.prototype.exec = function(sql) {
      if (sql.includes('BEGIN IMMEDIATE') && ++begins === 2) process.send('budget-acquire');
      return exec.call(this, sql);
    };
    snapshotDatabases(process.argv[1], process.argv[2]);
    process.send('snapshotted'); process.disconnect();
  `,
      isolated,
      stage,
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true },
  );
  let messages = [],
    errorOutput = '';
  child.stderr.on('data', (chunk) => {
    errorOutput += chunk;
  });
  const ended = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(Error('Synthetic snapshot timeout'));
    }, 10000);
    child.once('error', reject);
    child.on('message', (message) => {
      messages.push(message);
      if (message === 'budget-acquire') {
        budget.prepare('UPDATE login_limits SET failures=240 WHERE key=?').run(addressKey);
        budget.exec('COMMIT');
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      code === 0 ? resolve() : reject(Error('Synthetic snapshot failed: ' + errorOutput));
    });
  });
  try {
    await ended;
    assert.deepEqual(messages, ['budget-acquire', 'snapshotted']);
    assert.equal(counters(stage, true).find((row) => row.key === addressKey).failures, 240);
  } finally {
    if (budget.isTransaction) budget.exec('ROLLBACK');
    budget.close();
    if (child.exitCode === null) child.kill();
  }
});
