const fs = require('node:fs');
const path = require('node:path');
const { readCandidate, writeJson } = require('./state.cjs');
const { status } = require('./status.cjs');
const { safePath } = require('./files.cjs');
const { testFiles } = require('./plan.cjs');
const { validateUnitEvents } = require('./unit-report.cjs');

function measuredWeights(report, read, expected) {
  if (report.status !== 'passed') throw Error('Successful verification required');
  const weights = {};
  for (const step of report.steps.filter((item) => item.unitSummary)) {
    const files = step.unitSummary.files;
    if (step.status !== 'passed' || !Array.isArray(files)) throw Error('Invalid unit evidence');
    const text = read(step.details);
    const checked = validateUnitEvents(text, files);
    if (JSON.stringify(checked) !== JSON.stringify(step.unitSummary))
      throw Error('Changed unit evidence');
    for (const row of text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))) {
      if (row.type !== 'test:summary' || !row.file) continue;
      const filename = row.file.replaceAll('\\', '/');
      const file = files.find((name) => filename === name || filename.endsWith('/' + name));
      if (Object.hasOwn(weights, file)) throw Error('Duplicate timing file');
      if (!Number.isFinite(row.durationMs) || row.durationMs <= 0)
        throw Error('Missing positive file duration');
      weights[file] = Math.ceil(row.durationMs);
    }
  }
  if (
    Object.keys(weights).length !== expected.length ||
    expected.some((file) => !Object.hasOwn(weights, file))
  )
    throw Error('Timing coverage differs from test inventory');
  return Object.fromEntries(Object.entries(weights).sort(([a], [b]) => a.localeCompare(b, 'en')));
}

function refresh(root, id) {
  // Only a complete, revalidated candidate may train the advisory placement.
  // Never change its frozen source or waive any tests to obtain timings.
  if (!status(root, id).readyToPackage) throw Error('Complete Windows/Linux reports required');
  const candidate = readCandidate(root, id);
  const targets = {};
  for (const target of ['windows', 'linux']) {
    const report = JSON.parse(
      fs.readFileSync(safePath(candidate.directory, 'reports/' + target + '/report.json')),
    );
    targets[target] = measuredWeights(
      report,
      (file) => fs.readFileSync(safePath(candidate.directory, file), 'utf8'),
      testFiles(candidate.source),
    );
  }
  const value = {
    version: 3,
    baseline: id + '; validated per-file summaries; advisory placement only',
    sourceHash: candidate.data.sourceHash,
    targets,
  };
  writeJson(path.join(root, 'scripts/release/unit-timings.json'), value);
  return { baseline: id, files: Object.keys(targets.windows).length, sourceHash: value.sourceHash };
}
module.exports = { measuredWeights, refresh };
if (require.main === module) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--id')
      throw Error('Use --id <verified-candidate>');
    console.log(JSON.stringify(refresh(path.resolve(__dirname, '../..'), process.argv[3])));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
