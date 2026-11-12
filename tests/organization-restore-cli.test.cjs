const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { organizationRestoreFixture } = require('./helpers/organization-restore-fixture.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { createV2Backup } = require('../src/server/infrastructure/backup/service.cjs');
const { switchMarker } = require('../src/server/infrastructure/backup/organization-guard.cjs');
const {
  dataInventory,
  inventoryFingerprint,
} = require('../src/server/infrastructure/backup/organization-inventory.cjs');

const root = path.resolve(__dirname, '..');
const fingerprint = (directory) => inventoryFingerprint(dataInventory(directory));
function command(f, action, ...args) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(CARTOTECA_|BACKUP_|TELEGRAM_|MAX_|NODE_OPTIONS$)/.test(name),
    ),
  );
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'scripts/restore-organization.cjs'), action, ...args],
    { cwd: f.directory, env: environment, encoding: 'utf8', timeout: 30000, windowsHide: true },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  // The operator interface must not print even synthetic clinical or private details.
  for (const value of [
    f.source,
    f.keyFile,
    f.archive,
    f.owners[0].organizationId,
    'example.test',
    'PRIVATE NOTE',
    'synthetic-chat',
    'Synthetic-restore-password',
  ]) {
    assert.equal((result.stdout + result.stderr).includes(value), false);
  }
  return result;
}
function required(f) {
  return ['--job', f.jobDirectory, '--key', f.keyFile];
}
function prepare(f) {
  const result = command(
    f,
    'prepare',
    ...required(f),
    '--source',
    f.source,
    '--archive',
    f.archive,
    '--organization',
    f.owners[0].organizationId,
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('real organization CLI prepares, verifies, switches and returns synthetic data with private output', async (t) => {
  const f = await organizationRestoreFixture(t, 15),
    before = fingerprint(f.source);
  const prepared = prepare(f);
  assert.equal(prepared.state, 'prepared');
  assert.equal(fingerprint(f.source), before);
  assert.equal(JSON.parse(command(f, 'verify', ...required(f)).stdout).id, prepared.id);
  assert.equal(JSON.parse(command(f, 'status', ...required(f)).stdout).state, 'prepared');
  const switchArgs = [...required(f), '--source', f.source, '--confirm', prepared.id];
  const denied = command(f, 'apply', ...switchArgs);
  assert.equal(denied.status, 1);
  assert.equal(fs.existsSync(switchMarker(f.source)), false);
  const activated = command(f, 'apply', ...switchArgs, '--stopped');
  assert.equal(activated.status, 0, activated.stderr);
  assert.equal(JSON.parse(activated.stdout).state, 'activated');
  assert.equal(JSON.parse(command(f, 'status', ...required(f)).stdout).state, 'activated');
  const repeated = command(f, 'apply', ...switchArgs, '--stopped');
  assert.equal(repeated.status, 1);
  const restored = fingerprint(f.source);
  const returned = command(f, 'rollback', ...switchArgs, '--stopped');
  assert.equal(returned.status, 0, returned.stderr);
  assert.equal(JSON.parse(returned.stdout).state, 'rolled-back');
  assert.equal(JSON.parse(command(f, 'status', ...required(f)).stdout).state, 'rolled-back');
  assert.notEqual(restored, before);
  assert.equal(fingerprint(f.source), before);
  assert.equal(command(f, 'rollback', ...switchArgs, '--stopped').status, 1);
});

test('CLI rejects missing, duplicate and unknown arguments without fallback to ambient data', async (t) => {
  const f = await organizationRestoreFixture(t),
    before = fingerprint(f.source);
  for (const [action, args] of [
    ['prepare', required(f)],
    ['status', [...required(f), '--job', f.jobDirectory]],
    ['status', [...required(f), '--unknown']],
    ['status', ['--job', f.jobDirectory, '--key']],
    ['destroy', required(f)],
  ]) {
    const result = command(f, action, ...args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Восстановление организации не завершено/);
  }
  assert.equal(fs.existsSync(f.jobDirectory), false);
  assert.equal(fingerprint(f.source), before);
});

test('in-volume switch marker blocks web, direct platform access and backup before any data opens', async (t) => {
  const f = await organizationRestoreFixture(t),
    before = fingerprint(f.source);
  // A damaged journal is also a gate: startup must not guess whether a switch finished.
  fs.writeFileSync(switchMarker(f.source), 'synthetic invalid journal');
  assert.equal(path.dirname(switchMarker(f.source)), f.source);
  assert.throws(() => createMultiServer({ dataDir: f.source }), /incomplete/);
  assert.throws(() => createPlatformDatabase(path.join(f.source, 'platform')), /incomplete/);
  await assert.rejects(
    createV2Backup({
      source: f.source,
      directory: path.join(f.directory, 'blocked-backup'),
      keyFile: f.keyFile,
    }),
    /incomplete/,
  );
  assert.equal(fs.existsSync(switchMarker(f.source)), true);
  assert.equal(fingerprint(f.source), before);
});
