const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { adminFixture } = require('./helpers/admin-fixture.cjs');
const { createBackupKey } = require('../src/server/infrastructure/backup/service.cjs');
const root = path.resolve(__dirname, '..');

test('real CLI backup, scheduled deduplication, status and plan use only isolated synthetic directories', async (t) => {
  const platform = await adminFixture(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-backup-cli-'));
  platform.cleanup(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^cartoteca-backup-cli-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^BACKUP_|^CARTOTECA_DATA_DIR$|^APP_ORIGIN$|^NODE_ENV$/.test(name),
    ),
  );
  Object.assign(environment, {
    CARTOTECA_DATA_DIR: platform.directory,
    BACKUP_DIR: path.join(directory, 'archives'),
    BACKUP_KEY_FILE: path.join(directory, 'keys', 'backup.key'),
    BACKUP_STATE_DIR: path.join(directory, 'state'),
    BACKUP_WORK_DIR: path.join(directory, 'work'),
    BACKUP_STATUS_FILE: path.join(directory, 'status', 'status.json'),
  });
  createBackupKey(environment.BACKUP_KEY_FILE);
  const run = (...args) =>
    spawnSync(process.execPath, [path.join(root, 'scripts/backup-agent.cjs'), ...args], {
      env: environment,
      cwd: root,
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });
  const first = run('run', '--scheduled');
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).state, 'local_only');
  assert.equal(
    fs.readdirSync(environment.BACKUP_DIR).filter((name) => name.endsWith('.enc')).length,
    1,
  );
  assert.equal(JSON.parse(run('run', '--scheduled').stdout).state, 'already_completed');
  const status = JSON.parse(run('status').stdout);
  assert.equal(status.health, 'incomplete');
  assert.equal(status.lastRemoteAt, null);
  assert.doesNotMatch(JSON.stringify(status), /archive\.enc|keys|accountId|patient|secret/);
  assert.deepEqual(JSON.parse(run('retention-plan').stdout), { candidates: [], deleted: false });
  const refused = run('prune');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /BACKUP_EXPLICIT_APPLY_REQUIRED/);
  assert.equal(fs.readdirSync(environment.BACKUP_DIR).length, 1);
  assert.equal(fs.readdirSync(environment.BACKUP_WORK_DIR).length, 0);
});

test('deployment sources isolate archive credentials from web and bound the independent container lifetime', () => {
  const web = fs.readFileSync(path.join(root, 'compose.yaml'), 'utf8');
  assert.doesNotMatch(web, /BACKUP_KEY_FILE|BACKUP_DIR|\.\/backups:|\.\/private:/);
  assert.match(web, /\.\/backup-status:\/backup-status:ro/);
  const worker = fs.readFileSync(path.join(root, 'compose.backup.yaml'), 'utf8');
  assert.match(worker, /env_file: \.env.backup/);
  assert.doesNotMatch(worker.replace(/^#.*$/gm, ''), /\.env.local|ports:|SMTP|TELEGRAM/);
  assert.match(worker, /\.\/private\/backup:\/secrets:ro/);
  const service = fs.readFileSync(
    path.join(root, 'scripts/cartoteca-backup-agent.service'),
    'utf8',
  );
  assert.match(service, /TimeoutStartSec=1800/);
  assert.match(service, /ExecStopPost=-\/usr\/bin\/docker stop --time 10 cartoteca-backup-worker/);
});
