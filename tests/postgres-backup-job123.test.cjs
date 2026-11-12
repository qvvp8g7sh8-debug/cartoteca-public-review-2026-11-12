const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { allowed } = require('../scripts/release/files.cjs');
test('PG backup package has exact isolated one-shot units and no application env_file', () => {
  const root = path.resolve(__dirname, '..');
  const service = fs.readFileSync(
    path.join(root, 'scripts/cartoteca-postgres-backup.service'),
    'utf8',
  );
  assert.match(
    service,
    /^ExecStart=\/usr\/bin\/python3 \/opt\/cartoteca\/scripts\/postgres-backup-job\.py run --config \/etc\/cartoteca-postgres-backup\.json --scheduled$/m,
  );
  assert.match(
    service,
    /^ExecStopPost=-\/usr\/bin\/python3 .*postgres-backup-job\.py stop --config \/etc\/cartoteca-postgres-backup\.json$/m,
  );
  const timer = fs.readFileSync(path.join(root, 'scripts/cartoteca-postgres-backup.timer'), 'utf8');
  assert.match(timer, /^Unit=cartoteca-postgres-backup.service$/m);
  assert.match(timer, /^Persistent=true$/m);
  const compose = fs.readFileSync(path.join(root, 'compose.postgres.backup.yaml'), 'utf8');
  assert.doesNotMatch(compose, /^\s*env_file:|\bs3\b|^\s*ports:/m);
  assert.match(compose, /entrypoint: \[node\]/);
  assert.match(compose, /tmpfs: \['\/tmp:size=64m,mode=1777'\]/);
  assert.match(compose, /assets:\/data:ro/);
  for (const name of [
    'compose.postgres.backup.yaml',
    'scripts/postgres-backup-job.py',
    'scripts/cartoteca-postgres-backup.service',
    'scripts/cartoteca-postgres-backup.timer',
  ])
    assert.equal(allowed(name), true);
  assert.equal(allowed('scripts/postgres-backup-private.py'), false);
});
test(
  'host backup wrapper rejects ambiguous routing, preserves warning exits and stops only its own pinned container',
  { skip: process.platform !== 'linux' },
  () => {
    execFileSync('python3', ['-I', path.join(__dirname, 'helpers/release-postgres-backup.py')], {
      encoding: 'utf8',
      timeout: 30000,
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
    });
  },
);
