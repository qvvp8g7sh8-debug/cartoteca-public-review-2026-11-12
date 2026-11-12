const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { run } = require('node:test');
const { spec } = require('node:test/reporters');
const reporter = require('./test-reporter.cjs');
const { testFiles } = require('./plan.cjs');

async function runOrderedUnit(root, files, workers) {
  assert.ok(Number.isInteger(workers) && workers >= 1 && workers <= 8, 'Invalid unit worker limit');
  assert.deepEqual([...files].sort(), testFiles(root), 'Ordered execution requires the exact full test inventory');
  const work = path.join(root, 'work');fs.mkdirSync(work, { recursive: true });
  assert.ok(!fs.lstatSync(work).isSymbolicLink(), 'Linked unit report directory');
  const output = fs.createWriteStream(path.join(work, 'release-unit-events.jsonl'), { flags: 'wx' });
  const source = run({ files: files.map(file => path.join(root, file)), concurrency: workers, isolation: 'process' });
  const human = new PassThrough({ objectMode: true }), machine = new PassThrough({ objectMode: true });
  let failed = false, counts;
  source.on('test:fail', () => { failed = true; });
  source.on('test:summary', row => { if (!row.file) counts = row.counts; });
  source.pipe(human);source.pipe(machine);
  await Promise.all([
    pipeline(human, new spec(), process.stdout, { end: false }),
    pipeline(machine, reporter, output),
  ]);
  assert.ok(counts, 'Missing complete ordered-unit summary');
  return { failed, counts };
}

module.exports = { runOrderedUnit };
if (require.main === module) {
  const [flag, count, ...files] = process.argv.slice(2);
  if (flag !== '--workers') throw Error('Use --workers <count> <complete test inventory>');
  runOrderedUnit(path.resolve(__dirname, '../..'), files, Number(count)).then(result => {
    process.exitCode = result.failed ? 1 : 0;
  }).catch(error => { console.error(error.message);process.exitCode = 1; });
}
