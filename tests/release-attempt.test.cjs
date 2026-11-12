const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  createAttempt,
  previousAttempt,
  reportDirectory,
} = require('../scripts/release/attempt.cjs');
const { freshReport, writeJson } = require('../scripts/release/state.cjs');
const { manifest, objectHash } = require('../scripts/release/files.cjs');
const { POLICY } = require('../scripts/release/reuse.cjs');
const { reusable } = require('../scripts/release/state.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-release-attempt-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const candidate = { directory, data: { id: 'synthetic', sourceHash: 'synthetic-source' } };
  const report = (phase = 'all') => ({
    ...freshReport(candidate.data, 'windows', { node: '24', os: 'win32' }),
    settings: { jobs: 1, unitWorkers: 2, unitShards: 1 },
    selectedPhase: phase,
    planHash: 'full-plan',
    selectionHash: phase + '-selection',
  });
  const passed = (scope = 'all') => {
    const value = report(scope);
    const history = createAttempt(candidate, value);
    const logfile = path.join(history.attempt, 'unit.txt');
    fs.writeFileSync(logfile, 'synthetic passed evidence');
    value.steps.push({
      id: 'unit',
      status: 'passed',
      inputHash: 'step',
      log: path.relative(directory, logfile).replaceAll('\\', '/'),
    });
    value.status = scope === 'all' ? 'passed' : 'partial';
    value.finishedAt = value.startedAt;
    value.durationMs = 0;
    history.finish();
    return { history, value };
  };
  return { candidate, report, passed };
}

test('sealed retry may change job scheduling but not source, selection or unit execution', (t) => {
  const f = fixture(t), previous = f.report();
  previous.reusePolicy = POLICY;
  previous.settings = { ...previous.settings, jobs: 2,
    priorityTests: ['tests/example.test.cjs'], priorityBrowserSmoke: true, streamPriority: true };
  const history = createAttempt(f.candidate, previous);
  const log = path.join(history.attempt, 'unit.txt'); fs.writeFileSync(log, 'sealed unit result');
  previous.steps.push({ id: 'unit', status: 'passed', inputHash: 'unit',
    log: path.relative(f.candidate.directory, log).replaceAll('\\', '/') });
  previous.status = 'failed'; history.finish();
  const file = path.join(f.candidate.directory, 'reports/windows/report.json');
  const current = { ...f.report(), reusePolicy: POLICY,
    settings: { ...previous.settings, jobs: 1 } };
  assert.deepEqual(previousAttempt(f.candidate, file, current), previous);
  for (const changed of [
    { sourceHash: 'changed' }, { planHash: 'changed' }, { impactHash: 'changed' },
    { settings: { ...current.settings, unitWorkers: 1 } },
    { settings: { ...current.settings, priorityTests: [] } },
    { settings: { ...current.settings, streamPriority: false } },
    { reusePolicy: undefined },
  ]) assert.equal(previousAttempt(f.candidate, file, { ...current, ...changed }), null);
  fs.appendFileSync(log, ' tampered');
  assert.throws(() => previousAttempt(f.candidate, file, current), /evidence changed/);
});

test('retry preserves runtime identity and exact successful step while excluding only top-level jobs', () => {
  const step = { id: 'unit', args: ['--test', '--test-concurrency=2', 'tests/a.test.cjs'] };
  const environment = { node: '24', os: 'linux', arch: 'x64', osRelease: 'test-os',
    lockHash: 'lock', browsers: { chromium: '1' }, controllerHash: 'controller',
    availableCPUs: 2, unitWorkers: 2, jobs: 2 };
  const previous = { sourceHash: 'source', reusePolicy: POLICY, environment,
    steps: [{ id: 'unit', inputHash: objectHash(step), status: 'passed' }] };
  const current = { ...environment, jobs: 1 };
  assert.equal(reusable(previous, step, current, 'source', POLICY), true);
  for (const changed of [{ node: '25' }, { os: 'win32' }, { arch: 'arm64' },
    { osRelease: 'another-os' }, { lockHash: 'another' }, { browsers: { chromium: '2' } },
    { controllerHash: 'another' }, { unitWorkers: 1 }, { availableCPUs: 4 }])
    assert.equal(reusable(previous, step, { ...current, ...changed }, 'source', POLICY), false);
  assert.equal(reusable(previous, step, current, 'another-source', POLICY), false);
  assert.equal(reusable(previous, { ...step, args: ['changed'] }, current, 'source', POLICY), false);
  previous.steps[0].status = 'timed_out';
  assert.equal(reusable(previous, step, current, 'source', POLICY), false);
});

test('phase reports cannot overwrite full, early, or distributed reports', (t) => {
  const { candidate, report, passed } = fixture(t);
  const full = passed();
  const file = path.join(candidate.directory, 'reports/windows/report.json');
  const before = fs.readFileSync(file, 'utf8');
  for (const phase of ['quality', 'unit', 'browser']) {
    const { history, value } = passed(phase);
    assert.match(history.attempt.replaceAll('\\', '/'), new RegExp('/phases/' + phase + '/'));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(value.status, 'partial');
  }
  assert.match(reportDirectory(candidate, report('precheck')), /early$/);
  assert.match(reportDirectory(candidate, { ...report(), part: 'unit-1' }), /parts[\\/]unit-1$/);
  assert.deepEqual(previousAttempt(candidate, file, report()), full.value);
});

test('finished attempts and input manifests are write-once and survive later runs', (t) => {
  const { candidate, report, passed } = fixture(t);
  const first = passed();
  const manifestFile = path.join(first.history.attempt, 'manifest.json');
  const resultFile = path.join(first.history.attempt, 'report.json');
  const inputs = fs.readFileSync(manifestFile, 'utf8');
  const result = fs.readFileSync(resultFile, 'utf8');
  assert.throws(() => first.history.finish(), /EEXIST/);
  const second = createAttempt(candidate, report(), { resume: true });
  assert.deepEqual(second.previous, first.value);
  assert.notEqual(second.attempt, first.history.attempt);
  second.save();
  assert.equal(fs.readFileSync(manifestFile, 'utf8'), inputs);
  assert.equal(fs.readFileSync(resultFile, 'utf8'), result);
  // A process interrupted before finish has no sealed result and is not reusable.
  assert.equal(
    previousAttempt(
      candidate,
      path.join(candidate.directory, 'reports/windows/report.json'),
      report(),
    ),
    null,
  );
});

test('resume requires exact source, scope, plan, selection, settings and saved evidence', (t) => {
  const { candidate, report, passed } = fixture(t);
  const { value } = passed();
  const file = path.join(candidate.directory, 'reports/windows/report.json');
  for (const changed of [
    { sourceHash: 'other' },
    { candidate: 'other' },
    { target: 'linux' },
    { selectedPhase: 'unit' },
    { planHash: 'different' },
    { selectionHash: 'different' },
    { settings: { jobs: 2, unitWorkers: 2, unitShards: 1 } },
    { impactHash: 'different' },
    { part: 'quality' },
  ])
    assert.equal(previousAttempt(candidate, file, { ...report(), ...changed }), null);
  fs.appendFileSync(path.join(candidate.directory, value.steps[0].log), ' changed');
  assert.throws(() => previousAttempt(candidate, file, report()), /evidence changed/);
});

test('unsealed legacy reports are not reusable and changed summaries are rejected', (t) => {
  const { candidate, report, passed } = fixture(t);
  const { value } = passed();
  const file = path.join(candidate.directory, 'reports/windows/report.json');
  writeJson(file, { ...value, attemptManifestHash: undefined });
  assert.equal(previousAttempt(candidate, file, report()), null);
  writeJson(file, { ...value, error: 'altered summary' });
  assert.throws(() => previousAttempt(candidate, file, report()), /evidence changed/);
});

test('reused evidence still points at the original attempt through multiple resumes', (t) => {
  const { candidate, report, passed } = fixture(t);
  let previous = passed().value;
  const original = previous.steps[0].log;
  for (let i = 0; i < 2; i++) {
    const next = report();
    const history = createAttempt(candidate, next, { resume: true });
    assert.equal(history.previous.steps[0].log, original);
    next.steps.push({ ...previous.steps[0], reused: true, reusedFrom: previous.attempt });
    next.status = 'passed';
    next.finishedAt = next.startedAt;
    next.durationMs = 0;
    history.finish();
    previous = next;
  }
  assert.equal(previous.steps[0].log, original);
});

test('real runner keeps full evidence intact when a diagnostic phase succeeds and resumes', async (t) => {
  const { candidate } = fixture(t);
  const root = candidate.directory;
  const directory = path.join(root, '.release/candidates/synthetic');
  const source = path.join(directory, 'source');
  fs.mkdirSync(path.join(source, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(source, 'tests/example.test.cjs'), "require('node:test')('synthetic',()=>{});");
  fs.writeFileSync(path.join(source, 'package.json'), '{}');
  fs.writeFileSync(path.join(source, 'package-lock.json'), '{}');
  const files = manifest(source);
  writeJson(path.join(directory, 'candidate.json'), {
    version: 1,
    id: 'synthetic',
    files,
    sourceHash: objectHash(files),
  });
  const full = path.join(directory, 'reports/windows/report.json');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, '{"status":"failed","evidence":"keep the full failure"}\n');
  const before = fs.readFileSync(full, 'utf8');
  const processFile = require.resolve('../scripts/release/process.cjs');
  const environmentFile = require.resolve('../scripts/release/environment.cjs');
  const runnerFile = require.resolve('../scripts/release/runner.cjs');
  const originalProcess = require(processFile),
    originalEnvironment = require(environmentFile);
  const previousRunner = require.cache[runnerFile];
  let unitRuns = 0,
    dependencyRuns = 0;
  require.cache[processFile].exports = {
    ...originalProcess,
    npmCli: () => 'synthetic-npm-cli',
    async runProcess(command, args, opts) {
      fs.writeFileSync(opts.log, 'synthetic controlled process');
      if (args.includes('ci')) dependencyRuns++;
      if (args.includes('--test')) {
        unitRuns++;
        fs.mkdirSync(path.join(source, 'work'), { recursive: true });
        const counts = { tests: 1, passed: 1, skipped: 0, failed: 0, cancelled: 0, todo: 0 };
        fs.writeFileSync(path.join(source, 'work/release-unit-events.jsonl'), [
          { type: 'test:summary', file: path.join(source, 'tests/example.test.cjs'), counts },
          { type: 'test:summary', counts },
        ].map(row => JSON.stringify(row)).join('\n') + '\n');
      }
      return { status: 'passed', code: 0, durationMs: 1 };
    },
  };
  require.cache[environmentFile].exports = {
    environment: async (source, target, engines) => {
      assert.deepEqual(engines, [], 'unit-only diagnostics do not launch unrelated browsers');
      return { os: 'win32', node: 'synthetic-node', lockHash: 'synthetic-lock', browsers: {} };
    },
  };
  delete require.cache[runnerFile];
  try {
    const { verify } = require(runnerFile);
    const first = await verify(root, 'synthetic', { target: 'windows', phase: 'unit' });
    assert.equal(first.status, 'partial');
    assert.equal(fs.readFileSync(full, 'utf8'), before);
    const second = await verify(root, 'synthetic', {
      target: 'windows',
      phase: 'unit',
      resume: true,
    });
    assert.equal(second.status, 'partial');
    assert.equal(second.steps.find((s) => s.id === 'unit').reused, true);
    assert.equal(unitRuns, 1);
    assert.equal(dependencyRuns, 2, 'fresh locked dependencies are still mandatory');
    assert.equal(fs.readFileSync(full, 'utf8'), before);
    assert.equal(
      second.steps.find((s) => s.id === 'unit').log,
      first.steps.find((s) => s.id === 'unit').log,
    );
  } finally {
    require.cache[processFile].exports = originalProcess;
    require.cache[environmentFile].exports = originalEnvironment;
    if (previousRunner) require.cache[runnerFile] = previousRunner;
    else delete require.cache[runnerFile];
  }
});
