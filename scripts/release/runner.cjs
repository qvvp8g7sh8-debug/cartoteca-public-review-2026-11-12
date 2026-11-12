const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { steps, browserInstallEngines } = require('./plan.cjs');
const {
  names,
  objectHash,
  verifySnapshot,
  safePath,
  controllerHash,
  assertController,
} = require('./files.cjs');
const { writeJson, readCandidate, lock, freshReport, reusable } = require('./state.cjs');
const { runProcess, npmCli } = require('./process.cjs');
const { scheduleTests } = require('./scheduler.cjs');
const { POLICY } = require('./reuse.cjs');
const { environment } = require('./environment.cjs');
const { validateBrowserReport } = require('./browser-report.cjs');
const { selectPart } = require('./shards.cjs');
const { validateUnitEvents } = require('./unit-report.cjs');
const { impact, earlySteps } = require('./impact.cjs');
const { summarizeFailure } = require('./failure-summary.cjs');
const { createAttempt } = require('./attempt.cjs');
const { priorityPlan } = require('./priority-plan.cjs');
const { watchUnitFailures } = require('./unit-progress.cjs');
const { verifyProfile, scopePlan, validateScopedReport } = require('./verification-profile.cjs');

function validateEarlyBrowserReport(result, expected) {
  const assert = require('node:assert/strict');
  assert.equal(result?.schemaVersion, 1, 'Unknown early browser report version');
  assert.equal(result.reportType, expected.reportType, 'Wrong early browser report type');
  assert.equal(result.readiness, false, 'Early browser report cannot qualify release readiness');
  assert.equal(result.partial, true, 'Early browser coverage must remain partial');
  assert.equal(result.fullRequired, true, 'Early browser report must retain full verification');
  assert.equal(result.complete, true, 'Incomplete early browser smoke');
  assert.deepEqual(result.engines, expected.engines, 'Wrong early browser engines');
  assert.deepEqual(result.widths, expected.widths, 'Wrong early browser viewports');
  assert.deepEqual(result.caseNames, expected.caseNames, 'Changed early browser case contract');
  const keys = expected.engines
    .flatMap((engine) =>
      expected.widths.flatMap((width) =>
        expected.caseNames.map((name) => JSON.stringify([engine, width, name])),
      ),
    )
    .sort();
  assert.ok(Array.isArray(result.results), 'Missing early browser results');
  assert.equal(result.expectedCases, keys.length, 'Wrong early browser expected count');
  assert.deepEqual(
    result.results.map(({ engine, width, name }) => JSON.stringify([engine, width, name])).sort(),
    keys,
    'Incomplete, duplicate or unexpected early browser cases',
  );
  const failures = result.results.filter((row) => row.passed !== true).length;
  assert.equal(result.failures, failures, 'Wrong early browser failure count');
  assert.equal(failures, 0, 'Early browser smoke contains failures');
  return {
    reportType: result.reportType,
    expectedCases: keys.length,
    partial: true,
    fullRequired: true,
  };
}

async function verify(
  root,
  id,
  {
    target,
    jobs = 2,
    unitWorkers = 2,
    unitShards = 1,
    part,
    resume = false,
    installBrowsers = false,
    installBrowserDeps = false,
    phase = 'all',
    precheck = false,
    priority = false,
    streamPriority = false,
    baselineId,
    signal,
  } = {},
) {
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 4) throw Error('Jobs must be between 1 and 4');
  if (!['all', 'quality', 'unit', 'browser'].includes(phase))
    throw Error('Unknown verification phase');
  const candidate = readCandidate(root, id);
  assertController(root, candidate.data.files);
  const verificationProfile = verifyProfile(root, candidate);
  if (
    verificationProfile &&
    (phase !== 'all' || part || precheck || priority || streamPriority || unitShards !== 1)
  )
    throw Error(
      'assistant-ui requires its complete sealed profile; no partial or arbitrary selection',
    );
  if (verificationProfile && unitWorkers !== 1)
    throw Error('assistant-ui requires one unit worker');
  if (precheck && (part || phase !== 'all' || unitShards !== 1 || resume))
    throw Error('Precheck cannot be combined with part, phase, shards or resume');
  if (part && phase !== 'all') throw Error('Part and phase cannot be combined');
  if (priority && (precheck || part || phase !== 'all' || unitShards !== 1))
    throw Error('Priority verification requires a complete native plan');
  if (streamPriority && !priority) throw Error('Streaming requires priority verification');
  if (!part && unitShards !== 1) throw Error('Distributed verification requires --part');
  const completePlan = steps(candidate.source, { target, unitWorkers, unitShards });
  const basePlan = verificationProfile
    ? scopePlan(completePlan, verificationProfile, { target })
    : completePlan;
  const early = precheck || priority ? impact(root, id, { baselineId, target }) : null;
  const priorityFiles = priority ? early.earlyTests.map((row) => row.file) : [];
  const prioritySmoke = priority
    ? earlySteps(basePlan, early, unitWorkers).find((step) => step.earlyBrowser)
    : null;
  const plan = priority
    ? priorityPlan(basePlan, priorityFiles, prioritySmoke, streamPriority)
    : basePlan;
  const scope = precheck
    ? earlySteps(plan, early, unitWorkers)
    : part
      ? selectPart(plan, part)
      : plan;
  const selection = scope.filter(
    (s) =>
      phase === 'all' ||
      s.phase === 'quality' ||
      (phase === 'unit' && (s.id === 'unit' || s.id.startsWith('unit-'))) ||
      (phase === 'browser' && s.browserCoverage),
  );
  const browserSelection = selection.flatMap((step) =>
    step.earlyBrowser
      ? step.earlyBrowser.engines.map((engine) => ({ browserCoverage: { engine } }))
      : [step],
  );
  const release = lock(candidate.directory);
  let report = freshReport(candidate.data, target, null);
  report.reusePolicy = POLICY;
  if (verificationProfile) {
    report.profile = 'assistant-ui';
    report.profileHash = verificationProfile.profileHash;
    report.inheritedBackend = verificationProfile.inheritedNative[target];
    if (verificationProfile.selectionMode) {
      report.selectionMode = verificationProfile.selectionMode;
      report.scope = verificationProfile.scope;
      report.fullVerification = verificationProfile.fullVerification;
      report.coverage = verificationProfile.coverage;
    }
  }
  report.settings = {
    jobs,
    unitWorkers,
    unitShards,
    ...(priority
      ? {
          priorityTests: priorityFiles,
          priorityBrowserSmoke: Boolean(prioritySmoke),
          ...(streamPriority ? { streamPriority: true } : {}),
        }
      : {}),
  };
  if (verificationProfile)
    report.settings.verificationProfileHash = verificationProfile.profileHash;
  if (part) {
    report.version = 2;
    report.part = part;
  }
  report.selectionHash = objectHash(selection);
  report.selectedPhase = precheck ? 'precheck' : phase;
  if (early) report.impactHash = early.planHash;
  if (precheck) {
    report.partial = true;
    report.fullRequired = true;
    report.readyToPackage = false;
  }
  report.planHash = objectHash(plan);
  let history;
  try {
    history = createAttempt(candidate, report, { resume });
  } catch (error) {
    release();
    throw error;
  }
  const { attempt, previous, save } = history;
  const integrityController = new AbortController();
  const executionSignal = signal
    ? AbortSignal.any([signal, integrityController.signal])
    : integrityController.signal;
  function assertSnapshot(record) {
    try {
      verifySnapshot(candidate.source, candidate.data.files);
    } catch (error) {
      if (record)
        Object.assign(record, {
          status: 'failed',
          failureKind: 'snapshot-integrity',
          error: error.message,
          finishedAt: new Date().toISOString(),
        });
      report.status = 'failed';
      report.failureKind = 'snapshot-integrity';
      report.error = error.message;
      // An untrusted snapshot cannot execute further work, including already running children.
      integrityController.abort();
      save();
      throw error;
    }
  }
  const execute = async (step, extra = {}) => {
    const record = {
      id: step.id,
      inputHash: objectHash(step),
      startedAt: new Date().toISOString(),
      status: 'running',
      log: path
        .relative(candidate.directory, path.join(attempt, step.id + '.txt'))
        .replaceAll('\\', '/'),
    };
    report.steps.push(record);
    save();
    if (resume && reusable(previous, step, report.environment, candidate.data.sourceHash, POLICY)) {
      const prior = previous.steps.find((item) => item.id === step.id);
      Object.assign(record, {
        status: 'passed',
        reused: true,
        durationMs: 0,
        log: prior.log,
        previousLog: prior.log,
        reusedFrom: previous.attempt,
      });
      if (prior.details) record.details = prior.details;
      if (prior.unitSummary) record.unitSummary = prior.unitSummary;
      if (prior.earlyBrowserSummary) record.earlyBrowserSummary = prior.earlyBrowserSummary;
      record.previousDurationMs = prior.previousDurationMs ?? prior.durationMs;
      if (prior.detailsByCategory) record.detailsByCategory = prior.detailsByCategory;
      assertSnapshot(record);
    } else {
      console.log('START ' + step.id);
      let stopProgress = () => {};
      try {
        const isUnit = step.id === 'unit' || step.id.startsWith('unit-');
        const unitDetail =
          'work/release-unit-events' +
          (step.id === 'unit' ? '' : '-' + step.id.slice(5)) +
          '.jsonl';
        const detailInput = isUnit
          ? unitDetail
          : step.env?.CARTOTECA_BROWSER_REPORT
            ? step.env.CARTOTECA_BROWSER_REPORT + '/results.json'
            : null;
        if (detailInput && fs.existsSync(safePath(candidate.source, detailInput)))
          fs.unlinkSync(safePath(candidate.source, detailInput));
        if (isUnit && streamPriority)
          stopProgress = watchUnitFailures(
            safePath(candidate.source, unitDetail),
            step.unitFiles || step.args.filter((arg) => arg.endsWith('.test.cjs')),
            (failure) => {
              (report.earlyFailures ||= []).push(failure);
              console.log('EARLY-TEST-FAILURE ' + JSON.stringify(failure));
              save();
            },
          );
        Object.assign(
          record,
          await runProcess(step.command || process.execPath, step.args, {
            cwd: candidate.source,
            log: path.join(attempt, step.id + '.txt'),
            signal: executionSignal,
            timeoutMs: step.timeoutMs,
            env: {
              CARTOTECA_RELEASE_TYPES_CACHE: '1',
              CARTOTECA_BROWSER_SCREENSHOTS: '0',
              ...(target === 'linux'
                ? { CADDY_BIN: process.env.CADDY_BIN || '/usr/bin/caddy' }
                : {}),
              ...step.env,
              ...extra,
            },
          }),
        );
        stopProgress();
        assertSnapshot(record);
        const detail = isUnit
          ? unitDetail
          : step.env?.CARTOTECA_BROWSER_REPORT
            ? step.env.CARTOTECA_BROWSER_REPORT + '/results.json'
            : null;
        if (detail && fs.existsSync(safePath(candidate.source, detail))) {
          const output = path.join(attempt, step.id + (isUnit ? '.jsonl' : '.json'));
          fs.copyFileSync(safePath(candidate.source, detail), output);
          record.details = path.relative(candidate.directory, output).replaceAll('\\', '/');
          if (isUnit && record.status === 'passed')
            record.unitSummary = validateUnitEvents(
              fs.readFileSync(output, 'utf8'),
              step.unitFiles || step.args.filter((arg) => arg.endsWith('.test.cjs')),
            );
          if (!isUnit) {
            const results = JSON.parse(fs.readFileSync(output, 'utf8'));
            if (!step.earlyBrowser && Array.isArray(results)) {
              record.detailsByCategory = {};
              for (const category of ['functional', 'appearance']) {
                const categoryFile = path.join(attempt, step.id + '-' + category + '.json');
                writeJson(
                  categoryFile,
                  results.filter((row) => row.category === category),
                );
                record.detailsByCategory[category] = path
                  .relative(candidate.directory, categoryFile)
                  .replaceAll('\\', '/');
              }
            }
            if (record.status === 'passed') {
              if (step.earlyBrowser)
                record.earlyBrowserSummary = validateEarlyBrowserReport(results, step.earlyBrowser);
              else validateBrowserReport(results, step.browserCoverage);
            }
          }
          if (isUnit && record.status !== 'passed')
            record.diagnostics = summarizeFailure(
              fs.readFileSync(output, 'utf8'),
              step.unitFiles || step.args.filter((arg) => arg.endsWith('.test.cjs')),
            );
        } else if (detail && record.status === 'passed') throw Error('Missing test details');
      } catch (error) {
        stopProgress();
        record.status = 'failed';
        record.error = error.message;
        if (record.failureKind === 'snapshot-integrity') throw error;
      }
      console.log(
        record.status.toUpperCase() + ' ' + step.id + ' ' + (record.durationMs || 0) + 'ms',
      );
      if (record.diagnostics)
        console.log('FAILURE-DIAGNOSTICS ' + step.id + ' ' + JSON.stringify(record.diagnostics));
    }
    record.finishedAt = new Date().toISOString();
    save();
    return record.status === 'passed';
  };
  try {
    save();
    // Installing exactly the lockfile each attempt prevents a stale dependency tree from passing reuse.
    // Dependencies are cached by npm/GitHub, never borrowed from the changing development tree.
    const emptyConfig = path.join(attempt, 'empty-user-npmrc');
    const globalConfig = path.join(attempt, 'empty-global-npmrc');
    fs.writeFileSync(emptyConfig, '');
    fs.writeFileSync(globalConfig, '');
    const cache = safePath(root, '.release/cache/npm');
    fs.mkdirSync(cache, { recursive: true });
    const installed = await execute({
      id: 'dependencies',
      args: [
        npmCli(),
        'ci',
        '--ignore-scripts',
        '--no-audit',
        '--fund=false',
        '--registry=https://registry.npmjs.org',
        '--cache=' + cache,
        '--userconfig=' + emptyConfig,
        '--globalconfig=' + globalConfig,
      ],
    });
    if (!installed) throw Error('Dependency installation failed');
    if (installBrowserDeps && target !== 'linux')
      throw Error('Browser system dependencies are Linux-only');
    if (
      (installBrowsers || installBrowserDeps) &&
      browserSelection.some((s) => s.browserCoverage)
    ) {
      const args = [
        'node_modules/playwright/cli.js',
        'install',
        ...(installBrowserDeps ? ['--with-deps'] : []),
        ...browserInstallEngines(browserSelection),
      ];
      if (!(await execute({ id: 'browser-install', args, timeoutMs: 600000 })))
        throw Error('Browser installation failed');
    }
    report.environment = await environment(
      candidate.source,
      target,
      part || precheck || phase !== 'all' || verificationProfile?.selectionMode
        ? [
            ...new Set(
              browserSelection
                .filter((s) => s.browserCoverage)
                .map((s) => s.browserCoverage.engine),
            ),
          ]
        : undefined,
    );
    report.environment.controllerHash = controllerHash(candidate.data.files);
    report.environment.jobs = jobs;
    report.environment.unitWorkers = unitWorkers;
    const git = async (id, args) => execute({ id, command: 'git', args });
    if (!(await git('git-init', ['-c', 'core.autocrlf=false', 'init', '--template='])))
      throw Error('Candidate Git initialization failed');
    const pathspec = path.join(attempt, 'source-paths');
    fs.writeFileSync(pathspec, names(candidate.source).join('\0') + '\0');
    if (
      !(await git('git-index', [
        '-c',
        'core.autocrlf=false',
        'add',
        '--force',
        '--pathspec-from-file=' + pathspec,
        '--pathspec-file-nul',
      ]))
    )
      throw Error('Candidate indexing failed');
    for (const step of selection.filter((s) => s.phase === 'quality')) {
      if (signal?.aborted) break;
      await execute(step);
    }
    const selected = selection.filter(
      (s) =>
        s.phase === 'tests' &&
        (phase === 'all' ||
          (phase === 'unit' && (s.id === 'unit' || s.id.startsWith('unit-'))) ||
          (phase === 'browser' && s.browserCoverage)),
    );
    const scheduling = { jobs, unitWorkers, cpus: os.availableParallelism() };
    report.scheduling = { version: 1, ...scheduling };
    save();
    await scheduleTests(
      selected.filter((step) => step.priority),
      scheduling,
      execute,
      executionSignal,
    );
    await scheduleTests(
      selected.filter((step) => !step.priority),
      scheduling,
      execute,
      executionSignal,
    );
    const complete = selection.every((step) =>
      report.steps.some((r) => r.id === step.id && r.status === 'passed'),
    );
    const failed = report.steps.some((step) => step.status !== 'passed');
    report.status = signal?.aborted
      ? 'cancelled'
      : failed
        ? 'failed'
        : complete && !precheck && phase === 'all'
          ? 'passed'
          : 'partial';
    assertSnapshot(report.steps.at(-1));
  } catch (error) {
    report.status =
      report.failureKind === 'snapshot-integrity'
        ? 'failed'
        : signal?.aborted
          ? 'cancelled'
          : 'failed';
    if (report.failureKind !== 'snapshot-integrity') report.error = error.message;
  } finally {
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
    if (verificationProfile && report.status === 'passed') {
      try {
        validateScopedReport(candidate, target, report, verificationProfile);
      } catch (error) {
        report.status = 'failed';
        report.error = error.message;
      }
    }
    try {
      history.finish();
    } finally {
      release();
    }
  }
  return report;
}
module.exports = { verify, validateEarlyBrowserReport };
