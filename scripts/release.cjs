const path = require('node:path');
const { describe } = require('./release/plan.cjs');
const { prepare } = require('./release/prepare.cjs');
const { verify } = require('./release/runner.cjs');
const { status } = require('./release/status.cjs');
const { packageImage } = require('./release/package.cjs');
const { deployment } = require('./release/deployment.cjs');
const { aggregate } = require('./release/aggregate.cjs');
const { parts } = require('./release/shards.cjs');
const { steps } = require('./release/plan.cjs');
const cycle = require('./release/cycle.cjs');
const { submit } = require('./release/submission.cjs');
const { impact } = require('./release/impact.cjs');
const { recordPublished } = require('./release/impact-baseline.cjs');

function options(args) {
  const result = {};
  const booleans = new Set([
    'resume',
    'install-browsers',
    'install-browser-deps',
    'precheck',
    'priority-risk',
    'stream-priority',
  ]);
  const values = new Set([
    'id',
    'target',
    'jobs',
    'unit-workers',
    'unit-shards',
    'part',
    'phase',
    'deploy-config',
    'delivery-lease',
    'delivery-artifact',
    'requested-at',
    'stage',
    'event',
    'cycle',
    'repository',
    'base-ref',
    'branch',
    'baseline-id',
    'profile',
    'selection-mode',
  ]);
  for (let index = 0; index < args.length; index++) {
    const key = args[index].replace(/^--/, '');
    if (args[index] !== '--' + key || Object.hasOwn(result, key))
      throw Error('Invalid or duplicate option');
    if (booleans.has(key)) result[key] = true;
    else if (values.has(key) && args[index + 1] && !args[index + 1].startsWith('--'))
      result[key] = args[++index];
    else throw Error('Unknown option: ' + args[index]);
  }
  return result;
}

async function main(args = process.argv.slice(2)) {
  const command = args.shift() || 'plan';
  if (
    ![
      'plan',
      'impact',
      'prepare',
      'verify',
      'matrix',
      'aggregate',
      'submit',
      'cycle-start',
      'cycle-mark',
      'cycle-finish',
      'cycle-status',
      'status',
      'package',
      'deploy-plan',
      'publish',
      'resume',
      'deploy-status',
    ].includes(command)
  )
    throw Error(
      'Commands: plan, impact, matrix, prepare, submit, verify, aggregate, status, package, deploy-plan, publish, resume, deploy-status, cycle-start, cycle-mark, cycle-finish, cycle-status.',
    );
  const opts = options(args);
  if (
    opts['selection-mode'] !== undefined &&
    (command !== 'prepare' ||
      opts.profile !== 'assistant-ui' ||
      !['client-audio-hotfix-v1', 'assistant-audio-session-v1', 'assistant-behavior-v1'].includes(
        opts['selection-mode'],
      ))
  )
    throw Error(
      '--selection-mode client-audio-hotfix-v1, assistant-audio-session-v1 or assistant-behavior-v1 requires prepare --profile assistant-ui',
    );
  if (opts.profile !== undefined && command !== 'prepare')
    throw Error('--profile is only valid for prepare');
  if (opts.profile !== undefined && !['full', 'assistant-ui'].includes(opts.profile))
    throw Error('Unknown verification profile');
  if (command === 'prepare' && opts.profile === 'assistant-ui' && !opts['baseline-id'])
    throw Error('assistant-ui requires --baseline-id');
  if (command === 'prepare' && opts['baseline-id'] && opts.profile !== 'assistant-ui')
    throw Error('--baseline-id for preparation requires explicit --profile assistant-ui');
  if (opts.precheck && command !== 'verify') throw Error('--precheck is only valid for verify');
  if (opts['priority-risk'] && command !== 'verify')
    throw Error('--priority-risk is only valid for verify');
  if (opts['stream-priority'] && !opts['priority-risk'])
    throw Error('--stream-priority requires --priority-risk');
  if (
    opts['baseline-id'] &&
    command !== 'impact' &&
    !(command === 'prepare' && opts.profile === 'assistant-ui') &&
    !(command === 'verify' && (opts.precheck || opts['priority-risk']))
  )
    throw Error(
      '--baseline-id is only valid for scoped preparation, impact, precheck or priority verification',
    );
  const root = path.resolve(__dirname, '..');
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const stage = {
    prepare: 'preparation',
    submit: 'preparation',
    package: 'artifact',
    publish: 'publication',
    resume: 'publication',
    verify: 'verification',
    aggregate: 'verification',
  }[command];
  let tracking = false;
  try {
    if (opts.cycle && stage) {
      cycle.mark(root, opts.cycle, stage, 'start');
      tracking = true;
    }
    let result;
    if (command === 'plan') result = describe(root);
    else if (command === 'impact')
      result = impact(root, opts.id, { baselineId: opts['baseline-id'], target: opts.target });
    else if (command === 'cycle-start') result = cycle.start(root, opts.id, opts['requested-at']);
    else if (command === 'cycle-mark') result = cycle.mark(root, opts.id, opts.stage, opts.event);
    else if (command === 'cycle-finish') result = cycle.finish(root, opts.id);
    else if (command === 'cycle-status') result = cycle.read(root, opts.id);
    else if (command === 'submit')
      result = await submit(
        root,
        opts.id,
        {
          repository: opts.repository,
          baseRef: opts['base-ref'],
          branch: opts.branch,
        },
        controller.signal,
      );
    else if (command === 'matrix') {
      const include = ['windows', 'linux'].flatMap((target) =>
        parts(
          steps(root, {
            target,
            unitShards: Number(opts['unit-shards'] || 4),
            unitWorkers: Number(opts['unit-workers'] || 2),
          }),
        )
          .filter(
            (p) => opts.phase !== 'browser' || p.id === 'quality' || p.id.startsWith('browser-'),
          )
          .map((part) => ({
            target,
            os: target === 'windows' ? 'windows-latest' : 'ubuntu-24.04',
            part: part.id,
          })),
      );
      result = { include };
      if (process.env.GITHUB_OUTPUT)
        require('node:fs').appendFileSync(
          process.env.GITHUB_OUTPUT,
          'matrix=' + JSON.stringify(result) + '\n',
        );
    } else if (command === 'aggregate')
      result = aggregate(root, opts.id, {
        unitShards: Number(opts['unit-shards'] || 4),
        unitWorkers: Number(opts['unit-workers'] || 2),
      });
    else if (command === 'prepare')
      result = await prepare(root, opts.id, controller.signal, {
        profile: opts.profile || 'full',
        baselineId: opts['baseline-id'],
        ...(opts['selection-mode'] ? { selectionMode: opts['selection-mode'] } : {}),
      });
    else if (command === 'status') result = status(root, opts.id);
    else if (command === 'package') result = await packageImage(root, opts.id, controller.signal);
    else if (['deploy-plan', 'publish', 'resume', 'deploy-status'].includes(command))
      result = await deployment(root, opts.id, { ...opts, command }, controller.signal);
    else
      result = await verify(root, opts.id, {
        target: opts.target || (process.platform === 'win32' ? 'windows' : 'linux'),
        jobs: Number(opts.jobs || 2),
        unitWorkers: Number(opts['unit-workers'] || 2),
        unitShards: Number(opts['unit-shards'] || 1),
        part: opts.part,
        resume: opts.resume,
        phase: opts.phase || 'all',
        precheck: opts.precheck,
        priority: opts['priority-risk'],
        streamPriority: opts['stream-priority'],
        baselineId: opts['baseline-id'],
        installBrowsers: opts['install-browsers'],
        installBrowserDeps: opts['install-browser-deps'],
        signal: controller.signal,
      });
    if (['publish', 'resume'].includes(command)) {
      try {
        result.baselineRecorded = recordPublished(root, opts.id, result);
      } catch {
        result.baselineRecorded = false;
        result.baselineError =
          'Publication completed but baseline record could not be updated; reconcile before the next release';
      }
    }
    if (command === 'submit' && ['submitted', 'unknown'].includes(result.status))
      result.follow = {
        id: opts.id,
        adapter: 'scripts/release/flow-follow.js',
        documentation: 'docs/RELEASE-FLOW.md',
      };
    console.log(JSON.stringify(result, null, 2));
    if (
      [
        'failed',
        'cancelled',
        'failed_before_switch',
        'rolled_back',
        'needs_attention',
        'published_backup_pending',
        'unknown',
        'error',
      ].includes(result.status)
    )
      process.exitCode = 1;
    if (tracking) {
      cycle.mark(root, opts.cycle, stage, process.exitCode === 1 ? 'failed' : 'passed');
      tracking = false;
    }
    return result;
  } finally {
    if (tracking)
      cycle.mark(root, opts.cycle, stage, controller.signal.aborted ? 'cancelled' : 'failed');
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { options, main };
