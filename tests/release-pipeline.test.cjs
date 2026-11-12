const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  allowed,
  copySnapshot,
  manifest,
  verifySnapshot,
  objectHash,
  controllerHash,
} = require('../scripts/release/files.cjs');
const { location, lock, writeJson, reusable } = require('../scripts/release/state.cjs');
const { steps } = require('../scripts/release/plan.cjs');
const { status } = require('../scripts/release/status.cjs');
const { cleanEnvironment, runProcess, pool } = require('../scripts/release/process.cjs');
const { options } = require('../scripts/release.cjs');
const { prepare } = require('../scripts/release/prepare.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-release-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (name, content) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write('src/example.js', 'const value = 1;\r\n');
  write('tests/example.test.cjs', '// synthetic\n');
  write('package.json', '{}');
  return { root, write };
}

test('prepare validates documentation in the code-only snapshot before build or submission', async (t) => {
  const f = fixture(t);
  f.write(
    'scripts/check-docs.cjs',
    fs.readFileSync(path.join(__dirname, '../scripts/check-docs.cjs'), 'utf8'),
  );
  f.write('scripts/build-client.cjs', "require('node:fs').writeFileSync('app.js','// built');");
  f.write('scripts/release.cjs', '// synthetic controller');
  f.write('package-lock.json', '{}');
  f.write('Dockerfile', 'FROM scratch');
  f.write('AGENTS.md', 'Разработка только локально; docs/RELEASES.md');
  f.write('docs/RELEASES.md', 'не разрешение на публикацию');
  f.write(
    'docs/MODULES.md',
    '| Функция | Исходники | Правила | Тесты |\n| --- | --- | --- | --- |\n' +
      Array.from(
        { length: 30 },
        (_, index) =>
          '| Feature' + index + ' | src/example.js | RELEASES | tests/example.test.cjs |',
      ).join('\n'),
  );
  f.write('work/local-proof.json', '{"synthetic":true}');
  f.write('docs/TESTS.md', 'work/local-proof.json');
  // Workspace validation succeeds, but excluded evidence must not accompany code.
  require('../scripts/check-docs.cjs').checkDocumentation(f.root);
  await assert.rejects(prepare(f.root, 'missing-proof'), /Candidate documentation failed/);
  const rejected = location(f.root, 'missing-proof');
  assert.equal(fs.existsSync(path.join(rejected, 'candidate.json')), false);
  assert.equal(fs.existsSync(path.join(rejected, 'source/app.js')), false);
  assert.equal(fs.existsSync(path.join(rejected, 'source/work/local-proof.json')), false);
  assert.match(
    fs.readFileSync(path.join(rejected, 'prepare-docs.txt'), 'utf8'),
    /missing or unsafe file/,
  );
  f.write('docs/TESTS.md', 'tests/example.test.cjs');
  const passed = await prepare(f.root, 'valid-docs');
  assert.equal(passed.state, 'prepared');
  assert.equal(fs.existsSync(path.join(location(f.root, 'valid-docs'), 'source/app.js')), true);
});

test('snapshot includes uncommitted code, canonicalizes text and never opens private roots', (t) => {
  const f = fixture(t);
  f.write('private/secret.txt', 'SYNTHETIC_SECRET');
  f.write('runtime/patient.json', 'SYNTHETIC_PATIENT');
  f.write('.env.local', 'SYNTHETIC_TOKEN');
  const destination = path.join(f.root, 'snapshot');
  fs.mkdirSync(destination);
  copySnapshot(f.root, destination);
  assert.deepEqual(Object.keys(manifest(destination)), [
    'package.json',
    'src/example.js',
    'tests/example.test.cjs',
  ]);
  assert.equal(
    fs.readFileSync(path.join(destination, 'src/example.js'), 'utf8'),
    'const value = 1;\n',
  );
  const frozen = manifest(destination);
  f.write('src/example.js', 'changed development source');
  verifySnapshot(destination, frozen);
  fs.writeFileSync(path.join(destination, 'src/example.js'), 'tampered candidate');
  assert.throws(() => verifySnapshot(destination, frozen), /Candidate changed/);
});

test('source additions/deletions and unsafe names cannot inherit a successful manifest', (t) => {
  const f = fixture(t),
    before = manifest(f.root);
  f.write('src/new.js', '// new');
  assert.throws(() => verifySnapshot(f.root, before), /Candidate changed/);
  assert.equal(allowed('scripts/start-local.ps1'), true);
  assert.equal(allowed('scripts/setup-assistant-local-speech.ps1'), true);
  assert.equal(allowed('scripts/setup-assistant-local-speech.ps1.bak'), false);
  assert.equal(allowed('scripts/other.ps1'), false);
  for (const name of [
    '../secret',
    'src/../../private/token.js',
    'src/.env',
    'src/data/file.json',
    'src/a.key',
    'private/a.js',
    'src\\a.js',
    '/src/a.js',
    'C:/src/a.js',
  ])
    assert.equal(allowed(name), false, name);
  f.write('src/secret.key', 'synthetic');
  assert.throws(() => manifest(f.root), /Unexpected file/);
  assert.throws(() => location(f.root, '../escape'), /Invalid candidate/);
});

test('release snapshot carries the deployed public MAX CA but excludes adjacent private material', (t) => {
  const f = fixture(t);
  const pem = fs.readFileSync(path.join(__dirname, '../trust/max-root.pem'), 'utf8');
  const certificate = new (require('node:crypto').X509Certificate)(pem);
  assert.equal(certificate.ca, true);
  assert.equal(
    certificate.fingerprint256.replaceAll(':', ''),
    'D26D2D0231B7C39F92CC738512BA54103519E4405D68B5BD703E9788CA8ECF31',
  );
  f.write('trust/max-root.pem', pem);
  f.write('trust/private.key', 'SYNTHETIC_PRIVATE_MATERIAL');
  const destination = path.join(f.root, 'snapshot');
  fs.mkdirSync(destination);
  copySnapshot(f.root, destination);
  assert.equal(fs.readFileSync(path.join(destination, 'trust/max-root.pem'), 'utf8'), pem);
  assert.equal(fs.existsSync(path.join(destination, 'trust/private.key')), false);
  assert.equal(allowed('trust/private.key'), false);
});

test('directory junctions cannot smuggle private input into a snapshot or output', (t) => {
  const f = fixture(t);
  f.write('private/file.js', '// synthetic private');
  fs.symlinkSync(path.join(f.root, 'private'), path.join(f.root, 'src/link'), 'junction');
  assert.throws(() => manifest(f.root), /Link/);
  fs.symlinkSync(path.join(f.root, 'private'), path.join(f.root, '.release'), 'junction');
  assert.throws(() => location(f.root, 'safe-id'), /Links/);
});

test('candidate operations exclude concurrent runs and release the lock explicitly', (t) => {
  const { root } = fixture(t);
  const release = lock(root);
  assert.throws(() => lock(root), /locked/);
  release();
  lock(root)();
});

test('cached success requires unchanged code, environment and the exact step', () => {
  const step = { id: 'unit', args: ['--test'] },
    environment = { node: '24', browsers: '1' };
  const previous = {
    sourceHash: 'one',
    environment,
    steps: [{ ...step, inputHash: objectHash(step), status: 'passed' }],
  };
  assert.equal(reusable(previous, step, environment, 'one'), true);
  assert.equal(reusable(previous, step, environment, 'two'), false);
  assert.equal(reusable(previous, step, { node: '25' }, 'one'), false);
  assert.equal(reusable(previous, { ...step, args: ['different'] }, environment, 'one'), false);
  previous.steps[0].status = 'failed';
  assert.equal(reusable(previous, step, environment, 'one'), false);
});

test('transferred reports never replace dependency installation or physical Git initialization', () => {
  const environment = { node: '24', os: 'win32' };
  for (const id of ['dependencies', 'browser-install', 'git-init', 'git-index']) {
    const step = { id, command: 'git', args: [id === 'git-init' ? 'init' : 'add'] };
    const previous = {
      sourceHash: 'same-source',
      environment,
      steps: [{ id, inputHash: objectHash(step), status: 'passed' }],
    };
    assert.equal(reusable(previous, step, environment, 'same-source'), false);
  }
  assert.equal(
    reusable({ sourceHash: 'same-source', environment: null }, { id: 'unit' }, null, 'same-source'),
    false,
  );
});

test('full plan retains all engines/viewports and packaging rejects missing or partial reports', (t) => {
  const f = fixture(t),
    directory = location(f.root, 'test'),
    source = path.join(directory, 'source');
  fs.mkdirSync(source, { recursive: true });
  copySnapshot(f.root, source);
  const files = manifest(source),
    sourceHash = objectHash(files);
  writeJson(path.join(directory, 'candidate.json'), { version: 1, id: 'test', sourceHash, files });
  assert.equal(status(f.root, 'test').readyToPackage, false);
  for (const target of ['windows', 'linux']) {
    const plan = steps(source, { target });
    assert.equal(plan.filter((s) => s.id.startsWith('main-')).length, target === 'linux' ? 4 : 2);
    assert.equal(plan.filter((s) => s.id.startsWith('admin-')).length, target === 'linux' ? 4 : 2);
    for (const suite of ['main', 'admin'])
      for (const engine of target === 'linux' ? ['chromium', 'webkit'] : ['chromium']) {
        const browser = plan.filter(
          (s) => s.browserCoverage?.suite === suite && s.browserCoverage.engine === engine,
        );
        assert.deepEqual(
          browser.map((s) => s.browserCoverage.functionalWidth),
          [390, 1440],
        );
        assert.deepEqual(
          browser.flatMap((s) => s.browserCoverage.layoutWidths),
          suite === 'main' ? [320, 390, 412, 768, 1440] : [320, 390, 412, 768, 1024, 1440],
        );
      }
    const report = {
      version: 1,
      candidate: 'test',
      sourceHash,
      target,
      status: 'passed',
      environment: {
        os: target === 'windows' ? 'win32' : 'linux',
        controllerHash: controllerHash(files),
      },
      settings: { unitWorkers: 2 },
      planHash: objectHash(plan),
      steps: plan.map((s) => ({ id: s.id, inputHash: objectHash(s), status: 'passed' })),
    };
    const out = path.join(directory, 'reports', target);
    fs.mkdirSync(out, { recursive: true });
    writeJson(path.join(out, 'report.json'), report);
  }
  assert.equal(status(f.root, 'test').readyToPackage, true);
  const file = path.join(directory, 'reports/linux/report.json');
  const report = JSON.parse(fs.readFileSync(file));
  report.status = 'partial';
  writeJson(file, report);
  assert.equal(status(f.root, 'test').readyToPackage, false);
  report.status = 'passed';
  report.steps.pop();
  writeJson(file, report);
  assert.equal(status(f.root, 'test').readyToPackage, false);
});

test('bounded pool overlaps independent work without exceeding its limit', async () => {
  let active = 0,
    maximum = 0;
  const completed = [];
  await pool([1, 2, 3, 4], 2, async (value) => {
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    completed.push(value);
    active--;
  });
  assert.equal(maximum, 2);
  assert.deepEqual(completed.sort(), [1, 2, 3, 4]);
});

test('ordinary failed results do not prevent the remaining test groups from completing', async () => {
  const completed = [];
  await pool([1, 2, 3, 4, 5], 2, async (value) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    completed.push(value);
    return value !== 2;
  });
  assert.deepEqual(
    completed.sort((a, b) => a - b),
    [1, 2, 3, 4, 5],
  );
});

test('code-only continuation helper is included without admitting arbitrary Python helpers', (t) => {
  const f = fixture(t);
  f.write('tests/helpers/release-stand-continuation.py', '# synthetic code-only continuation');
  assert.equal(allowed('tests/helpers/release-stand-continuation.py'), true);
  assert.equal(allowed('tests/helpers/release-unrelated.py'), false);
  const destination = path.join(f.root, 'snapshot');
  fs.mkdirSync(destination);
  copySnapshot(f.root, destination);
  assert.equal(
    fs.readFileSync(path.join(destination, 'tests/helpers/release-stand-continuation.py'), 'utf8'),
    '# synthetic code-only continuation',
  );
});

test('runner records exit failures, timeout and cancellation instead of reporting success', async (t) => {
  const { root } = fixture(t);
  const failed = await runProcess(process.execPath, ['-e', 'process.exit(7)'], {
    cwd: root,
    log: path.join(root, 'fail.txt'),
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.code, 7);
  const expired = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    cwd: root,
    log: path.join(root, 'timeout.txt'),
    timeoutMs: 150,
  });
  assert.equal(expired.status, 'timed_out');
  assert.ok(expired.durationMs < 5000, 'Timed out child must actually stop promptly');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runProcess(process.execPath, [], {
      log: path.join(root, 'abort.txt'),
      signal: controller.signal,
    }),
    /Cancelled/,
  );
  assert.equal(fs.existsSync(path.join(root, 'abort.txt')), false);
});

test('child environment excludes credentials and CLI refuses unknown flags', () => {
  const moduleKey =
    Object.keys(process.env).find((key) => key.toLowerCase() === 'psmodulepath') || 'PSModulePath';
  const previous = process.env[moduleKey];
  process.env[moduleKey] = 'synthetic-system-module-path';
  process.env.CARTOTECA_RELEASE_TEST_SECRET = 'synthetic';
  try {
    assert.equal(cleanEnvironment().CARTOTECA_RELEASE_TEST_SECRET, undefined);
    assert.equal(cleanEnvironment()[moduleKey], 'synthetic-system-module-path');
  } finally {
    delete process.env.CARTOTECA_RELEASE_TEST_SECRET;
    if (previous === undefined) delete process.env[moduleKey];
    else process.env[moduleKey] = previous;
  }
  assert.deepEqual(options(['--id', 'one', '--resume']), { id: 'one', resume: true });
  assert.throws(() => options(['--id', 'one', '--id', 'two']), /duplicate/);
  assert.throws(() => options(['--publish']), /Unknown/);
});
