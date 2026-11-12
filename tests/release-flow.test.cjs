const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const flow = require('../scripts/release/flow.cjs');
const { artifactIdentity, relayUrl, download } = require('../scripts/release/flow-artifact.cjs');
const { manifest, objectHash } = require('../scripts/release/files.cjs');
const { writeJson } = require('../scripts/release/state.cjs');
const head = 'a'.repeat(40),
  repository = 'qvvp8g7sh8-debug/cartoteca';
const branch = 'codex/release-pipeline-synthetic-flow';
const bytes = Buffer.from('SYNTHETIC_ARTIFACT');
const digest = 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
const metadata = {
  id: 5,
  name: 'verified-release',
  expired: false,
  digest,
  size_in_bytes: bytes.length,
  workflow_run: { id: 7, head_sha: head },
};
const reference = 'https://synthetic.oaiusercontent.com/file?sig=SYNTHETIC_SECRET';
const run = (extra = {}) => ({
  id: 7,
  head_sha: head,
  head_branch: branch,
  path: '.github/workflows/release.yml',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  repository: { full_name: repository },
  ...extra,
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-flow-synthetic-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('release-flow-synthetic-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const directory = path.join(root, '.release/candidates/local'),
    source = path.join(directory, 'source');
  fs.mkdirSync(path.join(source, 'src'), { recursive: true });
  fs.writeFileSync(path.join(source, 'src/example.js'), '// SYNTHETIC\n');
  const files = manifest(source);
  writeJson(path.join(directory, 'candidate.json'), {
    version: 1,
    id: 'local',
    files,
    sourceHash: objectHash(files),
  });
  fs.mkdirSync(path.join(directory, 'submission-1'));
  writeJson(path.join(directory, 'submission-1/report.json'), {
    candidate: 'local',
    sourceHash: objectHash(files),
    status: 'submitted',
    repository,
    branch,
    commit: head,
  });
  return { root, directory };
}
const reply = () => ({ ok: true, status: 200, body: [bytes] });
async function toReference(root) {
  await flow.advance(root, 'local', { kind: 'ci', run: run(), jobs: [], totalJobs: 0 });
  return flow.advance(root, 'local', { kind: 'artifacts', artifacts: [metadata], total: 1 });
}

test('flow binds the pushed commit, never resubmits and rejects a different workflow', (t) => {
  const { root } = fixture(t);
  const result = flow.start(root, 'local');
  assert.equal(result.action.kind, 'ci');
  assert.throws(() => flow.start(root, 'local'), /already exists/);
  for (const extra of [
    { head_sha: 'b'.repeat(40) },
    { event: 'workflow_dispatch' },
    { path: '.github/workflows/other.yml' },
    { repository: { full_name: 'foreign/repo' } },
  ])
    assert.throws(() => flow.validateRun(run(extra), flow.read(root, 'local')));
});
test('run discovery waits for a complete job inventory before advancing', async (t) => {
  const { root } = fixture(t);
  flow.start(root, 'local');
  const state = await flow.advance(root, 'local', { kind: 'ci', runs: [run()] });
  assert.equal(state.phase, 'ci');
  assert.ok(state.action.jobsUrl.includes('/runs/7/jobs'));
});
test('a diagnostic report that is still appearing gets a bounded wait', async (t) => {
  const { root } = fixture(t);
  flow.start(root, 'local');
  await flow.advance(root, 'local', {
    kind: 'ci',
    run: run({ status: 'in_progress' }),
    totalJobs: 1,
    jobs: [{ id: 8, name: 'prepare', conclusion: 'failure' }],
  });
  const pending = await flow.advance(root, 'local', { kind: 'artifacts', artifacts: [], total: 0 });
  assert.equal(pending.phase, 'diagnostics');
  const state = flow.read(root, 'local');
  state.diagnosticsStartedAt = new Date(Date.now() - 181000).toISOString();
  writeJson(path.join(root, '.release/flows/local/state.json'), state);
  const expired = await flow.advance(root, 'local', { kind: 'artifacts', artifacts: [], total: 0 });
  assert.equal(expired.phase, 'failed');
});
test('a failing job is collected before the remaining CI jobs finish', async (t) => {
  const { root } = fixture(t);
  flow.start(root, 'local');
  const state = await flow.advance(root, 'local', {
    kind: 'ci',
    run: run({ status: 'in_progress', conclusion: null }),
    totalJobs: 2,
    jobs: [
      { id: 8, name: 'verify (windows, windows-latest, unit-5)', conclusion: 'failure' },
      { id: 9, name: 'server-stand', conclusion: null },
    ],
  });
  assert.equal(state.phase, 'diagnostics');
  assert.equal(state.action.kind, 'artifacts');
  assert.deepEqual(flow.diagnosticNames(flow.read(root, 'local')), ['report-windows-unit-5']);
});
test('incomplete metadata and expired/wrong-commit artifacts never reach publication', async (t) => {
  const { root } = fixture(t);
  flow.start(root, 'local');
  const result = await flow.advance(root, 'local', {
    kind: 'ci',
    run: run(),
    totalJobs: 2,
    jobs: [],
  });
  assert.equal(result.phase, 'failed');
  for (const changed of [
    { expired: true },
    { digest: 'invalid' },
    { size_in_bytes: -1 },
    { workflow_run: { id: 7, head_sha: 'b'.repeat(40) } },
  ])
    assert.throws(() => artifactIdentity({ ...metadata, ...changed }, { run: 7, head }));
});
test('connector-first download verifies bytes/hash, reuses intact files and emits no signed reference', async (t) => {
  const { root } = fixture(t),
    events = [];
  const selected = artifactIdentity(metadata, { run: 7, head });
  const file = await download(root, selected, reference, {
    request: async () => reply(),
    emit: (e) => events.push(e),
  });
  assert.deepEqual(fs.readFileSync(file), bytes);
  await download(root, selected, reference, {
    request: async () => {
      throw Error('Must use verified local file');
    },
  });
  assert.equal(JSON.stringify(events).includes('SYNTHETIC_SECRET'), false);
  assert.throws(() => relayUrl('https://github.com/file'));
  assert.throws(() => relayUrl('http://synthetic.oaiusercontent.com/file'));
});
test('a damaged download is never imported or cached as verified', async (t) => {
  const { root } = fixture(t);
  await assert.rejects(
    download(root, artifactIdentity(metadata, { run: 7, head }), reference, {
      request: async () => ({ ...reply(), body: [Buffer.from('WRONG')] }),
    }),
  );
  assert.equal(fs.existsSync(path.join(root, 'artifact-5.zip')), false);
  assert.equal(
    fs.readdirSync(root).some((n) => n.includes('.next-')),
    false,
  );
});
test('preparation mode stops at the checked package and does not publish', async (t) => {
  const { root } = fixture(t);
  flow.start(root, 'local');
  await toReference(root);
  let publications = 0;
  const result = await flow.advance(
    root,
    'local',
    { kind: 'reference', artifactId: 5, url: reference },
    {
      request: async () => reply(),
      extract: (_zip, target) => fs.mkdirSync(target),
      verifyPackage: async () => ({}),
      publishRelease: async () => {
        publications++;
      },
    },
  );
  assert.equal(result.phase, 'ready');
  assert.equal(publications, 0);
  assert.equal(JSON.stringify(flow.read(root, 'local')).includes('SYNTHETIC_SECRET'), false);
});
test('an imported package without complete reports stays unpublishable', async (t) => {
  const { root } = fixture(t);
  flow.start(root, 'local');
  await toReference(root);
  const result = await flow.advance(
    root,
    'local',
    { kind: 'reference', artifactId: 5, url: reference },
    {
      request: async () => reply(),
      extract: (_zip, target) => fs.mkdirSync(target),
    },
  );
  assert.notEqual(result.phase, 'ready');
  assert.notEqual(result.phase, 'publishing');
});
test('failed-file reports are downloaded automatically into private diagnostics', async (t) => {
  const { root } = fixture(t);
  flow.start(root, 'local');
  await flow.advance(root, 'local', {
    kind: 'ci',
    run: run({ status: 'in_progress' }),
    totalJobs: 1,
    jobs: [{ id: 8, name: 'verify (windows, windows-latest, unit-5)', conclusion: 'failure' }],
  });
  const diagnostic = { ...metadata, name: 'report-windows-unit-5' };
  await flow.advance(root, 'local', { kind: 'artifacts', artifacts: [diagnostic], total: 1 });
  const result = await flow.advance(
    root,
    'local',
    { kind: 'reference', artifactId: 5, url: reference },
    {
      request: async () => reply(),
      extract: (_zip, target) => {
        fs.mkdirSync(target);
        writeJson(path.join(target, 'report.json'), {
          steps: [
            { diagnostics: { failedFiles: ['tests/synthetic.test.cjs', '../private/token'] } },
          ],
        });
      },
    },
  );
  assert.deepEqual(result.diagnostics[0].failedFiles, ['tests/synthetic.test.cjs']);
  assert.equal(result.phase, 'diagnostics');
});

function config(root) {
  const identityFile = path.join(root, 'synthetic-identity'),
    knownHostsFile = path.join(root, 'synthetic-hosts');
  fs.writeFileSync(identityFile, 'NOT_A_REAL_KEY');
  fs.writeFileSync(knownHostsFile, 'NOT_A_REAL_HOST');
  const file = path.join(root, 'deploy.json');
  writeJson(file, {
    host: 'synthetic.invalid',
    user: 'synthetic',
    port: 22,
    identityFile,
    knownHostsFile,
    root: '/opt/synthetic-app',
    releaseRoot: '/opt/synthetic-releases',
    container: 'synthetic',
    project: 'synthetic',
    backupTimer: 'synthetic.timer',
    origin: 'https://example.invalid/',
    schema: 17,
    expectedImage: 'sha256:' + 'b'.repeat(64),
  });
  return file;
}
test('explicit publication chains package, executor, baseline and independent acceptance', async (t) => {
  const { root } = fixture(t);
  const deployConfig = config(root);
  flow.start(root, 'local', { publish: true, deployConfig });
  await toReference(root);
  const calls = [];
  const candidate = {
    data: { id: 'ci-7' },
    directory: path.join(root, '.release/candidates/ci-7'),
  };
  const result = await flow.advance(
    root,
    'local',
    { kind: 'reference', artifactId: 5, url: reference },
    {
      request: async () => reply(),
      extract: (_zip, target) => fs.mkdirSync(target),
      verifyPackage: async () => candidate,
      publishRelease: async (_root, _id, opts) => {
        calls.push(opts.command);
        return { status: 'completed', published: true, active: false };
      },
      recordBaseline: () => {
        calls.push('baseline');
        return true;
      },
      verifyPublication: async () => {
        calls.push('acceptance');
        return { build: 'SYNTHETIC' };
      },
    },
  );
  assert.equal(result.phase, 'completed');
  assert.deepEqual(calls, ['publish', 'baseline', 'acceptance']);
});
test('lost publication acknowledgement resumes the same journal and never publishes twice', async (t) => {
  const { root } = fixture(t);
  flow.start(root, 'local', { publish: true, deployConfig: config(root) });
  await toReference(root);
  const candidate = {
    data: { id: 'ci-7' },
    directory: path.join(root, '.release/candidates/ci-7'),
  };
  const calls = [];
  const hooks = {
    request: async () => reply(),
    extract: (_zip, target) => fs.mkdirSync(target),
    verifyPackage: async () => candidate,
    publishRelease: async (_root, _id, opts) => {
      calls.push(opts.command);
      if (calls.length === 1) {
        fs.mkdirSync(path.join(candidate.directory, 'deployment'));
        writeJson(path.join(candidate.directory, 'deployment/local.json'), { synthetic: true });
        throw Error('SYNTHETIC_LOST_ACK');
      }
      return { status: 'completed', published: true, active: false };
    },
    recordBaseline: () => true,
    verifyPublication: async () => ({ build: 'SYNTHETIC' }),
  };
  const first = await flow.advance(
    root,
    'local',
    { kind: 'reference', artifactId: 5, url: reference },
    hooks,
  );
  assert.equal(first.phase, 'publishing');
  assert.equal(first.interrupted, true);
  const second = await flow.advance(root, 'local', {}, hooks);
  assert.equal(second.phase, 'completed');
  assert.deepEqual(calls, ['publish', 'resume']);
});
test('a changed deployment destination blocks the executor before any publication', async (t) => {
  const { root } = fixture(t),
    deployConfig = config(root);
  flow.start(root, 'local', { publish: true, deployConfig });
  const changed = JSON.parse(fs.readFileSync(deployConfig));
  changed.host = 'changed.invalid';
  writeJson(deployConfig, changed);
  let called = false;
  const result = await flow.advance(
    root,
    'local',
    { kind: 'ci', run: run() },
    {
      publishRelease: async () => {
        called = true;
      },
    },
  );
  assert.equal(result.phase, 'failed');
  assert.equal(called, false);
});
