const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { measuredWeights } = require('../scripts/release/unit-timing-refresh.cjs');
const { splitTests } = require('../scripts/release/shards.cjs');
const { validateUnitEvents } = require('../scripts/release/unit-report.cjs');
const { steps, testFiles } = require('../scripts/release/plan.cjs');

function evidence() {
  const files = ['tests/a.test.cjs', 'tests/z.test.cjs'];
  const counts = { tests: 1, passed: 1, skipped: 0, failed: 0, cancelled: 0, todo: 0 };
  const rows = files.map((file, i) => ({
    type: 'test:summary',
    file: 'C:\\synthetic\\source\\' + file.replaceAll('/', '\\'),
    durationMs: i ? 10000.1 : 100,
    counts,
  }));
  rows.push({ type: 'test:summary', counts: { ...counts, tests: 2, passed: 2 } });
  const text = rows.map((row) => JSON.stringify(row)).join('\n');
  const report = {
    status: 'passed',
    steps: [
      {
        status: 'passed',
        details: 'unit.jsonl',
        unitSummary: validateUnitEvents(text, files),
      },
    ],
  };
  return { files, rows, text, report };
}
test('timing refresh accepts only exact successful file evidence and positive durations', () => {
  const e = evidence();
  const read = () => e.text;
  assert.deepEqual(measuredWeights(e.report, read, e.files), {
    'tests/a.test.cjs': 100,
    'tests/z.test.cjs': 10001,
  });
  assert.throws(() => measuredWeights({ ...e.report, status: 'failed' }, read, e.files));
  assert.throws(() => measuredWeights(e.report, read, [...e.files, 'new.test.cjs']), /inventory/);
  assert.throws(
    () =>
      measuredWeights(
        { ...e.report, steps: [...e.report.steps, ...e.report.steps] },
        read,
        e.files,
      ),
    /Duplicate/,
  );
  for (const durationMs of [0, -1, null]) {
    const rows = structuredClone(e.rows);
    rows[0].durationMs = durationMs;
    assert.throws(
      () =>
        measuredWeights(e.report, () => rows.map((row) => JSON.stringify(row)).join('\n'), e.files),
      /duration/,
    );
  }
  const changed = structuredClone(e.report);
  changed.steps[0].unitSummary.counts.passed = 0;
  assert.throws(() => measuredWeights(changed, read, e.files), /Changed/);
  assert.throws(() =>
    measuredWeights(e.report, () => e.text.replaceAll('"failed":0', '"failed":1'), e.files),
  );
});
test('fresh weights change placement without dropping unknown tests or changing runner semantics', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-timings-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'scripts/release'), { recursive: true });
  const file = path.join(root, 'scripts/release/unit-timings.json');
  const files = ['a.test.cjs', 'b.test.cjs', 'new.test.cjs', 'z.test.cjs'];
  const value = {
    version: 1,
    targets: { windows: { 'a.test.cjs': 100, 'b.test.cjs': 100, 'z.test.cjs': 100 } },
  };
  fs.writeFileSync(file, JSON.stringify(value));
  const previous = splitTests(root, files, 'windows', 2);
  value.version = 2;
  value.targets.windows['z.test.cjs'] = 10000;
  fs.writeFileSync(file, JSON.stringify(value));
  const updated = splitTests(root, files, 'windows', 2);
  assert.notDeepEqual(updated, previous);
  assert.deepEqual(updated.flatMap((s) => s.files).sort(), files);
  assert.deepEqual(updated, splitTests(root, [...files].reverse(), 'windows', 2));
  assert.deepEqual(splitTests(root, files, 'windows', 1)[0].files, files);
});

test('Windows protection gets an exclusive VM without losing file coverage or changing old plans', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-platform-shard-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'scripts/release'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'));
  for (const name of ['a', 'b', 'c', 'd', 'max-setup'])
    fs.writeFileSync(path.join(root, 'tests', name + '.test.cjs'), '// synthetic');
  const file = path.join(root, 'scripts/release/unit-timings.json');
  for (const version of [1, 2, 3]) {
    fs.writeFileSync(file, JSON.stringify({ version, targets: {} }));
    for (const target of ['windows', 'linux']) {
      const units = steps(root, { target, unitShards: 4 }).filter((s) => s.unitFiles);
      assert.deepEqual(units.flatMap((s) => s.unitFiles).sort(), testFiles(root));
      assert.equal(units.length, version === 3 && target === 'windows' ? 5 : 4);
      if (units.length === 5) assert.deepEqual(units[4].unitFiles, ['tests/max-setup.test.cjs']);
    }
  }
});
