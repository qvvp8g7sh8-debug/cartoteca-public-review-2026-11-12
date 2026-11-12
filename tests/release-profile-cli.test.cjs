const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { options, main } = require('../scripts/release.cjs');
const { prepare } = require('../scripts/release/prepare.cjs');

// A profile is an immutable preparation decision, never a publication-time waiver.
test('assistant profile must be selected explicitly and cannot be changed by verification or publication', async () => {
  assert.deepEqual(options(['--profile', 'assistant-ui', '--baseline-id', 'previous-release']), {
    profile: 'assistant-ui',
    'baseline-id': 'previous-release',
  });
  for (const command of [
    'verify',
    'package',
    'publish',
    'resume',
    'status',
    'aggregate',
    'impact',
  ]) {
    await assert.rejects(
      main([command, '--id', 'synthetic-never-created', '--profile', 'assistant-ui']),
      /profile.*prepare|prepare.*profile/i,
    );
  }
  for (const profile of ['partial', 'fast', 'none', 'assistant-ui,full']) {
    await assert.rejects(
      main(['prepare', '--id', 'synthetic-never-created', '--profile', profile]),
      /profile/i,
    );
  }
});

test('profile options do not accept duplicate values, missing values or skip-like aliases', () => {
  for (const args of [
    ['--profile'],
    ['--profile', '--baseline-id', 'previous-release'],
    ['--profile', 'assistant-ui', '--profile', 'full'],
    ['--skip-server'],
    ['--skip-tests'],
    ['--assume-unchanged'],
  ])
    assert.throws(() => options(args), /option/i, JSON.stringify(args));
});

test('a full preparation cannot use a baseline as an implicit request to skip checks', async () => {
  await assert.rejects(
    main([
      'prepare',
      '--id',
      'synthetic-never-created',
      '--profile',
      'full',
      '--baseline-id',
      'previous-release',
    ]),
    /baseline.*assistant|assistant.*baseline|baseline.*only/i,
  );
});

test('direct preparation rejects an unknown profile before creating a candidate', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-profile-guard-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await assert.rejects(
    prepare(root, 'unknown-profile', undefined, { profile: 'unchecked' }),
    /profile/i,
  );
  assert.equal(fs.existsSync(path.join(root, '.release/candidates/unknown-profile')), false);
});

test('explicit audio selection mode is sealed at assistant preparation only', async () => {
  assert.deepEqual(options(['--selection-mode', 'client-audio-hotfix-v1']), {
    'selection-mode': 'client-audio-hotfix-v1',
  });
  for (const command of ['verify', 'status', 'publish', 'package', 'resume'])
    await assert.rejects(
      main([
        command,
        '--id',
        'synthetic-never-created',
        '--selection-mode',
        'client-audio-hotfix-v1',
      ]),
      /selection-mode.*prepare/i,
    );
  for (const mode of ['skip', 'none', 'client-audio-hotfix-v2'])
    await assert.rejects(
      main([
        'prepare',
        '--id',
        'synthetic-never-created',
        '--profile',
        'assistant-ui',
        '--selection-mode',
        mode,
      ]),
      /selection-mode/i,
    );
  await assert.rejects(
    main([
      'prepare',
      '--id',
      'synthetic-never-created',
      '--profile',
      'full',
      '--selection-mode',
      'client-audio-hotfix-v1',
    ]),
    /selection-mode/i,
  );
});
