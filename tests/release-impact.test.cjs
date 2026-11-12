const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { impact, earlySteps } = require('../scripts/release/impact.cjs');
const { baseline, recordPublished } = require('../scripts/release/impact-baseline.cjs');
const { manifest, objectHash, copySnapshot } = require('../scripts/release/files.cjs');
const { readCandidate, writeJson } = require('../scripts/release/state.cjs');
const { status } = require('../scripts/release/status.cjs');
const { verify, validateEarlyBrowserReport } = require('../scripts/release/runner.cjs');

function fixture(t, mutate = (files) => files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-impact-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const content = {
    'src/client/modules/provider.js': 'export const value=1;',
    'src/client/modules/caller.js': "import {value} from './provider.js'; export {value};",
    'src/client/styles/clients.css': '.clients{color:blue}',
    'tests/caller.test.cjs': "const text='../src/client/modules/caller.js';",
    'tests/css.test.cjs': '// related DOM test',
    'tests/unrelated.test.cjs': '// unrelated',
    'tests/documentation.test.cjs': '// docs',
    'docs/MODULES.md':
      '| Feature | Sources | Rules | Tests |\n| Clients | src/client/styles/clients.css | STYLES | tests/css.test.cjs |',
  };
  function save(id, files) {
    const directory = path.join(root, '.release/candidates', id),
      source = path.join(directory, 'source');
    fs.mkdirSync(source, { recursive: true });
    for (const [name, value] of Object.entries(files)) {
      const file = path.join(source, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, value);
    }
    const entries = manifest(source);
    writeJson(path.join(directory, 'candidate.json'), {
      version: 1,
      id,
      files: entries,
      sourceHash: objectHash(entries),
      github: { repository: 'qvvp8g7sh8-debug/cartoteca', run: 1, head: 'a'.repeat(40) },
    });
    return readCandidate(root, id);
  }
  const previous = save('previous', content),
    next = save('next', mutate({ ...content }));
  return { root, previous, next, save };
}

test('plan freezes changed, added, removed and unchanged files against an explicit snapshot', (t) => {
  const f = fixture(t, (files) => {
    files['src/client/modules/provider.js'] = 'export const value=2;';
    files['src/client/modules/new.js'] = 'export const newValue=1;';
    delete files['src/client/styles/clients.css'];
    return files;
  });
  const plan = impact(f.root, 'next', { baselineId: 'previous', target: 'windows' });
  assert.deepEqual(
    plan.changes.map((c) => [c.file, c.status]),
    [
      ['src/client/modules/new.js', 'added'],
      ['src/client/modules/provider.js', 'modified'],
      ['src/client/styles/clients.css', 'deleted'],
    ],
  );
  assert.ok(plan.unchanged.includes('tests/unrelated.test.cjs'));
  assert.ok(plan.earlyTests.some((t) => t.file === 'tests/caller.test.cjs'));
  assert.ok(plan.earlyTests.some((t) => t.file === 'tests/css.test.cjs'));
  assert.equal(plan.fullRequired, true);
  assert.equal(plan.readyToPackage, false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.next.directory, 'impact-windows.json'))).planHash,
    plan.planHash,
  );
});

test('deleted providers use the previous graph and keep dependent tests early', (t) => {
  const f = fixture(t, (files) => {
    delete files['src/client/modules/provider.js'];
    return files;
  });
  const plan = impact(f.root, 'next', { baselineId: 'previous' });
  assert.ok(
    plan.earlyTests.some(
      (t) => t.file === 'tests/caller.test.cjs' && t.reasons.includes('previous-source'),
    ),
  );
});

test('new and modified tests are explicitly selected before unchanged tests', (t) => {
  const f = fixture(t, (files) => {
    files['tests/new.test.cjs'] = '// new';
    files['tests/unrelated.test.cjs'] = '// updated';
    return files;
  });
  const plan = impact(f.root, 'next', { baselineId: 'previous' });
  assert.deepEqual(
    plan.earlyTests.map((t) => t.file),
    ['tests/new.test.cjs', 'tests/unrelated.test.cjs'],
  );
  assert.ok(plan.earlyTests.every((t) => t.reasons.includes('changed-test')));
  assert.ok(
    !plan.earlyTests
      .find((t) => t.file === 'tests/new.test.cjs')
      .reasons.includes('previous-source'),
  );
});

test('missing baseline reports uncertainty instead of claiming files stayed unchanged', (t) => {
  const f = fixture(t);
  const plan = impact(f.root, 'next');
  assert.equal(plan.baseline.known, false);
  assert.equal(plan.unchanged.length, 0);
  assert.ok(plan.changes.every((c) => c.status === 'uncompared'));
  assert.equal(plan.fullRequired, true);
});

test('candidate mutation cannot produce an impact plan', (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.next.source, 'src/client/modules/provider.js'),
    'changed after freezing',
  );
  assert.throws(() => impact(f.root, 'next', { baselineId: 'previous' }), /Candidate changed/);
});

test('changed test contracts cannot be deferred by the heuristic budget', (t) => {
  const f = fixture(t, (files) => {
    files['tests/caller.test.cjs'] = '// changed';
    files['tests/css.test.cjs'] = '// changed';
    files['scripts/release/unit-timings.json'] = JSON.stringify({
      targets: { windows: { 'tests/caller.test.cjs': 40000, 'tests/css.test.cjs': 40000 } },
    });
    return files;
  });
  fs.mkdirSync(path.join(f.root, 'scripts/release'), { recursive: true });
  fs.copyFileSync(
    path.join(f.next.source, 'scripts/release/unit-timings.json'),
    path.join(f.root, 'scripts/release/unit-timings.json'),
  );
  const plan = impact(f.root, 'next', { baselineId: 'previous', target: 'windows' });
  assert.ok(plan.deferredTests.includes('tests/documentation.test.cjs'));
  assert.ok(!plan.deferredTests.includes('tests/caller.test.cjs'));
  assert.ok(!plan.deferredTests.includes('tests/css.test.cjs'));
  assert.deepEqual(plan.mandatoryEarlyTests, ['tests/caller.test.cjs', 'tests/css.test.cjs']);
  assert.equal(plan.estimatedSerialMs, 80000);
  assert.equal(plan.earlyTests.length + plan.remainingTests.length, 4);
});

test('a slow direct consumer takes the early budget before a cheaper indirect test', (t) => {
  const f = fixture(t);
  const files = Object.fromEntries(
    Object.keys(f.previous.data.files).map((name) => [
      name,
      fs.readFileSync(path.join(f.previous.source, name), 'utf8'),
    ]),
  );
  files['tests/direct.test.cjs'] = "require('../src/client/modules/provider.js');";
  files['scripts/release/unit-timings.json'] = JSON.stringify({
    targets: {
      windows: { 'tests/direct.test.cjs': 40000, 'tests/caller.test.cjs': 30000 },
    },
  });
  f.save('previous', files);
  f.save('next', { ...files, 'src/client/modules/provider.js': 'export const value=2;' });
  fs.mkdirSync(path.join(f.root, 'scripts/release'), { recursive: true });
  fs.writeFileSync(
    path.join(f.root, 'scripts/release/unit-timings.json'),
    files['scripts/release/unit-timings.json'],
  );
  const plan = impact(f.root, 'next', { baselineId: 'previous', target: 'windows' });
  assert.deepEqual(
    plan.earlyTests.map((t) => t.file),
    ['tests/direct.test.cjs'],
  );
  assert.ok(plan.deferredTests.includes('tests/caller.test.cjs'));
  assert.ok(plan.remainingTests.includes('tests/caller.test.cjs'));
});

test('direct references and explicit module-map contracts remain mandatory beyond sixty seconds', (t) => {
  const f = fixture(t);
  const files = {
    'src/client/modules/direct.js': 'const value=1;',
    'src/client/modules/mapped.js': 'const value=1;',
    'tests/direct.test.cjs': "require('../src/client/modules/direct.js');",
    'tests/mapped.test.cjs': '// loads a factory dynamically',
    'docs/MODULES.md':
      '| Feature | Sources | Rules | Tests |\n| Mapped | src/client/modules/mapped.js | RULES | tests/mapped.test.cjs |',
    'scripts/release/unit-timings.json': JSON.stringify({
      targets: { windows: { 'tests/direct.test.cjs': 45000, 'tests/mapped.test.cjs': 45000 } },
    }),
  };
  f.save('previous', files);
  f.save('next', {
    ...files,
    'src/client/modules/direct.js': 'const value=2;',
    'src/client/modules/mapped.js': 'const value=2;',
  });
  fs.mkdirSync(path.join(f.root, 'scripts/release'), { recursive: true });
  fs.writeFileSync(
    path.join(f.root, 'scripts/release/unit-timings.json'),
    files['scripts/release/unit-timings.json'],
  );
  const plan = impact(f.root, 'next', { baselineId: 'previous', target: 'windows' });
  assert.deepEqual(plan.mandatoryEarlyTests, ['tests/direct.test.cjs', 'tests/mapped.test.cjs']);
  assert.deepEqual(plan.deferredTests, []);
  assert.equal(plan.estimatedSerialMs, 90000);
});

test('time-picker risk map and partial browser smoke survive missing documentation links', (t) => {
  const f = fixture(t);
  const files = {
    'src/client/modules/time-picker.js': '// old picker',
    'tests/appointment-time-picker.test.cjs': '// dynamic factory fixture',
    'tests/time-picker-controls.test.cjs': '// dynamic factory fixture',
    'docs/MODULES.md':
      '| Feature | Sources | Rules | Tests |\n| Time | src/client/modules/time-picker.js | RULES | described without test paths |',
    'scripts/release/unit-timings.json': JSON.stringify({
      targets: {
        windows: {
          'tests/appointment-time-picker.test.cjs': 40000,
          'tests/time-picker-controls.test.cjs': 40000,
        },
      },
    }),
  };
  f.save('previous', files);
  f.save('next', { ...files, 'src/client/modules/time-picker.js': '// new picker' });
  fs.mkdirSync(path.join(f.root, 'scripts/release'), { recursive: true });
  fs.writeFileSync(
    path.join(f.root, 'scripts/release/unit-timings.json'),
    files['scripts/release/unit-timings.json'],
  );
  const plan = impact(f.root, 'next', { baselineId: 'previous', target: 'windows' });
  assert.deepEqual(
    plan.earlyTests.map((row) => row.file),
    ['tests/appointment-time-picker.test.cjs', 'tests/time-picker-controls.test.cjs'],
  );
  assert.ok(plan.earlyTests.every((row) => row.reasons.includes('required-time-picker')));
  assert.equal(plan.earlyBrowser.reportType, 'time-picker-early-smoke');
  assert.deepEqual(plan.earlyBrowser.engines, ['chromium']);
  assert.deepEqual(plan.earlyBrowser.widths, [390, 1440]);
  const selected = earlySteps([], plan, 2);
  const smoke = selected.find((step) => step.id === 'early-browser-time-picker');
  assert.deepEqual(smoke.args, ['scripts/test-time-picker-browser.cjs']);
  assert.equal(smoke.env.CARTOTECA_CHROMIUM_CHANNEL, 'msedge');
  assert.equal(smoke.browserCoverage, undefined);
  assert.equal(plan.fullRequired, true);
  assert.equal(plan.readyToPackage, false);
});

test('time-picker smoke uses both Linux engines and does not expand unrelated UI changes', () => {
  const { timePickerChanged } = require('../scripts/release/risk-tests.cjs');
  for (const source of [
    'time-picker.js',
    'time-picker-source.js',
    'time-picker-fields.js',
    'appointments.js',
  ])
    assert.equal(timePickerChanged(['src/client/modules/' + source]), true);
  assert.equal(timePickerChanged(['src/client/styles/time-picker.css']), true);
  assert.equal(timePickerChanged(['src/client/modules/booking-time.js']), false);
  assert.equal(timePickerChanged(['src/client/styles/editor-design.css']), false);
  const plan = {
    target: 'linux',
    earlyTests: [],
    earlyBrowser: {
      engines: ['chromium', 'webkit'],
      widths: [390, 1440],
      caseNames: ['synthetic'],
      reportType: 'time-picker-early-smoke',
    },
  };
  const smoke = earlySteps([], plan, 2)[0];
  assert.equal(smoke.env.CARTOTECA_BROWSER_ENGINES, 'chromium,webkit');
  assert.equal(smoke.env.CARTOTECA_CHROMIUM_CHANNEL, undefined);
});

function smokeReport(expected) {
  const results = expected.engines.flatMap((engine) =>
    expected.widths.flatMap((width) =>
      expected.caseNames.map((name) => ({ engine, width, name, passed: true })),
    ),
  );
  return {
    schemaVersion: 1,
    reportType: expected.reportType,
    readiness: false,
    complete: true,
    partial: true,
    fullRequired: true,
    engines: expected.engines,
    widths: expected.widths,
    caseNames: expected.caseNames,
    expectedCases: results.length,
    results,
    failures: 0,
  };
}

test('early browser validation rejects missing, duplicate, failed and falsely complete release evidence', () => {
  const expected = {
    reportType: 'time-picker-early-smoke',
    engines: ['chromium', 'webkit'],
    widths: [390, 1440],
    caseNames: ['select', 'dismiss'],
  };
  const report = smokeReport(expected);
  assert.equal(validateEarlyBrowserReport(report, expected).fullRequired, true);
  for (const change of [
    (result) => {
      result.readiness = true;
    },
    (result) => {
      result.partial = false;
    },
    (result) => {
      result.fullRequired = false;
    },
    (result) => {
      result.complete = false;
    },
    (result) => {
      result.results.pop();
    },
    (result) => {
      result.results[1] = { ...result.results[0] };
    },
    (result) => {
      result.results[0].passed = false;
      result.failures = 1;
    },
  ]) {
    const invalid = structuredClone(report);
    change(invalid);
    assert.throws(() => validateEarlyBrowserReport(invalid, expected));
  }
});

function isolatedRunner(plan, runProcess, early = null) {
  const vm = require('node:vm');
  const runnerPath = path.resolve(__dirname, '../scripts/release/runner.cjs');
  const load = require('node:module').createRequire(runnerPath);
  const exported = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(runnerPath, 'utf8'),
    {
      module: exported,
      process,
      console,
      JSON,
      AbortController,
      AbortSignal,
      require(name) {
        // Synthetic parallel plans need a stable CPU budget on quota-limited runners.
        if (name === 'node:os') return { ...load(name), availableParallelism: () => 2 };
        if (name === './plan.cjs') return { steps: () => plan, browserInstallEngines: () => [] };
        if (name === './process.cjs')
          return { ...load(name), runProcess, npmCli: () => 'synthetic-npm' };
        if (name === './environment.cjs')
          return {
            environment: async () => ({
              os: process.platform,
              node: process.version,
              browsers: {},
            }),
          };
        if (name === './impact.cjs') return { impact: () => early, earlySteps: () => plan };
        return load(name);
      },
    },
    { filename: runnerPath },
  );
  return exported.exports.verify;
}

test('streamed priority retry reruns incomplete smoke and retains sealed successful unit evidence', async (t) => {
  const f = fixture(t), files = ['tests/css.test.cjs', 'tests/unrelated.test.cjs'];
  const expected = { reportType: 'time-picker-early-smoke', engines: ['chromium'],
    widths: [390, 1440], caseNames: Array.from({ length: 7 }, (_, i) => 'case-' + i) };
  const smoke = { id: 'early-browser-time-picker', phase: 'tests',
    args: ['scripts/test-time-picker-browser.cjs'], earlyBrowser: expected,
    env: { CARTOTECA_BROWSER_REPORT: 'work/smoke-retry' } };
  const plan = [{ id: 'unit', phase: 'tests', args: ['--test', '--test-concurrency=2', ...files] }, smoke];
  // earlySteps is synthetic here; the base native plan must not already contain smoke.
  const base = plan.filter(step => step !== smoke);
  const runnerPath = path.resolve(__dirname, '../scripts/release/runner.cjs');
  const load = require('node:module').createRequire(runnerPath), exported = { exports: {} };
  const runs = [], counts = { tests: 1, passed: 1, failed: 0, skipped: 0, cancelled: 0, todo: 0 };
  let incomplete = true;
  const runProcess = async (_command, _args, { log, cwd }) => {
    const id = path.basename(log, '.txt'); runs.push(id); fs.writeFileSync(log, 'controlled retry evidence');
    fs.mkdirSync(path.join(cwd, 'work'), { recursive: true });
    if (id === 'unit') {
      const rows = files.map(file => ({ type: 'test:summary', file: path.join(cwd, file), counts }));
      rows.push({ type: 'test:summary', counts: { ...counts, tests: 2, passed: 2 } });
      fs.writeFileSync(path.join(cwd, 'work/release-unit-events.jsonl'), rows.map(JSON.stringify).join('\n') + '\n');
    }
    if (id === smoke.id) {
      const results = expected.engines.flatMap(engine => expected.widths.flatMap(width =>
        expected.caseNames.map(name => ({ engine, width, name, passed: true }))));
      if (incomplete) results.pop();
      fs.mkdirSync(path.join(cwd, 'work/smoke-retry'), { recursive: true });
      writeJson(path.join(cwd, 'work/smoke-retry/results.json'), { schemaVersion: 1, ...expected,
        readiness: false, partial: true, fullRequired: true, complete: !incomplete,
        expectedCases: 14, failures: 0, results });
      return { status: incomplete ? 'timed_out' : 'passed', code: incomplete ? null : 0, durationMs: 1 };
    }
    return { status: 'passed', code: 0, durationMs: 1 };
  };
  require('node:vm').runInNewContext(fs.readFileSync(runnerPath, 'utf8'), {
    module: exported, process, console, JSON, AbortController, AbortSignal,
    require(name) {
      if (name === './plan.cjs') return { steps: () => base, browserInstallEngines: () => [] };
      if (name === './process.cjs') return { ...load(name), runProcess, npmCli: () => 'synthetic-npm' };
      if (name === './environment.cjs') return { environment: async () => ({ os: process.platform,
        node: process.version, browsers: {} }) };
      if (name === './impact.cjs') return { impact: () => ({ planHash: 'retry-impact',
        earlyTests: [{ file: files[0] }] }), earlySteps: () => [smoke] };
      return load(name);
    },
  }, { filename: runnerPath });
  const opts = { target: process.platform === 'win32' ? 'windows' : 'linux',
    priority: true, streamPriority: true, jobs: 2 };
  const first = await exported.exports.verify(f.root, 'next', opts);
  assert.equal(first.status, 'failed');
  const unit = first.steps.find(step => step.id === 'unit');
  assert.equal(unit.status, 'passed');
  const original = fs.readFileSync(path.join(f.next.directory, unit.details), 'utf8');
  incomplete = false;
  const second = await exported.exports.verify(f.root, 'next', { ...opts, jobs: 1, resume: true });
  assert.equal(second.status, 'passed');
  assert.equal(second.steps.find(step => step.id === 'unit').reused, true);
  assert.equal(second.steps.find(step => step.id === smoke.id).reused, undefined);
  assert.equal(runs.filter(id => id === 'unit').length, 1);
  assert.equal(runs.filter(id => id === smoke.id).length, 2);
  assert.equal(runs.filter(id => id === 'dependencies').length, 2);
  assert.equal(fs.readFileSync(path.join(f.next.directory, unit.details), 'utf8'), original);
  assert.equal(fs.existsSync(path.join(f.next.directory, 'operation.lock')), false);
});

test('ordinary quality and test failures retain all later independent results', async (t) => {
  const f = fixture(t),
    executed = [];
  const plan = [
    { id: 'quality-a', phase: 'quality', args: ['quality-a'] },
    { id: 'quality-b', phase: 'quality', args: ['quality-b'] },
    { id: 'test-a', phase: 'tests', args: ['test-a'] },
    { id: 'test-b', phase: 'tests', args: ['test-b'] },
  ];
  const run = isolatedRunner(plan, async (_command, args, { log }) => {
    const id = path.basename(log, '.txt');
    executed.push(id);
    fs.writeFileSync(log, 'synthetic result');
    const failed = args[0] === 'quality-a' || args[0] === 'test-a';
    return { status: failed ? 'failed' : 'passed', code: failed ? 1 : 0, durationMs: 1 };
  });
  const result = await run(f.root, 'next', {
    target: process.platform === 'win32' ? 'windows' : 'linux',
    jobs: 1,
  });
  assert.equal(result.status, 'failed');
  assert.ok(executed.includes('quality-b'));
  assert.ok(executed.includes('test-b'));
  assert.deepEqual(
    Array.from(
      result.steps.filter((step) => step.status === 'failed'),
      (step) => step.id,
    ),
    ['quality-a', 'test-a'],
  );
  assert.equal(fs.existsSync(path.join(f.next.directory, 'operation.lock')), false);
});

test('priority failures still execute all remaining unit files and independent browser groups', async (t) => {
  const f = fixture(t), executed = [];
  const plan = [
    { id: 'unit', phase: 'tests', args: ['--test', 'tests/css.test.cjs', 'tests/unrelated.test.cjs'] },
    { id: 'browser-independent', phase: 'tests', args: ['browser-independent'] },
  ];
  const run = isolatedRunner(plan, async (_command, _args, { log }) => {
    const id = path.basename(log, '.txt');
    executed.push(id);
    fs.writeFileSync(log, 'synthetic failure to verify collection');
    const failed = id.startsWith('unit-');
    return { status: failed ? 'failed' : 'passed', code: failed ? 1 : 0, durationMs: 1 };
  }, { planHash: 'synthetic-impact', earlyTests: [{ file: 'tests/css.test.cjs' }] });
  const result = await run(f.root, 'next', {
    target: process.platform === 'win32' ? 'windows' : 'linux', priority: true, jobs: 1,
  });
  assert.equal(result.status, 'failed');
  assert.ok(executed.indexOf('unit-priority') < executed.indexOf('unit-remainder'));
  assert.ok(executed.includes('browser-independent'));
  assert.deepEqual(Array.from(result.steps.filter(row => row.status === 'failed'), row => row.id),
    ['unit-priority', 'unit-remainder']);
  assert.equal(status(f.root, 'next').readyToPackage, false);
  assert.equal(fs.existsSync(path.join(f.next.directory, 'operation.lock')), false);
});

test('priority readiness binds the complete plan to its unchanged impact evidence', (t) => {
  const { priorityPlan } = require('../scripts/release/priority-plan.cjs');
  const { steps } = require('../scripts/release/plan.cjs');
  const { controllerHash } = require('../scripts/release/files.cjs');
  const f = fixture(t, files => ({ ...files, 'src/client/modules/provider.js': 'export const value=2;' }));
  for (const target of ['windows', 'linux']) {
    const evidence = impact(f.root, 'next', { baselineId: 'previous', target });
    const original = steps(f.next.source, { target, unitWorkers: 2 });
    const files = evidence.earlyTests.map(row => row.file);
    const smoke = earlySteps(original, evidence, 2).find(step => step.earlyBrowser);
    const plan = priorityPlan(original, files, smoke);
    fs.mkdirSync(path.join(f.next.directory, 'reports', target), { recursive: true });
    writeJson(path.join(f.next.directory, 'reports', target, 'report.json'), {
      version: 1, candidate: 'next', sourceHash: f.next.data.sourceHash, target,
      environment: { os: target === 'windows' ? 'win32' : 'linux', controllerHash: controllerHash(f.next.data.files) },
      settings: { unitWorkers: 2, priorityTests: files, priorityBrowserSmoke: Boolean(smoke) },
      impactHash: evidence.planHash, planHash: objectHash(plan), status: 'passed',
      steps: plan.map(step => ({ id: step.id, inputHash: objectHash(step), status: 'passed' })),
    });
  }
  assert.equal(status(f.root, 'next').readyToPackage, true);
  const proofFile = path.join(f.next.directory, 'impact-windows.json');
  const proof = fs.readFileSync(proofFile);
  fs.unlinkSync(proofFile);
  assert.equal(status(f.root, 'next').targets.windows.status, 'not_passed');
  fs.writeFileSync(proofFile, proof);
  const tampered = JSON.parse(proof);tampered.earlyTests = [];
  writeJson(proofFile, tampered);
  assert.equal(status(f.root, 'next').targets.windows.status, 'not_passed');
  fs.writeFileSync(proofFile, proof);
  const reportFile = path.join(f.next.directory, 'reports/windows/report.json');
  const report = JSON.parse(fs.readFileSync(reportFile));
  report.steps = report.steps.filter(step => step.id !== 'unit-remainder');
  writeJson(reportFile, report);
  assert.equal(status(f.root, 'next').readyToPackage, false);
});

test('ordinary full unit evidence records an exact file inventory for timing refresh', async (t) => {
  const f = fixture(t), files = ['tests/css.test.cjs', 'tests/unrelated.test.cjs'];
  const counts = { tests: 1, passed: 1, failed: 0, skipped: 0, cancelled: 0, todo: 0 };
  const plan = [{ id: 'unit', phase: 'tests', args: ['--test', ...files] }];
  const run = isolatedRunner(plan, async (_command, _args, { log, cwd }) => {
    fs.writeFileSync(log, 'synthetic full unit result');
    if (path.basename(log) === 'unit.txt') {
      const rows = files.map(file => ({ type: 'test:summary', file: path.join(cwd, file), counts }));
      rows.push({ type: 'test:summary', counts: { ...counts, tests: 2, passed: 2 } });
      fs.mkdirSync(path.join(cwd, 'work'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'work/release-unit-events.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
    }
    return { status: 'passed', code: 0, durationMs: 1 };
  });
  const result = await run(f.root, 'next', { target: process.platform === 'win32' ? 'windows' : 'linux' });
  assert.equal(result.status, 'passed');
  assert.deepEqual(Array.from(result.steps.find(step => step.id === 'unit').unitSummary.files), files);
  assert.equal(result.steps.find(step => step.id === 'unit').unitSummary.counts.tests, 2);
});

test('streaming publishes a known early failure before the complete unit process ends', async (t) => {
  const f = fixture(t), files = ['tests/css.test.cjs', 'tests/unrelated.test.cjs'];
  const plan = [{ id: 'unit', phase: 'tests', args: ['--test', '--test-concurrency=2', ...files] },
    { id: 'independent-browser', phase: 'tests', args: ['synthetic-browser'] }];
  const target = process.platform === 'win32' ? 'windows' : 'linux';
  let observedBeforeEnd = false;
  const run = isolatedRunner(plan, async (_command, _args, { log, cwd }) => {
    fs.writeFileSync(log, 'synthetic run');
    if (path.basename(log) !== 'unit.txt') return { status: 'passed', code: 0, durationMs: 1 };
    const rows = [
      { type: 'test:fail', file: path.join(cwd, files[0]), name: 'synthetic assertion' },
      { type: 'test:summary', file: path.join(cwd, files[0]), counts: { tests: 1, failed: 1, passed: 0, cancelled: 0, skipped: 0, todo: 0 } },
      { type: 'test:summary', file: path.join(cwd, files[1]), counts: { tests: 1, failed: 0, passed: 1, cancelled: 0, skipped: 0, todo: 0 } },
      { type: 'test:summary', counts: { tests: 2, failed: 1, passed: 1, cancelled: 0, skipped: 0, todo: 0 } },
    ];
    fs.mkdirSync(path.join(cwd, 'work'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'work/release-unit-events.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const end = Date.now() + 3500;
    while (Date.now() < end) {
      const live = JSON.parse(fs.readFileSync(path.join(f.next.directory, 'reports', target, 'report.json')));
      if (live.earlyFailures?.length) { observedBeforeEnd = live.steps.find(step => step.id === 'unit').status === 'running';break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return { status: 'failed', code: 1, durationMs: 1 };
  }, { planHash: 'synthetic-impact', earlyTests: [{ file: files[0] }] });
  const result = await run(f.root, 'next', { target, priority: true, streamPriority: true, jobs: 2 });
  assert.equal(observedBeforeEnd, true);assert.equal(result.status, 'failed');
  assert.equal(result.earlyFailures[0].file, files[0]);
  assert.ok(Date.parse(result.earlyFailures[0].observedAt) < Date.parse(result.finishedAt));
  assert.equal(result.steps.find(step => step.id === 'independent-browser').status, 'passed');
});

test('streamed readiness rejects a changed execution mode and a missing complete unit step', (t) => {
  const { priorityPlan } = require('../scripts/release/priority-plan.cjs');
  const { steps } = require('../scripts/release/plan.cjs');
  const { controllerHash } = require('../scripts/release/files.cjs');
  const f = fixture(t, files => ({ ...files, 'src/client/modules/provider.js': 'export const value=3;' }));
  for (const target of ['windows', 'linux']) {
    const evidence = impact(f.root, 'next', { baselineId: 'previous', target });
    const original = steps(f.next.source, { target, unitWorkers: 2 }), files = evidence.earlyTests.map(row => row.file);
    const smoke = earlySteps(original, evidence, 2).find(step => step.earlyBrowser);
    const plan = priorityPlan(original, files, smoke, true);
    fs.mkdirSync(path.join(f.next.directory, 'reports', target), { recursive: true });
    writeJson(path.join(f.next.directory, 'reports', target, 'report.json'), {
      version: 1, candidate: 'next', sourceHash: f.next.data.sourceHash, target, status: 'passed',
      settings: { unitWorkers: 2, priorityTests: files, priorityBrowserSmoke: Boolean(smoke), streamPriority: true },
      environment: { os: target === 'windows' ? 'win32' : 'linux', controllerHash: controllerHash(f.next.data.files) },
      impactHash: evidence.planHash, planHash: objectHash(plan),
      steps: plan.map(step => ({ id: step.id, inputHash: objectHash(step), status: 'passed' })),
    });
  }
  assert.equal(status(f.root, 'next').readyToPackage, true);
  const file = path.join(f.next.directory, 'reports/windows/report.json'), original = fs.readFileSync(file);
  const report = JSON.parse(original);report.settings.streamPriority = false;writeJson(file, report);
  assert.equal(status(f.root, 'next').readyToPackage, false);
  const missing = JSON.parse(original);missing.steps = missing.steps.filter(step => step.id !== 'unit');writeJson(file, missing);
  assert.equal(status(f.root, 'next').readyToPackage, false);
});

test('snapshot integrity failure stops serial work and cancels running parallel tests', async (t) => {
  for (const phase of ['quality', 'tests']) {
    const f = fixture(t),
      executed = [];
    let inFlightCancelled = false;
    const plan = ['mutate-source', 'in-flight', 'never-started'].map((id) => ({
      id,
      phase,
      args: [id],
    }));
    const run = isolatedRunner(plan, async (_command, args, { log, cwd, signal }) => {
      const id = path.basename(log, '.txt');
      executed.push(id);
      fs.writeFileSync(log, 'synthetic result');
      if (args[0] === 'mutate-source')
        fs.writeFileSync(path.join(cwd, 'src/client/modules/provider.js'), 'changed inside a test');
      if (args[0] === 'in-flight')
        return new Promise((resolve) => {
          const cancel = () => {
            inFlightCancelled = true;
            resolve({ status: 'cancelled', code: null, durationMs: 1 });
          };
          if (signal.aborted) cancel();
          else signal.addEventListener('abort', cancel, { once: true });
        });
      return { status: 'passed', code: 0, durationMs: 1 };
    });
    const result = await run(f.root, 'next', {
      target: process.platform === 'win32' ? 'windows' : 'linux',
      jobs: phase === 'quality' ? 1 : 2,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.failureKind, 'snapshot-integrity');
    assert.match(result.error, /Candidate changed/);
    const failed = result.steps.find((step) => step.id === 'mutate-source');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureKind, 'snapshot-integrity');
    assert.match(failed.error, /Candidate changed/);
    assert.ok(failed.finishedAt);
    assert.equal(executed.includes('never-started'), false);
    assert.equal(executed.includes('in-flight'), phase === 'tests');
    assert.equal(inFlightCancelled, phase === 'tests');
    assert.equal(fs.existsSync(path.join(f.next.directory, 'operation.lock')), false);
    const saved = JSON.parse(
      fs.readFileSync(path.join(f.next.directory, result.attempt, 'report.json')),
    );
    assert.equal(saved.failureKind, 'snapshot-integrity');
    assert.equal(saved.status, 'failed');
  }
});

test('invalid early smoke details are preserved while later tests continue and readiness stays partial', async (t) => {
  const f = fixture(t),
    executed = [];
  const expected = {
    reportType: 'time-picker-early-smoke',
    engines: ['chromium'],
    widths: [390],
    caseNames: ['synthetic'],
  };
  const plan = [
    {
      id: 'early-browser-time-picker',
      phase: 'tests',
      args: ['synthetic-smoke'],
      earlyBrowser: expected,
      env: { CARTOTECA_BROWSER_REPORT: 'work/release-time-picker-smoke' },
    },
    { id: 'independent-last', phase: 'tests', args: ['independent-last'] },
  ];
  const run = isolatedRunner(
    plan,
    async (_command, args, { log, cwd, env }) => {
      const id = path.basename(log, '.txt');
      executed.push(id);
      fs.writeFileSync(log, 'synthetic result');
      if (args[0] === 'synthetic-smoke') {
        const output = path.join(cwd, env.CARTOTECA_BROWSER_REPORT, 'results.json');
        fs.mkdirSync(path.dirname(output), { recursive: true });
        const invalid = smokeReport(expected);
        invalid.readiness = true;
        fs.writeFileSync(output, JSON.stringify(invalid));
      }
      return { status: 'passed', code: 0, durationMs: 1 };
    },
    { planHash: 'synthetic-impact' },
  );
  const result = await run(f.root, 'next', {
    target: process.platform === 'win32' ? 'windows' : 'linux',
    precheck: true,
    jobs: 1,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.partial, true);
  assert.equal(result.fullRequired, true);
  assert.equal(result.readyToPackage, false);
  assert.ok(executed.includes('independent-last'));
  const smoke = result.steps.find((step) => step.id === 'early-browser-time-picker');
  assert.equal(smoke.status, 'failed');
  assert.match(smoke.error, /release readiness/);
  assert.equal(fs.existsSync(path.join(f.next.directory, smoke.details)), true);
});

test('successful early browser evidence is partial and cannot qualify a full release', async (t) => {
  const f = fixture(t);
  const expected = {
    reportType: 'time-picker-early-smoke',
    engines: ['chromium'],
    widths: [390, 1440],
    caseNames: ['synthetic'],
  };
  const plan = [
    {
      id: 'early-browser-time-picker',
      phase: 'tests',
      args: ['synthetic-smoke'],
      earlyBrowser: expected,
      env: { CARTOTECA_BROWSER_REPORT: 'work/release-time-picker-smoke' },
    },
  ];
  const run = isolatedRunner(
    plan,
    async (_command, args, { log, cwd, env }) => {
      fs.writeFileSync(log, 'synthetic result');
      if (args[0] === 'synthetic-smoke') {
        const output = path.join(cwd, env.CARTOTECA_BROWSER_REPORT, 'results.json');
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, JSON.stringify(smokeReport(expected)));
      }
      return { status: 'passed', code: 0, durationMs: 1 };
    },
    { planHash: 'synthetic-impact' },
  );
  const result = await run(f.root, 'next', {
    target: process.platform === 'win32' ? 'windows' : 'linux',
    precheck: true,
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.partial, true);
  assert.equal(result.fullRequired, true);
  assert.equal(result.readyToPackage, false);
  assert.equal(
    result.steps.find((step) => step.earlyBrowserSummary).earlyBrowserSummary.expectedCases,
    2,
  );
  assert.equal(status(f.root, 'next').readyToPackage, false);
});

test('shared-save risk gates stay early beyond the heuristic budget with explicit source reasons', (t) => {
  const f = fixture(t);
  const names = [
    'async-write-lock',
    'platform-write-fence',
    'shared-mutation-effects',
    'cabinet-preparation-policy',
    'mutation-receipts',
    'cabinet-store',
    'async-workflows',
    'appointment-outcomes',
    'classic-booking-recovery',
  ].map((name) => 'tests/' + name + '.test.cjs');
  const changed = 'src/server/modules/cabinet/mutations.cjs';
  const files = {
    'package.json': '{}',
    [changed]: '// previous shared command',
    ...Object.fromEntries(names.map((name) => [name, '// existing synthetic test'])),
    'scripts/release/unit-timings.json': JSON.stringify({
      targets: { windows: Object.fromEntries(names.map((name) => [name, 30000])) },
    }),
  };
  f.save('previous', files);
  f.save('next', { ...files, [changed]: '// changed shared command' });
  fs.mkdirSync(path.join(f.root, 'scripts/release'), { recursive: true });
  fs.writeFileSync(
    path.join(f.root, 'scripts/release/unit-timings.json'),
    files['scripts/release/unit-timings.json'],
  );
  const plan = impact(f.root, 'next', { baselineId: 'previous', target: 'windows' });
  assert.deepEqual([...plan.requiredRiskTests].sort(), [...names].sort());
  assert.deepEqual(plan.earlyTests.map((row) => row.file).sort(), [...names].sort());
  assert.equal(plan.estimatedSerialMs, names.length * 30000);
  for (const row of plan.earlyTests) {
    assert.ok(row.reasons.includes('required-save-risk'));
    assert.ok(row.reasons.includes('risk-source:' + changed));
  }
  assert.equal(plan.fullRequired, true);
  assert.equal(plan.readyToPackage, false);
});

test('risk gates do not turn unrelated presentation changes into shared-save checks', () => {
  const { riskTests } = require('../scripts/release/risk-tests.cjs');
  const available = [
    'tests/appointment-outcomes.test.cjs',
    'tests/classic-booking-recovery.test.cjs',
  ];
  assert.equal(riskTests(['src/client/styles/editor-design.css'], available).size, 0);
  assert.deepEqual(
    [...riskTests(['src/server/modules/booking/classic-receipts.cjs'], available).keys()],
    ['tests/classic-booking-recovery.test.cjs'],
  );
});

test('early success never qualifies packaging and cannot overwrite full reports', (t) => {
  const f = fixture(t);
  const report = path.join(f.next.directory, 'reports/windows/early/report.json');
  fs.mkdirSync(path.dirname(report), { recursive: true });
  writeJson(report, { status: 'passed', sourceHash: f.next.data.sourceHash });
  assert.equal(status(f.root, 'next').readyToPackage, false);
});

test('new required tests retain measured median cost even when their budget is exceeded', (t) => {
  const f = fixture(t, (files) => {
    files['scripts/release/unit-timings.json'] = JSON.stringify({
      targets: { windows: { 'tests/caller.test.cjs': 20000 } },
    });
    for (let index = 0; index < 8; index++) files['tests/new-' + index + '.test.cjs'] = '// new';
    return files;
  });
  fs.mkdirSync(path.join(f.root, 'scripts/release'), { recursive: true });
  fs.copyFileSync(
    path.join(f.next.source, 'scripts/release/unit-timings.json'),
    path.join(f.root, 'scripts/release/unit-timings.json'),
  );
  const plan = impact(f.root, 'next', { baselineId: 'previous', target: 'windows' });
  assert.equal(plan.earlyTests.length, 8);
  assert.equal(plan.estimatedSerialMs, 160000);
  assert.equal(plan.deferredTests.filter((file) => file.startsWith('tests/new-')).length, 0);
  assert.equal(plan.fullRequired, true);
  assert.equal(plan.readyToPackage, false);
});

test('precheck rejects incompatible distributed or resumed modes before running anything', async (t) => {
  const f = fixture(t);
  for (const opts of [{ part: 'unit-1' }, { unitShards: 4 }, { resume: true }, { phase: 'unit' }])
    await assert.rejects(
      verify(f.root, 'next', { target: 'windows', precheck: true, ...opts }),
      /Precheck cannot/,
    );
});

test('published baseline advances only after a completed inactive publication', (t) => {
  const f = fixture(t);
  for (const result of [
    { status: 'failed', published: false, active: false },
    { status: 'completed', published: true, active: true },
  ])
    assert.equal(recordPublished(f.root, 'next', result), false);
  assert.equal(fs.existsSync(path.join(f.root, 'release-baseline.json')), false);
  assert.equal(
    recordPublished(f.root, 'next', { status: 'completed', published: true, active: false }),
    true,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.root, 'release-baseline.json'))).sourceHash,
    f.next.data.sourceHash,
  );
});

test('CLI prepares a clean snapshot without an installed dependency tree', (t) => {
  const f = fixture(t);
  copySnapshot(path.resolve(__dirname, '..'), f.root);
  assert.equal(fs.existsSync(path.join(f.root, 'node_modules')), false);
  const run = (args) =>
    JSON.parse(
      execFileSync(process.execPath, ['scripts/release.cjs', ...args], {
        cwd: f.root,
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, NODE_PATH: '', GITHUB_OUTPUT: '' },
      }),
    );
  assert.equal(run(['plan']).executes, false);
  assert.ok(run(['matrix']).include.some((part) => part.target === 'linux'));
  const result = run(['prepare', '--id', 'cold-cli']);
  assert.equal(result.state, 'prepared');
  // Architecture and documentation unit checks use this same default contract.
  const coldSource = path.join(f.root, '.release/candidates/cold-cli/source');
  const coldDocs = require(path.join(coldSource, 'scripts/check-docs.cjs'));
  assert.ok(coldDocs.checkDocumentation(coldSource).moduleCount >= 30);
  assert.equal(
    fs.existsSync(path.join(f.root, '.release/candidates/cold-cli/source/node_modules')),
    false,
  );
});

test('CI loads the exact published Git tree in a single batch and rejects a changed hash', (t) => {
  const f = fixture(t);
  const git = (args) =>
    execFileSync(
      'git',
      [
        '-c',
        'core.autocrlf=false',
        '-c',
        'user.name=Synthetic',
        '-c',
        'user.email=synthetic@example.invalid',
        ...args,
      ],
      { cwd: f.previous.source, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
  git(['init', '--template=']);
  git(['add', '.']);
  git(['commit', '-m', 'Synthetic baseline']);
  const sha = git(['rev-parse', 'HEAD']);
  const record = {
    version: 1,
    candidate: 'unavailable-locally',
    sourceHash: f.previous.data.sourceHash,
    commit: sha,
  };
  fs.writeFileSync(path.join(f.next.source, 'release-baseline.json'), JSON.stringify(record));
  const base = baseline(f.previous.source, f.next);
  assert.equal(base.known, true);
  assert.equal(base.origin, 'published-git');
  assert.deepEqual(base.files, f.previous.data.files);
  record.sourceHash = '0'.repeat(64);
  fs.writeFileSync(path.join(f.next.source, 'release-baseline.json'), JSON.stringify(record));
  assert.equal(baseline(f.previous.source, f.next).known, false);
});
