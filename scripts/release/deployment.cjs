const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  configuration,
  plan,
  artifact,
  digest,
  runtimeFiles,
  serverConfiguration,
  objectHash,
  assertMigrationStand,
} = require('./deployment-plan.cjs');
const { transport } = require('./deployment-transport.cjs');
const { prepare } = require('./prepare.cjs');
const { verify } = require('./runner.cjs');
const { packageImage } = require('./package.cjs');
const { status } = require('./status.cjs');
const { location, readCandidate, writeJson, lock } = require('./state.cjs');
const { assertController } = require('./files.cjs');
const { deliver } = require('./delivery.cjs');

const remoteFiles = [
  'agent.py',
  'operations.py',
  'checks.py',
  'migration.py',
  'paid_services.py',
  'read_budget.py',
  'booking_links.py',
  'publication_gate.py',
  'delivery.py',
  'probe.cjs',
];
const terminal = new Set([
  'completed',
  'rolled_back',
  'needs_attention',
  'failed_before_switch',
  'published_backup_pending',
]);

async function follow(read, signal, progress = (value) => console.log(JSON.stringify(value))) {
  const deadline = Date.now() + 2500000;
  let last;
  while (!signal?.aborted && Date.now() < deadline) {
    const current = await read();
    const description = JSON.stringify([current.status, current.currentStage, current.attempt]);
    if (description !== last) {
      progress({ status: current.status, stage: current.currentStage, attempt: current.attempt });
      last = description;
    }
    if (terminal.has(current.status) && !current.active) return current;
    if (
      !current.active &&
      ['dispatching', 'switching', 'rolling_back', 'preflight', 'migrating', 'activating'].includes(
        current.status,
      )
    )
      return {
        ...current,
        status: 'needs_attention',
        error: 'Server executor stopped during a transition; inspect status before recovery',
      };
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, 4000);
      signal?.addEventListener('abort', done, { once: true });
    });
  }
  return {
    status: 'unknown',
    error: 'Local wait ended; the server operation may still be running. Use deploy-status',
  };
}
async function deployment(root, id, opts, signal) {
  if (
    [
      'target',
      'phase',
      'resume',
      'install-browsers',
      'install-browser-deps',
      'part',
      'unit-shards',
    ].some((key) => opts[key] !== undefined)
  )
    throw Error('Deployment commands accept id, deploy-config, jobs and unit-workers only');
  if (!opts['deploy-config']) throw Error('--deploy-config is required');
  const config = configuration(opts['deploy-config']);
  const command = opts.command;
  if (command === 'deploy-plan') return plan(root, id, config);
  if (command === 'publish' && !fs.existsSync(location(root, id))) await prepare(root, id, signal);
  const candidate = readCandidate(root, id);
  assertMigrationStand(candidate, config);
  const directory = path.join(candidate.directory, 'deployment');
  fs.mkdirSync(directory, { recursive: true });
  const stateFile = path.join(directory, 'local.json');
  let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
  if (state && state.configHash !== objectHash(config))
    throw Error('Deployment destination changed; use its original configuration');
  const network = transport(config, directory, signal);
  async function remoteStatus() {
    if (!state?.remote) return { status: 'not_started', published: false };
    return JSON.parse(
      await network.ssh('status', [
        'python3',
        state.remote + '/agent.py',
        'status',
        state.remote + '/request.json',
        state.requestHash,
      ]),
    );
  }
  if (command === 'deploy-status') return remoteStatus();
  const release = lock(directory);
  try {
    assertController(root, candidate.data.files);
    if (state && command === 'publish')
      throw Error('Deployment already recorded; use deploy-status or resume');
    if (!state && command === 'resume') throw Error('No deployment to resume');
    if (!state) {
      const readiness = status(root, id);
      const target = process.platform === 'win32' ? 'windows' : 'linux';
      if (readiness.targets[target].status !== 'passed') {
        const result = await verify(root, id, {
          target,
          jobs: Number(opts.jobs || 2),
          unitWorkers: Number(opts['unit-workers'] || 2),
          resume: true,
          signal,
        });
        if (result.status !== 'passed') throw Error('Local verification did not pass');
      }
      if (!status(root, id).readyToPackage)
        throw Error(
          'Other OS verification is missing. Import the matching reports from the Linux/Windows executor; production is untouched',
        );
      let image = await artifact(root, id, { imageIdentity: config.schema === 19 });
      if (!image) {
        if (process.platform !== 'linux')
          throw Error(
            'Build the verified image on the Linux executor and import its image directory',
          );
        if ((await packageImage(root, id, signal)).status !== 'packaged')
          throw Error('Image preparation failed');
        image = await artifact(root, id, { imageIdentity: config.schema === 19 });
      }
      assertMigrationStand(candidate, config, config.schema === 19 ? image : image.report.imageId);
      const run =
        'r-' + candidate.data.sourceHash.slice(0, 12) + '-' + crypto.randomBytes(6).toString('hex');
      const remote = config.releaseRoot + '/' + run;
      const payload = path.join(directory, 'payload');
      fs.mkdirSync(payload, { recursive: true });
      const files = {};
      for (const name of remoteFiles) {
        const original = path.join(candidate.source, 'scripts/release/remote', name);
        const destination = path.join(payload, name);
        fs.copyFileSync(original, destination);
        files[name] = await digest(destination);
      }
      fs.copyFileSync(
        path.join(candidate.source, 'scripts/release/image-check.cjs'),
        path.join(payload, 'image-check.cjs'),
      );
      files['image-check.cjs'] = await digest(path.join(payload, 'image-check.cjs'));
      const request = {
        version: 1,
        run,
        candidate: id,
        sourceHash: candidate.data.sourceHash,
        config: serverConfiguration(config),
        imageId: image.report.imageId,
        imageHash: image.report.archive.sha256,
        imageBytes: image.report.archive.bytes,
        runtime: runtimeFiles(candidate),
        files,
        createdAt: new Date().toISOString(),
      };
      writeJson(path.join(payload, 'request.json'), request);
      state = {
        version: 1,
        status: 'prepared',
        candidate: id,
        sourceHash: candidate.data.sourceHash,
        configHash: objectHash(config),
        remote,
        run,
        requestHash: await digest(path.join(payload, 'request.json')),
        archive: image.archive,
        createdAt: new Date().toISOString(),
      };
      writeJson(stateFile, state);
    }
    // Always reconcile first after a dispatched launch. A lost SSH session is not a failed deployment.
    if (['dispatching', 'dispatched', 'unknown'].includes(state.status)) {
      const current = await remoteStatus();
      if (current.active) return await follow(remoteStatus, signal);
      if (['completed', 'rolled_back', 'needs_attention'].includes(current.status)) return current;
      if (
        current.status !== 'not_started' &&
        current.status !== 'failed_before_switch' &&
        current.status !== 'published_backup_pending'
      )
        throw Error(
          'Remote operation was interrupted during a transition; explicit server recovery is required',
        );
    }
    const payload = path.join(directory, 'payload');
    const request = JSON.parse(fs.readFileSync(path.join(payload, 'request.json'), 'utf8'));
    if ((await digest(path.join(payload, 'request.json'))) !== state.requestHash)
      throw Error('Deployment request changed');
    if (state.status === 'prepared') {
      // Python validates the directory and immutable request again before executing anything.
      await network.ssh('directory', [
        'python3',
        '-c',
        'import os,sys,pathlib; p=pathlib.Path(sys.argv[1]); assert not any(x.is_symlink() for x in [p,*p.parents]); p.mkdir(parents=True,exist_ok=True); os.chmod(p,0o700)',
        state.remote,
      ]);
      for (const [name, hash] of Object.entries(request.files))
        if ((await digest(path.join(payload, name))) !== hash)
          throw Error('Deployment payload changed');
      if ((await digest(state.archive)) !== request.imageHash) throw Error('Image archive changed');
      // Name the image consistently without copying a potentially large archive locally.
      await network.upload(
        [...remoteFiles, 'image-check.cjs', 'request.json'].map((name) => path.join(payload, name)),
        state.remote,
      );
      await deliver(network, candidate, state, request, opts, directory);
      state.status = 'uploaded';
      writeJson(stateFile, state);
    }
    state.status = 'dispatching';
    writeJson(stateFile, state);
    try {
      const result = JSON.parse(
        await network.ssh('dispatch', [
          'python3',
          state.remote + '/agent.py',
          'launch',
          state.remote + '/request.json',
          state.requestHash,
        ]),
      );
      state.status = 'dispatched';
      writeJson(stateFile, state);
      return result.active || !terminal.has(result.status)
        ? await follow(remoteStatus, signal)
        : result;
    } catch (error) {
      state.status = 'unknown';
      writeJson(stateFile, state);
      throw error;
    }
  } finally {
    release();
  }
}
module.exports = { deployment, follow };
