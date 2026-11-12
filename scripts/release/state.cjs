const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { safePath, verifySnapshot, objectHash } = require('./files.cjs');
const { retryEnvironment } = require('./reuse.cjs');

function location(root, id) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id || '')) throw Error('Invalid candidate id');
  return safePath(root, '.release/candidates/' + id);
}

function writeJson(file, value) {
  const temp = file + '.next-' + randomUUID();
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(temp, file);
}

function readCandidate(root, id) {
  const directory = location(root, id);
  const data = JSON.parse(fs.readFileSync(safePath(directory, 'candidate.json'), 'utf8'));
  if (data.version !== 1 || data.id !== id || objectHash(data.files) !== data.sourceHash)
    throw Error('Invalid candidate identity');
  const source = safePath(directory, 'source');
  verifySnapshot(source, data.files);
  return { directory, source, data };
}

function lock(directory) {
  const file = safePath(directory, 'operation.lock');
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST')
      throw Error('Candidate is locked; inspect the previous process before removing its lock');
    throw error;
  }
  fs.writeFileSync(
    descriptor,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  return () => {
    fs.closeSync(descriptor);
    fs.unlinkSync(file);
  };
}

function freshReport(candidate, target, environment) {
  return {
    version: 1,
    candidate: candidate.id,
    sourceHash: candidate.sourceHash,
    target,
    environment,
    status: 'running',
    startedAt: new Date().toISOString(),
    steps: [],
  };
}

function reusable(previous, step, environment, sourceHash, policy) {
  return (
    !['dependencies', 'browser-install', 'git-init', 'git-index'].includes(step.id) &&
    !!environment &&
    previous?.sourceHash === sourceHash &&
    objectHash(retryEnvironment(previous.environment, previous.reusePolicy)) ===
      objectHash(retryEnvironment(environment, policy)) &&
    previous.steps?.some(
      (item) =>
        item.id === step.id && item.status === 'passed' && item.inputHash === objectHash(step),
    )
  );
}

module.exports = { location, writeJson, readCandidate, lock, freshReport, reusable };
