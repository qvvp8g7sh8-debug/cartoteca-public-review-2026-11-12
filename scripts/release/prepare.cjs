const fs = require('node:fs');
const path = require('node:path');
const { copySnapshot, manifest, objectHash, safePath } = require('./files.cjs');
const { location, writeJson } = require('./state.cjs');
const { runProcess } = require('./process.cjs');
const { prepareProfile } = require('./verification-profile.cjs');

async function prepare(root, id, signal, { profile = 'full', baselineId, selectionMode } = {}) {
  if (
    selectionMode !== undefined &&
    (profile !== 'assistant-ui' ||
      !['client-audio-hotfix-v1', 'assistant-audio-session-v1', 'assistant-behavior-v1'].includes(
        selectionMode,
      ))
  )
    throw Error('Unknown or incompatible selection mode');
  if (!['full', 'assistant-ui'].includes(profile)) throw Error('Unknown verification profile');
  if (profile === 'assistant-ui' && !baselineId)
    throw Error('assistant-ui requires an explicit qualified baseline');
  if (profile === 'full' && baselineId)
    throw Error('A baseline cannot reduce the full verification profile');
  const directory = location(root, id);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  fs.mkdirSync(directory); // Existing candidates are never overwritten.
  const source = safePath(directory, 'source');
  fs.mkdirSync(source);
  const original = copySnapshot(root, source);
  // Validate the code-only snapshot, not the workspace where excluded reports may exist.
  const documentation = await runProcess(process.execPath, ['scripts/check-docs.cjs'], {
    cwd: source,
    log: path.join(directory, 'prepare-docs.txt'),
    signal,
  });
  if (documentation.status !== 'passed')
    throw Error('Candidate documentation failed; see prepare-docs.txt');
  const build = await runProcess(process.execPath, ['scripts/build-client.cjs'], {
    cwd: source,
    log: path.join(directory, 'prepare-build.txt'),
    signal,
  });
  if (build.status !== 'passed') throw Error('Candidate build failed; see prepare-build.txt');
  const files = manifest(source);
  for (const required of ['package.json', 'package-lock.json', 'Dockerfile', 'scripts/release.cjs'])
    if (!files[required]) throw Error('Incomplete candidate: ' + required);
  const data = {
    version: 1,
    id,
    createdAt: new Date().toISOString(),
    profile,
    ...(selectionMode ? { selectionMode } : {}),
    ...(process.env.GITHUB_ACTIONS === 'true'
      ? {
          github: {
            repository: process.env.GITHUB_REPOSITORY,
            run: Number(process.env.GITHUB_RUN_ID),
            head: process.env.GITHUB_SHA,
          },
        }
      : {}),
    originalHash: objectHash(original),
    sourceHash: objectHash(files),
    files,
  };
  if (profile === 'assistant-ui') {
    const receipt = await prepareProfile(
      root,
      { directory, source, data },
      { profile, baselineId, selectionMode },
    );
    data.profileHash = receipt.profileHash;
  }
  writeJson(path.join(directory, 'candidate.json'), data);
  return {
    id,
    sourceHash: data.sourceHash,
    state: 'prepared',
    ...(selectionMode ? { selectionMode, scope: 'targeted', fullVerification: false } : {}),
    files: Object.keys(files).length,
    ...(profile === 'assistant-ui' ? { profile, profileHash: data.profileHash } : {}),
  };
}
module.exports = { prepare };
