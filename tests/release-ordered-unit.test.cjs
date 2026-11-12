const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { validateUnitEvents } = require('../scripts/release/unit-report.cjs');
const { runOrderedUnit } = require('../scripts/release/run-ordered-unit.cjs');

function fixture(t, failed = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-ordered-unit-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir()));fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, 'tests'));
  const journal = path.join(root, 'order.jsonl');
  for (const id of ['a', 'b', 'c']) fs.writeFileSync(path.join(root, 'tests', id + '.test.cjs'),
    `const test=require('node:test'),assert=require('node:assert/strict');
test('${id}',()=>{assert.equal(globalThis.priorFixture,undefined);globalThis.priorFixture='${id}';
require('node:fs').appendFileSync(${JSON.stringify(journal)},'${id}\\n');assert.equal(${failed.includes(id)},false);});`);
  const files = ['c', 'a', 'b'].map(id => 'tests/' + id + '.test.cjs');
  const adapter = path.resolve(__dirname, '../scripts/release/run-ordered-unit.cjs');
  const driver = path.join(root, 'driver.cjs');
  fs.writeFileSync(driver, `require(${JSON.stringify(adapter)}).runOrderedUnit(${JSON.stringify(root)},${JSON.stringify(files)},1)
.then(result=>process.exitCode=result.failed?1:0).catch(error=>{console.error(error);process.exitCode=2;});`);
  return { root, journal, files, driver };
}

function execute(f) {
  const env = { ...process.env };delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [f.driver], { env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
}

test('actual ordered runner preserves requested priority and per-file process isolation', t => {
  const f = fixture(t), result = execute(f);assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(fs.readFileSync(f.journal, 'utf8').trim().split('\n'), ['c', 'a', 'b']);
  const proof = validateUnitEvents(fs.readFileSync(path.join(f.root, 'work/release-unit-events.jsonl'), 'utf8'), f.files);
  assert.equal(proof.files.length, 3);assert.equal(proof.counts.tests, 3);assert.equal(proof.counts.passed, 3);
});

test('ordered runner retains every failing file and finishes later independent files', t => {
  const f = fixture(t, ['a', 'c']), result = execute(f);assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(fs.readFileSync(f.journal, 'utf8').trim().split('\n'), ['c', 'a', 'b']);
  const rows = fs.readFileSync(path.join(f.root, 'work/release-unit-events.jsonl'), 'utf8').trim().split('\n').map(row => JSON.parse(row));
  const total = rows.find(row => row.type === 'test:summary' && !row.file).counts;
  assert.equal(total.tests, 3);assert.equal(total.failed, 2);assert.equal(total.passed, 1);
});

test('ordered runner rejects missing, duplicate, foreign files and invalid worker counts', async t => {
  const f = fixture(t);
  for (const files of [f.files.slice(1), [...f.files, f.files[0]], [...f.files.slice(1), '../foreign.test.cjs']])
    await assert.rejects(runOrderedUnit(f.root, files, 1), /exact full test inventory/);
  await assert.rejects(runOrderedUnit(f.root, f.files, 0), /Invalid unit worker/);
  assert.equal(fs.existsSync(path.join(f.root, 'work')), false);
});
