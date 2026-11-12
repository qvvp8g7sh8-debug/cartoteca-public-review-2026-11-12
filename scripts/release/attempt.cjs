const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { safePath, objectHash, hash } = require('./files.cjs');
const { writeJson } = require('./state.cjs');
const { retryIdentity } = require('./reuse.cjs');

function identity(report) {
  return {
    candidate: report.candidate,
    sourceHash: report.sourceHash,
    target: report.target,
    settings: report.settings,
    selectedPhase: report.selectedPhase,
    part: report.part || null,
    planHash: report.planHash,
    selectionHash: report.selectionHash,
    impactHash: report.impactHash || null,
    ...(report.reusePolicy ? { reusePolicy: report.reusePolicy } : {}),
  };
}

function reportDirectory(candidate, report) {
  if (!['windows', 'linux'].includes(report.target)) throw Error('Invalid report target');
  if (!['all', 'precheck', 'quality', 'unit', 'browser'].includes(report.selectedPhase))
    throw Error('Invalid report phase');
  if (report.part && !/^[a-z0-9-]+$/.test(report.part)) throw Error('Invalid report part');
  const suffix = report.part
    ? '/parts/' + report.part
    : report.selectedPhase === 'precheck'
      ? '/early'
      : report.selectedPhase !== 'all'
        ? '/phases/' + report.selectedPhase
        : '';
  return safePath(candidate.directory, 'reports/' + report.target + suffix);
}

function writeOnce(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}

function evidence(candidate, report) {
  const files = new Set();
  for (const step of report.steps.filter((item) => item.status === 'passed')) {
    if (step.log) files.add(step.log);
    if (step.details) files.add(step.details);
    for (const file of Object.values(step.detailsByCategory || {})) files.add(file);
  }
  return Object.fromEntries(
    [...files]
      .sort()
      .map((name) => [name, hash(fs.readFileSync(safePath(candidate.directory, name)))]),
  );
}

function previousAttempt(candidate, file, current) {
  if (!fs.existsSync(file)) return null;
  const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
  // A legacy, unfinished, or differently selected run cannot be inherited.
  if (
    !previous.attempt ||
    !previous.attemptManifestHash ||
    !['passed', 'partial', 'failed', 'cancelled'].includes(previous.status) ||
    objectHash(retryIdentity(identity(previous))) !== objectHash(retryIdentity(identity(current)))
  )
    return null;
  const directory = safePath(candidate.directory, previous.attempt);
  if (path.dirname(directory) !== path.dirname(file)) return null;
  const manifestFile = safePath(directory, 'manifest.json');
  const resultFile = safePath(directory, 'report.json');
  const evidenceFile = safePath(directory, 'evidence.json');
  if (![manifestFile, resultFile, evidenceFile].every((name) => fs.existsSync(name))) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const saved = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  const savedEvidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
  if (
    manifest.version !== 1 ||
    manifest.attempt !== previous.attempt ||
    manifest.startedAt !== previous.startedAt ||
    objectHash(manifest.identity) !== objectHash(identity(previous)) ||
    objectHash(manifest) !== previous.attemptManifestHash ||
    objectHash(saved) !== objectHash(previous) ||
    objectHash(savedEvidence) !== objectHash(evidence(candidate, previous))
  )
    throw Error('Previous attempt evidence changed; do not resume');
  return previous;
}

function createAttempt(candidate, report, { resume = false } = {}) {
  const directory = reportDirectory(candidate, report);
  fs.mkdirSync(directory, { recursive: true });
  const file = safePath(directory, 'report.json');
  const previous = resume ? previousAttempt(candidate, file, report) : null;
  const attempt = safePath(directory, 'attempt-' + Date.now() + '-' + randomUUID());
  fs.mkdirSync(attempt);
  report.attempt = path.relative(candidate.directory, attempt).replaceAll('\\', '/');
  const manifest = {
    version: 1,
    attempt: report.attempt,
    startedAt: report.startedAt,
    identity: identity(report),
  };
  report.attemptManifestHash = objectHash(manifest);
  writeOnce(safePath(attempt, 'manifest.json'), manifest);
  return {
    attempt,
    previous,
    save: () => writeJson(file, report),
    finish() {
      // Preserve each finished attempt before advancing its mutable scope summary.
      writeOnce(safePath(attempt, 'evidence.json'), evidence(candidate, report));
      writeOnce(safePath(attempt, 'report.json'), report);
      writeJson(file, report);
    },
  };
}

module.exports = { identity, reportDirectory, previousAttempt, createAttempt };
