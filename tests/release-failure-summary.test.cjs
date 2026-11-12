const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { summarizeFailure } = require('../scripts/release/failure-summary.cjs');
const { browserInstallEngines } = require('../scripts/release/plan.cjs');
const encode = (rows) => rows.map((row) => JSON.stringify(row)).join('\n');

test('failure diagnostics list exact files without error text or authorizing a partial release', () => {
  const report = summarizeFailure(
    encode([
      { type: 'test:fail', file: 'C:\\synthetic\\tests\\a.test.cjs', name: 'PRIVATE' },
      { type: 'test:summary', file: '/synthetic/tests/a.test.cjs', counts: { failed: 1 } },
      { type: 'test:summary', file: '/synthetic/tests/b.test.cjs', counts: { failed: 0 } },
      { type: 'test:summary', counts: { failed: 1 } },
    ]),
    ['tests/a.test.cjs', 'tests/b.test.cjs'],
  );
  assert.deepEqual(report.failedFiles, ['tests/a.test.cjs']);
  assert.deepEqual(report.missingFiles, []);
  assert.equal(report.incomplete, false);
  assert.equal(report.fullRequired, true);
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
});

test('crashes, malformed events, unknown files and duplicate summaries stay incomplete', () => {
  for (const text of [
    '',
    '{invalid',
    encode([
      { type: 'test:summary', file: '../private.db', counts: { failed: 1 } },
      { type: 'test:summary' },
    ]),
    encode([
      { type: 'test:summary', file: 'tests/a.test.cjs', counts: { failed: 0 } },
      { type: 'test:summary', file: 'tests/a.test.cjs', counts: { failed: 0 } },
      { type: 'test:summary' },
    ]),
  ]) {
    const report = summarizeFailure(text, ['tests/a.test.cjs', 'tests/b.test.cjs']);
    assert.equal(report.incomplete, true);
    assert.ok(report.missingFiles.includes('tests/b.test.cjs'));
    assert.equal(JSON.stringify(report).includes('private.db'), false);
    assert.equal(report.fullRequired, true);
  }
});

test('cancelled file summaries remain visible as failed files', () => {
  const report = summarizeFailure(
    encode([
      { type: 'test:summary', file: 'tests/a.test.cjs', counts: { failed: 0, cancelled: 1 } },
      { type: 'test:summary' },
    ]),
    ['tests/a.test.cjs'],
  );
  assert.deepEqual(report.failedFiles, ['tests/a.test.cjs']);
});

test('browser machine installs only its selected engine without dropping full coverage', () => {
  assert.deepEqual(browserInstallEngines([{ browserCoverage: { engine: 'webkit' } }]), ['webkit']);
  assert.deepEqual(
    browserInstallEngines([
      { browserCoverage: { engine: 'chromium' } },
      { browserCoverage: { engine: 'chromium' } },
    ]),
    ['chromium'],
  );
  assert.deepEqual(
    browserInstallEngines([
      { browserCoverage: { engine: 'chromium' } },
      { browserCoverage: { engine: 'webkit' } },
    ]),
    ['chromium', 'webkit'],
  );
  assert.deepEqual(browserInstallEngines([]), ['chromium', 'webkit']);
  assert.throws(
    () => browserInstallEngines([{ browserCoverage: { engine: 'unknown' } }]),
    /Unsupported/,
  );
});

test('browser restore and save use identical engine-specific keys for cold caches', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '../.github/workflows/release.yml'),
    'utf8',
  );
  const keys = workflow.match(/key: release-browsers-[^\r\n]+/g);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.ok(
    keys[0].includes("startsWith(matrix.part, 'browser-webkit-') && 'webkit' || 'chromium'"),
  );
  assert.ok(keys[0].includes("hashFiles('package-lock.json')"));
});
