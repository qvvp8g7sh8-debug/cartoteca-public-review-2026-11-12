const fs = require('node:fs');
const path = require('node:path');
const { safePath, objectHash } = require('./files.cjs');
const { readCandidate, writeJson, lock } = require('./state.cjs');
const { configuration } = require('./deployment-plan.cjs');
const repository = 'qvvp8g7sh8-debug/cartoteca';

function folder(root, id) {
  readCandidate(root, id);
  return safePath(root, '.release/flows/' + id);
}
function read(root, id) {
  return JSON.parse(fs.readFileSync(path.join(folder(root, id), 'state.json')));
}
function submission(candidate) {
  const names = fs
    .readdirSync(candidate.directory)
    .filter((n) => /^submission-\d+$/.test(n))
    .sort()
    .reverse();
  for (const name of names) {
    const file = safePath(candidate.directory, name + '/report.json');
    if (!fs.existsSync(file)) continue;
    const report = JSON.parse(fs.readFileSync(file));
    if (
      ['submitted', 'unknown'].includes(report.status) &&
      report.repository === repository &&
      report.candidate === candidate.data.id &&
      report.sourceHash === candidate.data.sourceHash &&
      /^[a-f0-9]{40}$/.test(report.commit) &&
      /^codex\/release-pipeline-[\w-]+$/.test(report.branch)
    )
      return report;
  }
  throw Error(
    'An immutable submitted snapshot is required; never push again to discover its status',
  );
}
function start(root, id, { publish = false, deployConfig } = {}) {
  const candidate = readCandidate(root, id),
    report = submission(candidate);
  const directory = folder(root, id);
  if (fs.existsSync(path.join(directory, 'state.json')))
    throw Error('Flow already exists; continue it');
  let configHash;
  if (publish) {
    if (!deployConfig) throw Error('Publication requires its explicit deployment configuration');
    deployConfig = safePath(root, path.relative(root, path.resolve(root, deployConfig)));
    const config = configuration(deployConfig);
    if (config.origin !== 'https://example.invalid/')
      throw Error('Unapproved publication destination');
    configHash = objectHash(config);
  } else if (deployConfig) throw Error('Preparation does not accept a deployment destination');
  fs.mkdirSync(directory, { recursive: true });
  const release = lock(directory);
  try {
    if (fs.existsSync(path.join(directory, 'state.json'))) throw Error('Flow already exists');
    const state = {
      version: 1,
      id,
      repository,
      head: report.commit,
      branch: report.branch,
      sourceHash: candidate.data.sourceHash,
      phase: 'ci',
      startedAt: new Date().toISOString(),
      publish: publish === true,
      deployConfig,
      configHash,
      downloadAttempts: 0,
      events: [],
    };
    writeJson(path.join(directory, 'state.json'), state);
    return next(state);
  } finally {
    release();
  }
}
function next(state) {
  const result = { id: state.id, phase: state.phase, sourceHash: state.sourceHash };
  const base = 'https://api.github.com/repos/' + repository;
  if (state.phase === 'ci')
    result.action = {
      kind: 'ci',
      url: state.run
        ? base + '/actions/runs/' + state.run
        : base +
          '/actions/runs?branch=' +
          encodeURIComponent(state.branch) +
          '&event=push&per_page=100',
      jobsUrl: state.run
        ? base + '/actions/runs/' + state.run + '/jobs?filter=latest&per_page=100'
        : undefined,
      pollMs: 30000,
    };
  if (['artifacts', 'diagnostics'].includes(state.phase))
    result.action = {
      kind: 'artifacts',
      url: base + '/actions/runs/' + state.run + '/artifacts?per_page=100',
    };
  if (state.phase === 'reference')
    result.action = {
      kind: 'reference',
      repository,
      artifactId: state.artifact.id,
      name: state.artifact.name,
    };
  if (state.failures) {
    result.failures = state.failures.slice(0, 8);
    result.failureCount = state.failures.length;
  }
  if (state.diagnostics) result.diagnostics = state.diagnostics;
  if (state.proof) result.proof = state.proof;
  if (state.error) result.error = state.error;
  return result;
}
function validateRun(run, state) {
  if (
    !run ||
    !Number.isSafeInteger(run.id) ||
    run.id < 1 ||
    run.head_sha !== state.head ||
    run.head_branch !== state.branch ||
    run.path !== '.github/workflows/release.yml' ||
    run.event !== 'push' ||
    (state.run && run.id !== state.run) ||
    (run.repository?.full_name && run.repository.full_name !== repository)
  )
    throw Error('CI belongs to another snapshot');
}
function failures(jobs) {
  return jobs
    .filter((j) => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(j.conclusion))
    .map((j) => {
      if (!Number.isSafeInteger(j.id) || typeof j.name !== 'string')
        throw Error('Invalid job metadata');
      return {
        id: j.id,
        name: j.name.slice(0, 240),
        conclusion: j.conclusion,
        steps: (j.steps || [])
          .filter((s) => s.conclusion === 'failure')
          .map((s) => String(s.name).slice(0, 240)),
      };
    });
}
function diagnosticNames(state) {
  return state.failures
    .map((job) => {
      const match = /^verify \((windows|linux), [^,]+, ([a-z0-9-]+)\)$/.exec(job.name);
      return match
        ? 'report-' + match[1] + '-' + match[2]
        : {
            prepare: 'early-check-report',
            'server-stand': 'server-stand-report',
            package: 'package-failure-report',
          }[job.name];
    })
    .filter(Boolean);
}
function failedFiles(directory) {
  const result = new Set();
  function walk(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = safePath(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name === 'report.json') {
        const report = JSON.parse(fs.readFileSync(file));
        for (const step of report.steps || [])
          for (const name of step.diagnostics?.failedFiles || [])
            if (/^(?:tests\/)?[a-zA-Z0-9_-]+\.test\.cjs$/.test(name)) result.add(name);
      }
    }
  }
  walk(directory);
  return [...result].sort();
}

module.exports = {
  repository,
  folder,
  read,
  start,
  next,
  validateRun,
  failures,
  diagnosticNames,
  failedFiles,
};
