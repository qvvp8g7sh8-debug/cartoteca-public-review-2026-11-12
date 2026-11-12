const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { safePath, objectHash } = require('./files.cjs');
const { readCandidate, writeJson, lock } = require('./state.cjs');
const { status } = require('./status.cjs');
const { artifact, assertMigrationStand, configuration } = require('./deployment-plan.cjs');
const { deployment } = require('./deployment.cjs');
const { recordPublished } = require('./impact-baseline.cjs');
const { publicationCheck } = require('./publication-check.cjs');
const transfer = require('./flow-artifact.cjs');

const {
  repository,
  folder,
  read,
  start,
  next,
  validateRun,
  failures,
  diagnosticNames,
  failedFiles,
} = require('./flow-state.cjs');

async function ready(root, state) {
  const id = 'ci-' + state.run,
    candidate = readCandidate(root, id);
  if (
    candidate.data.sourceHash !== state.sourceHash ||
    candidate.data.github?.head !== state.head ||
    candidate.data.github?.repository !== repository ||
    candidate.data.github?.run !== state.run ||
    !status(root, id).readyToPackage ||
    !(await artifact(root, id))
  )
    throw Error('Complete matching package required');
  const stand = JSON.parse(
    fs.readFileSync(safePath(candidate.directory, 'stand/stand-report.json')),
  );
  if (
    stand.sourceHash !== state.sourceHash ||
    stand.passed !== true ||
    !stand.scenarios?.length ||
    stand.scenarios.some((s) => s.passed !== true)
  )
    throw Error('Complete matching server stand required');
  if (state.publish) assertMigrationStand(candidate, configuration(state.deployConfig));
  return candidate;
}
async function advance(
  root,
  id,
  input = {},
  {
    emit = () => {},
    signal,
    request,
    extract = transfer.extract,
    verifyPackage = ready,
    publishRelease = deployment,
    verifyPublication = publicationCheck,
    recordBaseline = recordPublished,
  } = {},
) {
  const directory = folder(root, id),
    release = lock(directory);
  const state = read(root, id),
    save = () => writeJson(path.join(directory, 'state.json'), state);
  const event = (phase) => {
    state.phase = phase;
    state.events.push({ phase, at: new Date().toISOString() });
    save();
    emit({ event: 'phase', phase });
  };
  try {
    delete state.error;
    if (state.sourceHash !== readCandidate(root, id).data.sourceHash)
      throw Error('Submitted snapshot changed');
    if (state.publish && objectHash(configuration(state.deployConfig)) !== state.configHash)
      throw Error('Publication destination changed');
    if (state.phase === 'ci') {
      if (Date.now() - Date.parse(state.startedAt) > 45 * 60 * 1000)
        throw Error('CI wait deadline exceeded; inspect the run');
      if (input.kind !== 'ci') return next(state);
      if (input.run) validateRun(input.run, state);
      const runs = input.runs || (input.run ? [input.run] : []);
      const selected = runs.filter(
        (r) =>
          r.head_sha === state.head &&
          r.head_branch === state.branch &&
          r.path === '.github/workflows/release.yml' &&
          r.event === 'push',
      );
      if (!selected.length) return next(state);
      if (selected.length !== 1) throw Error('Ambiguous CI run');
      validateRun(selected[0], state);
      state.run = selected[0].id;
      // Discover the run first; inspect its complete job inventory on the next poll.
      if (!Array.isArray(input.jobs)) {
        save();
        return next(state);
      }
      if (input.totalJobs !== undefined && input.totalJobs !== input.jobs?.length)
        throw Error('Incomplete CI job inventory');
      state.failures = failures(input.jobs || []);
      if (state.failures.length) {
        state.diagnosticsStartedAt = new Date().toISOString();
        event('diagnostics');
        return next(state);
      }
      if (selected[0].status === 'completed') {
        if (selected[0].conclusion !== 'success') throw Error('CI did not pass');
        event('artifacts');
      } else save();
      return next(state);
    }
    if (['artifacts', 'diagnostics'].includes(state.phase)) {
      if (input.kind !== 'artifacts') return next(state);
      if (input.total !== input.artifacts?.length) throw Error('Incomplete artifact inventory');
      const names = state.phase === 'diagnostics' ? diagnosticNames(state) : ['verified-release'];
      const received = new Set((state.diagnostics || []).map((a) => a.name));
      const available = input.artifacts.filter(
        (a) => names.includes(a.name) && !received.has(a.name),
      );
      if (!available.length) {
        if (state.phase === 'diagnostics') {
          // A failed job can become visible before its uploaded report does.
          if (
            names.some((name) => !received.has(name)) &&
            Date.now() - Date.parse(state.diagnosticsStartedAt) < 180000
          )
            return next(state);
          event('failed');
          return next(state);
        }
        throw Error('Verified package is missing');
      }
      if (new Set(available.map((a) => a.name)).size !== available.length)
        throw Error('Ambiguous artifact identity');
      state.diagnosticDownload = state.phase === 'diagnostics';
      state.artifact = transfer.artifactIdentity(available[0], state, available[0].name);
      state.downloadAttempts = 0;
      event('reference');
      return next(state);
    }
    if (state.phase === 'reference') {
      if (input.kind !== 'reference' || input.artifactId !== state.artifact.id) return next(state);
      // Temporary URL is consumed from stdin, never saved to state or program output.
      const file = await transfer.download(directory, state.artifact, input.url, {
        emit,
        signal,
        request,
      });
      // Browser report paths are deep; keep staging shallow for Windows ZIP APIs.
      const staging = safePath(root, '.release/i-' + crypto.randomUUID());
      const target = state.diagnosticDownload
        ? safePath(directory, 'diagnostic-' + state.artifact.id)
        : safePath(root, '.release/candidates/ci-' + state.run);
      if (!fs.existsSync(target)) {
        extract(file, staging);
        fs.renameSync(staging, target);
      }
      if (state.diagnosticDownload) {
        state.diagnostics ||= [];
        state.diagnostics.push({
          name: state.artifact.name,
          directory: path.relative(root, target).replaceAll('\\', '/'),
          failedFiles: failedFiles(target),
        });
        event('diagnostics');
        return next(state);
      }
      await verifyPackage(root, state);
      event(state.publish ? 'publishing' : 'ready');
    }
    if (state.phase === 'publishing') {
      if (!state.publish || objectHash(configuration(state.deployConfig)) !== state.configHash)
        throw Error('Publication destination changed');
      const candidate = await verifyPackage(root, state),
        local = path.join(candidate.directory, 'deployment/local.json');
      // An interrupted launch is reconciled by the existing executor; never publish twice.
      const result = await publishRelease(
        root,
        candidate.data.id,
        {
          command: fs.existsSync(local) ? 'resume' : 'publish',
          'deploy-config': state.deployConfig,
        },
        signal,
      );
      if (result.status !== 'completed' || result.published !== true || result.active !== false) {
        state.deploymentStatus = result.status;
        throw Error('Publication requires inspection of server status');
      }
      state.baselineRecorded = recordBaseline(root, candidate.data.id, result);
      if (state.baselineRecorded !== true) throw Error('Published baseline was not recorded');
      event('verification');
    }
    if (state.phase === 'verification') {
      state.proof = await verifyPublication(root, 'ci-' + state.run, state.deployConfig, signal);
      event('completed');
    }
    return next(state);
  } catch (error) {
    // Retain transition phase after an interrupted deployment; advance reconciles it.
    state.error = ['publishing', 'verification'].includes(state.phase)
      ? 'Release interrupted; reconcile this flow before retrying'
      : state.phase === 'reference'
        ? 'Artifact retrieval failed; obtain a fresh connector reference'
        : 'Release flow validation failed; inspect its saved stage';
    if (state.phase === 'reference' && ++state.downloadAttempts <= 1) save();
    else if (!['publishing', 'verification'].includes(state.phase)) event('failed');
    else save();
    emit({ event: 'error', phase: state.phase, message: state.error });
    return { ...next(state), interrupted: true };
  } finally {
    release();
  }
}
module.exports = { start, advance, read, next, validateRun, failures, diagnosticNames, ready };
