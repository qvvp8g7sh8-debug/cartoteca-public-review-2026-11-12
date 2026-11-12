const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { steps, testFiles } = require('../scripts/release/plan.cjs');
const { parts } = require('../scripts/release/shards.cjs');
const { assemble, aggregate } = require('../scripts/release/aggregate.cjs');
const { status } = require('../scripts/release/status.cjs');
const { coverage } = require('../scripts/release/browser-report.cjs');
const { manifest, objectHash, controllerHash } = require('../scripts/release/files.cjs');
const { writeJson, readCandidate } = require('../scripts/release/state.cjs');
const { validateUnitEvents } = require('../scripts/release/unit-report.cjs');

function unitEvents(files) {
  const counts = { tests: 1, passed: 1, skipped: 0, failed: 0, cancelled: 0, todo: 0 };
  return [
    ...files.map((file) => ({ type: 'test:summary', file: '/synthetic/source/' + file, counts })),
    { type: 'test:summary', counts: { ...counts, tests: files.length, passed: files.length } },
  ]
    .map((row) => JSON.stringify(row))
    .join('\n');
}
function browserRows(spec) {
  const rows = [];
  for (const [name, minimum] of Object.entries(coverage[spec.suite])) {
    rows.push({
      name,
      engine: spec.engine,
      flowWidth: spec.functionalWidth,
      width: spec.functionalWidth,
      category: 'functional',
      passed: true,
    });
    const n = spec.suite === 'main' && name === 'login' && spec.functionalWidth < 700 ? 3 : minimum;
    for (let i = 0; i < n; i++)
      for (const width of spec.layoutWidths)
        rows.push({
          name: name + '/' + i,
          engine: spec.engine,
          flowWidth: spec.functionalWidth,
          width,
          category: 'appearance',
          passed: true,
        });
  }
  return rows;
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-shards-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const directory = path.join(root, '.release/candidates/synthetic'),
    source = path.join(directory, 'source');
  fs.mkdirSync(path.join(source, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(source, 'scripts/release'), { recursive: true });
  fs.writeFileSync(
    path.join(source, 'scripts/release/unit-timings.json'),
    JSON.stringify({
      targets: {
        windows: { 'tests/a.test.cjs': 1000 },
        linux: { 'tests/b.test.cjs': 2000 },
      },
    }),
  );
  fs.mkdirSync(path.join(root, 'scripts/release'), { recursive: true });
  fs.copyFileSync(
    path.join(source, 'scripts/release/unit-timings.json'),
    path.join(root, 'scripts/release/unit-timings.json'),
  );
  for (const name of ['a', 'b', 'c', 'new', 'e', 'f', 'g', 'h'])
    fs.writeFileSync(path.join(source, 'tests/' + name + '.test.cjs'), '// synthetic');
  const files = manifest(source);
  writeJson(path.join(directory, 'candidate.json'), {
    version: 1,
    id: 'synthetic',
    sourceHash: objectHash(files),
    files,
  });
  return { root, directory, candidate: readCandidate(root, 'synthetic') };
}
function reports(f, target) {
  const plan = steps(f.candidate.source, { target, unitWorkers: 2, unitShards: 4 });
  for (const part of parts(plan)) {
    const prefix = 'reports/' + target + '/parts/' + part.id;
    fs.mkdirSync(path.join(f.directory, prefix), { recursive: true });
    const records = [{ id: 'dependencies', status: 'passed' }];
    for (const step of part.steps) {
      const record = { id: step.id, inputHash: objectHash(step), status: 'passed', durationMs: 10 };
      if (step.unitFiles) {
        record.details = prefix + '/unit.jsonl';
        const text = unitEvents(step.unitFiles);
        fs.writeFileSync(path.join(f.directory, record.details), text);
        record.unitSummary = validateUnitEvents(text, step.unitFiles);
      }
      if (step.browserCoverage) {
        record.details = prefix + '/' + step.id + '.json';
        writeJson(path.join(f.directory, record.details), browserRows(step.browserCoverage));
      }
      records.push(record);
    }
    writeJson(path.join(f.directory, prefix, 'report.json'), {
      version: 2,
      candidate: 'synthetic',
      sourceHash: f.candidate.data.sourceHash,
      target,
      part: part.id,
      status: 'passed',
      selectedPhase: 'all',
      settings: { unitWorkers: 2, unitShards: 4 },
      planHash: objectHash(plan),
      selectionHash: objectHash(part.steps),
      steps: records,
      environment: {
        node: 'v24',
        os: target === 'windows' ? 'win32' : 'linux',
        arch: 'x64',
        lockHash: 'synthetic-lock',
        controllerHash: controllerHash(f.candidate.data.files),
        ...(target === 'linux' ? { caddyHash: 'synthetic-caddy' } : {}),
        browsers: Object.fromEntries(
          part.steps
            .filter((s) => s.browserCoverage)
            .map((s) => [s.browserCoverage.engine, 'synthetic-browser']),
        ),
      },
      startedAt: '2026-10-09T00:00:00.000Z',
      finishedAt: '2026-10-09T00:00:01.000Z',
      durationMs: 1000,
    });
  }
}
function alter(f, part, change) {
  const file = path.join(f.directory, 'reports/linux/parts/' + part + '/report.json');
  const report = JSON.parse(fs.readFileSync(file));
  change(report);
  writeJson(file, report);
}

test('all discovered test files, including unknown timings, occur exactly once in four balanced shards', (t) => {
  const f = fixture(t);
  for (const target of ['windows', 'linux']) {
    const plan = steps(f.candidate.source, { target, unitShards: 4 });
    const files = plan.filter((s) => s.unitFiles).flatMap((s) => s.unitFiles);
    assert.deepEqual(files.sort(), testFiles(f.candidate.source));
    assert.equal(new Set(files).size, files.length);
    assert.equal(parts(plan).length, target === 'windows' ? 7 : 9);
    assert.deepEqual(plan, steps(f.candidate.source, { target, unitShards: 4 }));
  }
});
test('aggregation requires both complete OS reports and revalidates stored evidence at packaging', (t) => {
  const f = fixture(t);
  reports(f, 'windows');
  reports(f, 'linux');
  aggregate(f.root, 'synthetic');
  assert.equal(status(f.root, 'synthetic').readyToPackage, true);
  alter(f, 'unit-1', (report) => {
    report.steps[1].unitSummary.counts.passed = 0;
  });
  assert.equal(status(f.root, 'synthetic').readyToPackage, false);
});
test('missing, duplicate, failed, stale, conflicting and extra parts block release', (t) => {
  const f = fixture(t);
  const changes = [
    (r) => {
      r.steps.pop();
    },
    (r) => {
      r.steps.push(r.steps[1]);
    },
    (r) => {
      r.status = 'failed';
    },
    (r) => {
      r.sourceHash = 'different';
    },
    (r) => {
      r.environment.node = 'different';
    },
    (r) => {
      r.planHash = 'different';
    },
    (r) => {
      r.part = 'unit-2';
    },
    (r) => {
      r.settings.unitShards = 3;
    },
  ];
  for (const change of changes) {
    reports(f, 'linux');
    alter(f, 'unit-1', change);
    assert.throws(() => assemble(f.candidate, 'linux'));
  }
  reports(f, 'linux');
  fs.mkdirSync(path.join(f.directory, 'reports/linux/parts/extra'));
  assert.throws(() => assemble(f.candidate, 'linux'), /unexpected/);
});
test('unit evidence rejects missing files, duplicates, failed totals and changed browser coverage', (t) => {
  const files = ['tests/a.test.cjs', 'tests/b.test.cjs'];
  assert.throws(() => validateUnitEvents(unitEvents(files.slice(0, 1)), files), /Missing/);
  assert.throws(() => validateUnitEvents(unitEvents([files[0], files[0]]), files), /duplicate/);
  assert.throws(
    () => validateUnitEvents(unitEvents(files).replaceAll('"failed":0', '"failed":1'), files),
    /Incomplete/,
  );
  const f = fixture(t);
  reports(f, 'linux');
  alter(f, 'browser-webkit-mobile', (r) => {
    const file = path.join(f.directory, r.steps[1].details);
    const rows = JSON.parse(fs.readFileSync(file));
    rows.pop();
    writeJson(file, rows);
  });
  assert.throws(() => assemble(f.candidate, 'linux'), /Incomplete|Missing/);
});
