const assert = require('node:assert/strict');

function priorityPlan(plan, priorityFiles, browserSmoke, streamPriority = false) {
  assert.equal(typeof streamPriority, 'boolean', 'Invalid priority execution mode');
  assert.ok(Array.isArray(priorityFiles), 'Priority files must be an array');
  assert.equal(new Set(priorityFiles).size, priorityFiles.length, 'Duplicate priority test');
  const units = plan.filter(step => step.id === 'unit');
  assert.equal(units.length, 1, 'Priority execution requires one complete unit source plan');
  const original = units[0];
  const allFiles = original.args.filter(arg => arg.endsWith('.test.cjs'));
  assert.ok(allFiles.length > 0, 'Missing complete unit coverage');
  assert.equal(new Set(allFiles).size, allFiles.length, 'Duplicate complete unit file');
  const known = new Set(allFiles);
  assert.ok(priorityFiles.every(file => known.has(file)), 'Priority file outside complete plan');
  const first = new Set(priorityFiles);
  const remainder = allFiles.filter(file => !first.has(file));
  const header = original.args.filter(arg => !arg.endsWith('.test.cjs'));
  const unit = (name, files, priority) => ({
    ...original,
    id: 'unit-' + name,
    unitFiles: [...files],
    priority,
    args: [
      ...header.map(arg => arg === '--test-reporter-destination=work/release-unit-events.jsonl'
        ? '--test-reporter-destination=work/release-unit-events-' + name + '.jsonl' : arg),
      ...files,
    ],
  });
  const replacements = [];
  if (priorityFiles.length) replacements.push(unit('priority', priorityFiles, true));
  if (remainder.length) replacements.push(unit('remainder', remainder, false));
  const resultingFiles = replacements.flatMap(step => step.unitFiles);
  assert.deepEqual([...resultingFiles].sort(), [...allFiles].sort(), 'Full coverage changed');
  assert.equal(new Set(resultingFiles).size, allFiles.length, 'Unit coverage repeated');
  if (browserSmoke) {
    assert.equal(browserSmoke.id, 'early-browser-time-picker', 'Unknown priority smoke');
    assert.equal(browserSmoke.phase, 'tests', 'Smoke is not a test');
    assert.equal(browserSmoke.command, undefined, 'External smoke command');
    assert.deepEqual(browserSmoke.args, ['scripts/test-time-picker-browser.cjs'], 'Unknown smoke program');
    assert.deepEqual(browserSmoke.earlyBrowser?.widths, [390, 1440], 'Incomplete smoke widths');
    assert.equal(browserSmoke.earlyBrowser?.caseNames?.length, 7, 'Incomplete smoke cases');
    replacements.push({ ...browserSmoke, priority: true });
  }
  const ordered = [...priorityFiles, ...remainder];
  const streamed = [];
  if (streamPriority) {
    const workerFlag = header.find(arg => arg.startsWith('--test-concurrency='));
    assert.ok(workerFlag, 'Missing worker limit');
    const workerCount = workerFlag.slice('--test-concurrency='.length);
    assert.match(workerCount, /^[1-8]$/, 'Invalid worker limit');
    streamed.push({ ...original, unitFiles: ordered,
      args: ['scripts/release/run-ordered-unit.cjs', '--workers', workerCount, ...ordered] },
      ...(browserSmoke ? [{ ...browserSmoke }] : []));
  }
  const result = plan.flatMap(step => step.id === 'unit' ? streamPriority ? streamed : replacements : [step]);
  assert.deepEqual(result.filter(step => step.browserCoverage), plan.filter(step => step.browserCoverage),
    'Full browser matrix changed');
  return result;
}

module.exports = { priorityPlan };
