const fs = require('node:fs');
const path = require('node:path');
const { steps } = require('./plan.cjs');
const { parts } = require('./shards.cjs');
const { objectHash, safePath, controllerHash, hash, assertController } = require('./files.cjs');
const { readCandidate, writeJson, lock } = require('./state.cjs');
const { validateBrowserReport } = require('./browser-report.cjs');
const { validateUnitEvents } = require('./unit-report.cjs');

function assemble(candidate, target, { unitWorkers = 2, unitShards = 4 } = {}) {
  if (unitShards < 2) throw Error('Distributed aggregation requires at least two shards');
  const plan = steps(candidate.source, { target, unitWorkers, unitShards });
  const required = parts(plan);
  const directory = safePath(candidate.directory, 'reports/' + target + '/parts');
  const names = fs.readdirSync(directory).sort();
  if (objectHash(names) !== objectHash(required.map((p) => p.id).sort()))
    throw Error('Missing or unexpected verification parts');
  const receipts = [],
    records = [];
  let baseline, startedAt, finishedAt;
  const browsers = {};
  for (const part of required) {
    const relative = 'reports/' + target + '/parts/' + part.id + '/report.json';
    const bytes = fs.readFileSync(safePath(candidate.directory, relative));
    const report = JSON.parse(bytes);
    const env = report.environment;
    if (
      report.version !== 2 ||
      report.candidate !== candidate.data.id ||
      report.sourceHash !== candidate.data.sourceHash ||
      report.target !== target ||
      report.part !== part.id ||
      report.status !== 'passed' ||
      report.selectedPhase !== 'all' ||
      report.settings?.unitWorkers !== unitWorkers ||
      report.settings?.unitShards !== unitShards ||
      report.planHash !== objectHash(plan) ||
      report.selectionHash !== objectHash(part.steps) ||
      env?.os !== (target === 'windows' ? 'win32' : 'linux') ||
      env.controllerHash !== controllerHash(candidate.data.files) ||
      !Array.isArray(report.steps) ||
      report.steps.some((s) => s.status !== 'passed') ||
      new Set(report.steps.map((s) => s.id)).size !== report.steps.length ||
      !Number.isFinite(Date.parse(report.startedAt)) ||
      !Number.isFinite(Date.parse(report.finishedAt)) ||
      Date.parse(report.finishedAt) < Date.parse(report.startedAt) ||
      report.durationMs !== Date.parse(report.finishedAt) - Date.parse(report.startedAt)
    )
      throw Error('Invalid part report: ' + part.id);
    const identity = {
      node: env.node,
      os: env.os,
      arch: env.arch,
      lockHash: env.lockHash,
      caddyHash: env.caddyHash,
      controllerHash: env.controllerHash,
    };
    if (
      !identity.node ||
      !identity.arch ||
      !identity.lockHash ||
      (target === 'linux' && !identity.caddyHash)
    )
      throw Error('Missing execution environment');
    if (baseline && objectHash(baseline) !== objectHash(identity))
      throw Error('Conflicting execution environments');
    baseline = identity;
    for (const [engine, version] of Object.entries(env.browsers || {})) {
      if (browsers[engine] && browsers[engine] !== version)
        throw Error('Conflicting browser versions');
      browsers[engine] = version;
    }
    const allowed = new Set([
      'dependencies',
      'git-init',
      'git-index',
      'browser-install',
      ...part.steps.map((s) => s.id),
    ]);
    if (
      report.steps.some((s) => !allowed.has(s.id)) ||
      !report.steps.some((s) => s.id === 'dependencies' && s.status === 'passed')
    )
      throw Error('Unexpected steps or missing dependencies');
    for (const step of part.steps) {
      const record = report.steps.find((s) => s.id === step.id);
      if (!record || record.inputHash !== objectHash(step))
        throw Error('Missing or changed step: ' + step.id);
      if (step.browserCoverage) {
        if (!env.browsers?.[step.browserCoverage.engine])
          throw Error('Missing browser environment');
        validateBrowserReport(
          JSON.parse(fs.readFileSync(safePath(candidate.directory, record.details))),
          step.browserCoverage,
        );
      }
      if (step.unitFiles) {
        const summary = validateUnitEvents(
          fs.readFileSync(safePath(candidate.directory, record.details), 'utf8'),
          step.unitFiles,
        );
        if (objectHash(summary) !== objectHash(record.unitSummary))
          throw Error('Unit evidence changed');
      }
      records.push(record);
    }
    receipts.push({
      id: part.id,
      file: relative,
      sha256: hash(bytes),
      durationMs: report.durationMs,
    });
    if (!startedAt || report.startedAt < startedAt) startedAt = report.startedAt;
    if (!finishedAt || report.finishedAt > finishedAt) finishedAt = report.finishedAt;
  }
  // Rebuild, rather than trusting a caller-supplied merged status or step list.
  return {
    version: 2,
    candidate: candidate.data.id,
    sourceHash: candidate.data.sourceHash,
    target,
    status: 'passed',
    settings: { unitWorkers, unitShards },
    planHash: objectHash(plan),
    environment: { ...baseline, browsers },
    parts: receipts,
    steps: plan.map((step) => records.find((record) => record.id === step.id)),
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    executorMs: receipts.reduce((sum, p) => sum + p.durationMs, 0),
  };
}

function aggregate(root, id, settings) {
  const candidate = readCandidate(root, id);
  assertController(root, candidate.data.files);
  const release = lock(candidate.directory);
  try {
    const reports = ['windows', 'linux'].map((target) => [
      target,
      assemble(candidate, target, settings),
    ]);
    for (const [target, report] of reports)
      writeJson(safePath(candidate.directory, 'reports/' + target + '/report.json'), report);
    return { id, status: 'passed', published: false, targets: Object.fromEntries(reports) };
  } finally {
    release();
  }
}

function validAggregate(candidate, target, report) {
  try {
    return objectHash(assemble(candidate, target, report.settings)) === objectHash(report);
  } catch {
    return false;
  }
}
module.exports = { aggregate, assemble, validAggregate };
