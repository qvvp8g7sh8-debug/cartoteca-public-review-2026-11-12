const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createGzip } = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { status } = require('./status.cjs');
const { readCandidate, lock, writeJson } = require('./state.cjs');
const { verifySnapshot, safePath, assertController } = require('./files.cjs');
const { runProcess } = require('./process.cjs');
const { verifyProfile } = require('./verification-profile.cjs');

async function packageImage(root, id, signal) {
  const readiness = status(root, id);
  if (!readiness.readyToPackage)
    throw Error('Both complete Windows and Linux reports are required');
  const candidate = readCandidate(root, id);
  const verificationProfile = verifyProfile(root, candidate);
  assertController(root, candidate.data.files);
  const directory = safePath(candidate.directory, 'image-' + Date.now());
  const release = lock(candidate.directory);
  const image = 'cartoteca:candidate-' + candidate.data.sourceHash.slice(0, 20);
  const execute = async (name, args) => {
    const result = await runProcess('docker', ['--context', 'default', ...args], {
      cwd: candidate.source,
      log: path.join(directory, name + '.txt'),
      signal,
    });
    if (result.status !== 'passed') throw Error('Image step failed: ' + name);
    return result;
  };
  const report = {
    version: 1,
    id,
    sourceHash: candidate.data.sourceHash,
    image,
    status: 'running',
    startedAt: new Date().toISOString(),
    published: false,
    ...(verificationProfile
      ? { profile: 'assistant-ui', profileHash: verificationProfile.profileHash }
      : {}),
    steps: {},
  };
  try {
    if (!status(root, id).readyToPackage) throw Error('Reports changed before packaging');
    fs.mkdirSync(directory);
    // Default Dockerfile creates a new image from the candidate and lockfile, never a dated release image.
    report.steps.build = await execute('build', ['build', '--tag', image, '.']);
    await execute('identity', ['image', 'inspect', '--format', '{{.Id}}', image]);
    const digest = fs.readFileSync(path.join(directory, 'identity.txt'), 'utf8').trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw Error('Invalid Docker image identity');
    report.imageId = digest;
    // Run by immutable ID, not a tag that another process could move.
    report.steps.smoke = await execute('smoke', [
      'run',
      '--rm',
      '--network',
      'none',
      '--memory=900m',
      '--cpus=2',
      '--tmpfs',
      '/tmp:size=256m,mode=1777',
      '--mount',
      'type=bind,source=' +
        path.join(candidate.source, 'scripts/release/image-check.cjs') +
        ',target=/tmp/release-image-check.cjs,readonly',
      '--entrypoint',
      'node',
      digest,
      '/tmp/release-image-check.cjs',
    ]);
    verifySnapshot(candidate.source, candidate.data.files);
    const archive = path.join(directory, 'image.tar');
    const rawArchive = path.join(directory, 'image.raw.tar');
    report.steps.export = await execute('export', [
      'image',
      'save',
      '--output',
      rawArchive,
      digest,
    ]);
    let imageOci = null;
    if (verificationProfile) {
      const imageBase = require('./image-base.cjs');
      imageOci = await imageBase.extractImageOci(rawArchive, digest);
      imageBase.qualifyImageBase(candidate, imageOci);
    }
    const compressStarted = Date.now();
    await pipeline(
      fs.createReadStream(rawArchive),
      createGzip({ level: 6 }),
      fs.createWriteStream(archive, { flags: 'wx' }),
      { signal },
    );
    report.steps.compress = { status: 'passed', durationMs: Date.now() - compressStarted };
    fs.unlinkSync(rawArchive);
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
    report.archive = {
      file: path.relative(candidate.directory, archive).replaceAll('\\', '/'),
      bytes: fs.statSync(archive).size,
      sha256: hash.digest('hex'),
      compression: 'gzip',
    };
    if (verificationProfile)
      report.imageBase = require('./image-base.cjs').writeImageBase(
        candidate,
        report,
        imageOci,
        directory,
      );
    report.status = 'packaged';
    report.deployment =
      'Not performed. Require explicit publication command, current-server compatibility, fresh backups and existing restore procedure.';
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
  } finally {
    report.finishedAt = new Date().toISOString();
    try {
      if (fs.existsSync(directory)) writeJson(path.join(directory, 'image.json'), report);
    } finally {
      release();
    }
  }
  return report;
}
module.exports = { packageImage };
