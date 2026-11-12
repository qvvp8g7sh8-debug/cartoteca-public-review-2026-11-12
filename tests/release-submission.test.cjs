const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { git, submit, coordinates } = require('../scripts/release/submission.cjs');
const { manifest, objectHash } = require('../scripts/release/files.cjs');
const { writeJson } = require('../scripts/release/state.cjs');
const { recordPublished } = require('../scripts/release/impact-baseline.cjs');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-submit-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const remote = path.join(root, 'synthetic.git'),
    base = path.join(root, 'base');
  fs.mkdirSync(base);
  await git(['init', '--bare', remote], root);
  await git(['init', '--template=', '--initial-branch=main'], base);
  fs.writeFileSync(path.join(base, 'old.txt'), 'SYNTHETIC_OLD_SOURCE');
  await git(['add', 'old.txt'], base);
  await git(
    [
      '-c',
      'user.name=Synthetic',
      '-c',
      'user.email=synthetic@example.invalid',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '-m',
      'Synthetic parent',
    ],
    base,
  );
  await git(['remote', 'add', 'origin', remote], base);
  await git(['push', 'origin', 'main'], base);
  const directory = path.join(root, '.release/candidates/test'),
    source = path.join(directory, 'source');
  fs.mkdirSync(path.join(source, 'src'), { recursive: true });
  fs.writeFileSync(path.join(source, 'src/example.js'), '// SYNTHETIC_NEW_SOURCE\n');
  fs.writeFileSync(path.join(source, 'package.json'), '{}\n');
  const files = manifest(source);
  writeJson(path.join(directory, 'candidate.json'), {
    version: 1,
    id: 'test',
    files,
    sourceHash: objectHash(files),
  });
  const calls = [];
  const execute = async (args, cwd, signal) => {
    calls.push(args);
    const local = args.map((arg) =>
      arg === 'https://github.com/qvvp8g7sh8-debug/cartoteca.git' ? remote : arg,
    );
    return git(local, cwd, signal);
  };
  return { root, source, remote, base, execute, calls };
}
const opts = {
  repository: 'qvvp8g7sh8-debug/cartoteca',
  baseRef: 'main',
  branch: 'codex/release-pipeline-synthetic',
};

test('one push exports the exact frozen tree, retains parent history and excludes changing development files', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, 'unrelated.txt'), 'NOT_PART_OF_SNAPSHOT');
  const result = await submit(f.root, 'test', opts, undefined, f.execute);
  assert.equal(result.status, 'submitted', result.error);
  assert.equal(result.publishesSite, false);
  assert.equal(result.remoteVerified, true);
  assert.equal(recordPublished(f.root, 'test', {
    status: 'completed', published: true, active: false,
  }), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'release-baseline.json'))).commit, result.commit);
  assert.equal(
    await git(['--git-dir=' + f.remote, 'rev-parse', result.commit + '^'], f.root),
    result.parent,
  );
  assert.equal(
    await git(['--git-dir=' + f.remote, 'show', result.commit + ':src/example.js'], f.root),
    '// SYNTHETIC_NEW_SOURCE',
  );
  assert.deepEqual(
    (
      await git(['--git-dir=' + f.remote, 'ls-tree', '-r', '--name-only', result.commit], f.root)
    ).split('\n'),
    ['package.json', 'src/example.js'],
  );
  assert.equal(f.calls.filter((args) => args.includes('push')).length, 1);
  assert.ok(
    !f.calls.some((args) => args.includes('--force') || args.includes('--force-with-lease')),
  );
});
test('existing remote branch is refused and interrupted push is unknown rather than blindly repeated', async (t) => {
  const f = await fixture(t);
  await git(['push', 'origin', 'main:refs/heads/' + opts.branch], f.base);
  const existing = await submit(f.root, 'test', opts, undefined, f.execute);
  assert.equal(existing.status, 'failed');
  assert.match(existing.error, /already exists/);
  const changed = { ...opts, branch: 'codex/release-pipeline-another' };
  const interrupted = await submit(
    f.root,
    'test',
    changed,
    undefined,
    async (args, cwd, signal) => {
      if (args.includes('push')) throw Error('Synthetic disconnect');
      return f.execute(args, cwd, signal);
    },
  );
  assert.equal(interrupted.status, 'unknown');
  assert.equal(interrupted.publishesSite, false);
});
test('external submission requires explicit known repository/base and a release branch', () => {
  for (const change of [
    { repository: 'other/repo' },
    { branch: 'main' },
    { baseRef: '--upload-pack=bad' },
    { baseRef: '../main' },
  ])
    assert.throws(() => coordinates({ ...opts, ...change }));
});

test('unverified remote head never becomes a published baseline and push is not retried', async (t) => {
  const f = await fixture(t);
  let pushed = false;
  const report = await submit(f.root, 'test', opts, undefined, async (args, cwd, signal) => {
    if (pushed && args.includes('ls-remote')) return '0'.repeat(40) + '\trefs/heads/' + opts.branch;
    const result = await f.execute(args, cwd, signal);
    if (args.includes('push')) pushed = true;
    return result;
  });
  assert.equal(report.status, 'unknown');
  assert.equal(recordPublished(f.root, 'test', { status: 'completed', published: true, active: false }), false);
  assert.equal(f.calls.filter(args => args.includes('push')).length, 1);
});
