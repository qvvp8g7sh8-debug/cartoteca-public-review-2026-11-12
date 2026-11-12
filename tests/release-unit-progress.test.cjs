const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { watchUnitFailures } = require('../scripts/release/unit-progress.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-unit-progress-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return path.join(root, 'events.jsonl');
}

test('failure progress reports only known files, once, without sensitive error messages', async t => {
  const file = fixture(t), seen = [];
  const stop = watchUnitFailures(file, ['tests/known.test.cjs'], row => seen.push(row), { intervalMs: 20 });
  t.after(stop);
  const rows = [
    { type: 'test:fail', file: '/synthetic/tests/foreign.test.cjs', message: 'PRIVATE' },
    { type: 'test:fail', file: 'C:\\synthetic\\tests\\known.test.cjs', message: 'PRIVATE' },
    { type: 'test:summary', file: '/synthetic/tests/known.test.cjs', counts: { failed: 1 } },
  ];
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const end = Date.now() + 2000;while (!seen.length && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(seen.length, 1);assert.equal(seen[0].file, 'tests/known.test.cjs');
  assert.ok(Number.isFinite(Date.parse(seen[0].observedAt)));assert.ok(!JSON.stringify(seen).includes('PRIVATE'));
  stop();stop();
});

test('partial lines are retained until complete and final drain retains late failures', async t => {
  const file = fixture(t), seen = [];
  const stop = watchUnitFailures(file, ['tests/a.test.cjs'], row => seen.push(row), { intervalMs: 20 });
  fs.writeFileSync(file, '{"type":"test:fail","file":"/synthetic/tests/a.test.cjs"');
  await new Promise(resolve => setTimeout(resolve, 60));assert.equal(seen.length, 0);
  fs.appendFileSync(file, '}\n');stop();
  assert.deepEqual(seen.map(row => row.file), ['tests/a.test.cjs']);
});

test('missing logs and successful summaries cannot fabricate an early failure', t => {
  const file = fixture(t), seen = [];
  const stop = watchUnitFailures(file, ['tests/a.test.cjs'], row => seen.push(row));
  fs.writeFileSync(file, JSON.stringify({ type: 'test:summary', file: '/synthetic/tests/a.test.cjs', counts: { failed: 0, cancelled: 0 } }) + '\n');
  stop();assert.deepEqual(seen, []);
  watchUnitFailures(file + '.missing', [], row => seen.push(row))();assert.deepEqual(seen, []);
});
