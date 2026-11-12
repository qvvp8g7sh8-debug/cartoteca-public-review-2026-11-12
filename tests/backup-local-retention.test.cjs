const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { backupConfiguration } = require('../src/server/infrastructure/backup/agent-config.cjs');
const { createBackupKey } = require('../src/server/infrastructure/backup/service.cjs');
const { runBackup } = require('../src/server/infrastructure/backup/agent.cjs');
const {
  localRetentionPlan,
  rotateLocalBackups,
} = require('../src/server/infrastructure/backup/local-retention.cjs');
const {
  markBackupStage,
  cleanupBackupStages,
} = require('../src/server/infrastructure/backup/staging.cjs');
const { fingerprints } = require('../src/server/infrastructure/backup/s3-storage.cjs');
const {
  writeArchive,
  extractArchive,
  limits,
} = require('../src/server/infrastructure/backup/archive.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-local-rotation-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('cartoteca-local-rotation-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const env = {
    CARTOTECA_DATA_DIR: path.join(root, 'source'),
    BACKUP_DIR: path.join(root, 'archives'),
    BACKUP_KEY_FILE: path.join(root, 'keys', 'backup.key'),
    BACKUP_STATE_DIR: path.join(root, 'journal'),
    BACKUP_WORK_DIR: path.join(root, 'work'),
    BACKUP_STATUS_FILE: path.join(root, 'status', 'status.json'),
  };
  createBackupKey(env.BACKUP_KEY_FILE);
  const config = backupConfiguration(env);
  for (const name of [config.source, config.directory, config.workDirectory]) fs.mkdirSync(name);
  return { root, config };
}
async function points(config, count) {
  const rows = [],
    now = Date.now();
  for (let index = 0; index < count; index++) {
    const file = path.join(config.directory, `cartoteca-v2-synthetic-${index}.enc`);
    fs.writeFileSync(file, `synthetic-${index}`);
    const localChecksum = await fingerprints(file);
    rows.push({
      id: String(index),
      destination: config.destinationId,
      state: 'local_only',
      finished: now - index,
      detail: {
        file,
        localAt: now,
        drillAt: now,
        archiveBytes: localChecksum.bytes,
        localChecksum,
      },
    });
  }
  return rows;
}
test('local rotation keeps three distinct verified copies and ignores unknown/failed archives', async (t) => {
  const { config } = fixture(t),
    rows = await points(config, 5);
  const unknown = path.join(config.directory, 'cartoteca-v2-manual.enc');
  fs.writeFileSync(unknown, 'manual');
  const failed = path.join(config.directory, 'cartoteca-v2-failed.enc');
  fs.writeFileSync(failed, 'failed');
  rows.unshift({ state: 'failed', finished: Date.now(), detail: { file: failed } });
  assert.deepEqual(
    localRetentionPlan(config, rows).map((row) => row.id),
    ['3', '4'],
  );
  assert.deepEqual(await rotateLocalBackups(config, rows), ['3', '4']);
  for (const name of ['0', '1', '2'])
    assert.ok(fs.existsSync(rows.find((row) => row.id === name).detail.file));
  assert.ok(fs.existsSync(unknown));
  assert.ok(fs.existsSync(failed));
  assert.equal(localRetentionPlan(config, rows, Date.now() + 27 * 3600000).length, 0);
});
test('damaged preserved copy or lost lease stops local deletion; missing copies do not count', async (t) => {
  const { config } = fixture(t),
    rows = await points(config, 5);
  fs.writeFileSync(rows[0].detail.file, 'damaged');
  await assert.rejects(rotateLocalBackups(config, rows), /BACKUP_REMOTE_CHECKSUM/);
  assert.ok(fs.existsSync(rows[3].detail.file));
  fs.writeFileSync(rows[0].detail.file, 'synthetic-0');
  await assert.rejects(
    rotateLocalBackups(config, rows, {
      leaseCheck: () => {
        throw Error('BACKUP_LEASE_LOST');
      },
    }),
    /BACKUP_LEASE_LOST/,
  );
  fs.unlinkSync(rows[0].detail.file);
  assert.equal(localRetentionPlan(config, rows).length, 1);
  await rotateLocalBackups(config, rows);
  assert.ok(fs.existsSync(rows[1].detail.file));
  assert.ok(fs.existsSync(rows[2].detail.file));
  assert.ok(fs.existsSync(rows[3].detail.file));
});
test('legacy recovery receipts without checksum must authenticate before they justify deletion', async (t) => {
  const { config } = fixture(t),
    rows = await points(config, 4);
  delete rows[0].detail.localChecksum;
  // An old successful receipt alone cannot justify pruning another copy.
  await assert.rejects(rotateLocalBackups(config, rows), /Invalid backup size/);
  for (const row of rows) assert.ok(fs.existsSync(row.detail.file));
});
test('backup run rotates after drill only, preserves the new copy, and never prunes on drill failure', async (t) => {
  const { config } = fixture(t);
  let index = 0;
  const files = [];
  const work = {
    capacity: () => ({ availableBytes: 1e10 }),
    create: async () => {
      const file = path.join(config.directory, `cartoteca-v2-job-${index++}.enc`);
      fs.writeFileSync(file, 'synthetic job ' + index);
      files.push(file);
      return {
        file,
        verified: true,
        archiveBytes: fs.statSync(file).size,
        snapshotMilliseconds: 1,
        localChecksum: await fingerprints(file),
      };
    },
    drill: async () => ({ restored: true }),
  };
  for (let count = 0; count < 4; count++) {
    const result = await runBackup(config, work);
    assert.equal(result.maintenanceError, null);
    assert.ok(fs.existsSync(files.at(-1)));
  }
  assert.equal(fs.readdirSync(config.directory).length, 3);
  await assert.rejects(
    runBackup(config, {
      ...work,
      drill: async () => {
        throw Error('BACKUP_DRILL_FAILED');
      },
    }),
    /BACKUP_DRILL_FAILED/,
  );
  for (const file of files.slice(1, 4)) assert.ok(fs.existsSync(file));
  await assert.rejects(
    runBackup(config, {
      ...work,
      create: async () => {
        throw Error('BACKUP_FAILED');
      },
    }),
    /BACKUP_FAILED/,
  );
  for (const file of files.slice(1, 4)) assert.ok(fs.existsSync(file));
});
test('rotation failure preserves a verified new recovery point and reports maintenance separately', async (t) => {
  const { config } = fixture(t);
  const files = [];
  const work = {
    capacity: () => ({ availableBytes: 1e10 }),
    create: async () => {
      const file = path.join(config.directory, `cartoteca-v2-maintenance-${files.length}.enc`);
      fs.writeFileSync(file, `synthetic ${files.length}`);
      files.push(file);
      return { file, verified: true, localChecksum: await fingerprints(file) };
    },
    drill: async () => ({ restored: true }),
  };
  for (let count = 0; count < 3; count++) await runBackup(config, work);
  fs.writeFileSync(files[2], 'damaged existing recovery point');
  const result = await runBackup(config, work);
  assert.equal(result.state, 'local_only');
  assert.equal(result.maintenanceError, 'BACKUP_MAINTENANCE_FAILED');
  assert.equal(result.removedArchives, 0);
  for (const file of files) assert.ok(fs.existsSync(file));
  const status = JSON.parse(fs.readFileSync(config.statusFile, 'utf8'));
  assert.equal(status.state, 'local_only');
  assert.equal(status.error, null);
  assert.equal(status.maintenanceError, 'BACKUP_MAINTENANCE_FAILED');
  assert.ok(status.lastDrillAt);
});
test('cleanup removes only marked expired stages of finished same-destination jobs', (t) => {
  const { config } = fixture(t),
    now = Date.now();
  const create = (name, jobId, destinationId = config.destinationId) => {
    const stage = path.join(config.directory, name);
    fs.mkdirSync(stage);
    markBackupStage(stage, 'backup-copy', { backupJobId: jobId, destinationId });
    const file = path.join(stage, '.backup-stage.json');
    const marker = JSON.parse(fs.readFileSync(file));
    marker.createdAt = now - 3 * 3600000;
    fs.writeFileSync(file, JSON.stringify(marker));
    return stage;
  };
  const old = create('.cartoteca-v2-old', 'done');
  const active = create('.cartoteca-v2-active', 'active');
  const foreign = create('.cartoteca-v2-foreign', 'done', 'foreign');
  const unknown = path.join(config.directory, '.cartoteca-v2-manual');
  fs.mkdirSync(unknown);
  const rows = [
    {
      id: 'done',
      destination: config.destinationId,
      state: 'interrupted',
      finished: now - 2 * 3600000,
    },
    { id: 'active', destination: config.destinationId, state: 'copying', finished: null },
  ];
  assert.equal(cleanupBackupStages(config, rows, { now }), 1);
  assert.ok(!fs.existsSync(old));
  for (const stage of [active, foreign, unknown]) assert.ok(fs.existsSync(stage));
});
test('compressed archives remain authenticated, read legacy archives, and bound expansion', async (t) => {
  const { root } = fixture(t),
    key = crypto.randomBytes(32);
  const source = path.join(root, 'archive-source');
  fs.mkdirSync(source);
  fs.mkdirSync(path.join(source, 'platform'));
  fs.writeFileSync(path.join(source, 'manifest.json'), '{}');
  fs.writeFileSync(path.join(source, 'platform', 'platform.sqlite'), Buffer.alloc(256 * 1024));
  const names = ['manifest.json', 'platform/platform.sqlite'];
  const compressed = path.join(root, 'compressed.enc'),
    legacy = path.join(root, 'legacy.enc');
  const checksum = await writeArchive(source, names, compressed, key);
  await writeArchive(source, names, legacy, key, { compressed: false });
  const actual = await fingerprints(compressed);
  assert.equal(checksum.sha256, actual.sha256);
  assert.equal(checksum.bytes, actual.bytes);
  assert.ok(fs.statSync(compressed).size < fs.statSync(legacy).size / 2);
  for (const [file, name] of [
    [compressed, 'new'],
    [legacy, 'old'],
  ]) {
    const stage = path.join(root, name);
    fs.mkdirSync(stage);
    const result = await extractArchive(file, key, stage);
    assert.equal(
      fs.statSync(path.join(result.recovered, 'platform', 'platform.sqlite')).size,
      256 * 1024,
    );
  }
  const limited = path.join(root, 'limited');
  fs.mkdirSync(limited);
  await assert.rejects(
    extractArchive(compressed, key, limited, { ...limits, bytes: 4096 }),
    /Excessive|excessive/,
  );
  const damaged = fs.readFileSync(compressed);
  damaged[25] ^= 1;
  fs.writeFileSync(compressed, damaged);
  const invalid = path.join(root, 'invalid');
  fs.mkdirSync(invalid);
  await assert.rejects(extractArchive(compressed, key, invalid));
  assert.ok(!fs.existsSync(path.join(invalid, 'data')));
});
