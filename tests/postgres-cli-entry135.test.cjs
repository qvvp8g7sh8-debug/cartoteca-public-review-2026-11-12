const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const script = path.join(root, 'scripts/postgres-ops.cjs');
function child(args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      ['SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP'].includes(key.toUpperCase()),
    ),
  );
  return spawnSync(process.execPath, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 262144,
    windowsHide: true,
  });
}
test('a freshly required PostgreSQL operator publishes its complete callable API', () => {
  const result = child([
    '-e',
    'const ops=require(process.argv[1]);console.log(JSON.stringify(Object.fromEntries(Object.keys(ops).sort().map(k=>[k,typeof ops[k]]))));',
    script,
  ]);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(
    JSON.parse(result.stdout),
    Object.fromEntries(
      [
        'fileOnly',
        'main',
        'migrateServer',
        'migrationOptions',
        'prepareRoleLeases',
        'provisionPostgres',
        'roleLeaseOptions',
        'scramSecret',
        'verifyApplicationRole',
        'withOwner',
      ].map((name) => [name, 'function']),
    ),
  );
});
test('standalone CLI help remains callable without credentials or a database', () => {
  const result = child([script, 'help']);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const value = JSON.parse(result.stdout);
  assert.equal(value.automaticMigration, false);
  assert.ok(value.commands.includes('prepare-compound --offline --apply|--dry-run'));
});
for (const command of [
  'prepare-revisions',
  'rollback-revisions',
  'prepare-compound',
  'rollback-compound',
])
  test(
    'standalone ' + command + ' refuses an absent private profile without a circular import',
    () => {
      // The empty PG environment refuses admission before any secret read or connection.
      // A direct entrypoint must initialize its exports before the revision operator reuses it.
      const result = child([script, command, '--offline', '--dry-run']);
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(
        result.stderr.trim(),
        'PostgreSQL operation did not complete; no runtime cutover was performed.',
      );
    },
  );
