const fs = require('node:fs');
const path = require('node:path');
const { azureUrl, leaseWindow } = require('./github-lease.cjs');
const { writeJson } = require('./state.cjs');

function deliveryPayload(candidate, state, request, lease, metadata) {
  azureUrl(lease.downloadUrl);
  const github = candidate.data.github;
  if (
    !github ||
    lease.version !== 1 ||
    lease.repository !== github.repository ||
    lease.run !== github.run ||
    lease.head !== github.head ||
    candidate.data.id !== 'ci-' + lease.run ||
    lease.artifactId !== metadata.id ||
    metadata.name !== 'verified-release' ||
    metadata.expired ||
    lease.digest !== metadata.digest ||
    lease.bytes !== metadata.size_in_bytes ||
    metadata.workflow_run?.id !== github.run ||
    metadata.workflow_run.head_sha !== github.head ||
    !/^sha256:[a-f0-9]{64}$/.test(lease.digest) ||
    !Number.isSafeInteger(lease.bytes) ||
    lease.bytes < 1 ||
    state.status !== 'prepared' ||
    state.sourceHash !== candidate.data.sourceHash ||
    request.sourceHash !== candidate.data.sourceHash ||
    request.candidate !== candidate.data.id
  )
    throw Error('Delivery lease does not match the independently verified candidate/artifact');
  const created = Date.parse(lease.createdAt);
  if (!Number.isFinite(created) || created > Date.now() + 60000 || Date.now() - created > 3600000)
    throw Error('Delivery lease is stale; obtain a fresh lease or use SCP');
  const entry = path.relative(candidate.directory, state.archive).replaceAll('\\', '/');
  if (!/^image-\d+\/image\.tar$/.test(entry)) throw Error('Invalid image artifact entry');
  return {
    url: lease.downloadUrl,
    zipBytes: lease.bytes,
    zipHash: lease.digest.slice(7),
    sourceHash: request.sourceHash,
    entry,
  };
}

async function deliver(network, candidate, state, request, opts, directory) {
  if (!opts['delivery-lease'] && !opts['delivery-artifact'])
    return network.upload([state.archive], state.remote);
  if (!opts['delivery-lease'] || !opts['delivery-artifact'])
    throw Error('Lease and independent artifact metadata are both required');
  const payload = deliveryPayload(
    candidate,
    state,
    request,
    JSON.parse(fs.readFileSync(opts['delivery-lease'], 'utf8')),
    JSON.parse(fs.readFileSync(opts['delivery-artifact'], 'utf8')),
  );
  const window = leaseWindow(payload.url);
  const started = Date.now();
  const record = (status, reason, httpStatus = null) => {
    fs.appendFileSync(
      path.join(directory, 'delivery-attempts.jsonl'),
      JSON.stringify({
        version: 1,
        method: 'GitHub-Azure-direct',
        status,
        reason,
        httpStatus:
          Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599
            ? httpStatus
            : null,
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        expiresAt: window.expiresAt,
        remainingMs: window.remainingMs,
      }) + '\n',
    );
  };
  const fallback = async () => {
    const transferStarted = Date.now();
    try {
      const result = await network.upload([state.archive], state.remote);
      fs.appendFileSync(
        path.join(directory, 'delivery-attempts.jsonl'),
        JSON.stringify({
          version: 1,
          method: 'SCP',
          status: 'passed',
          reason: 'direct-fallback',
          startedAt: new Date(transferStarted).toISOString(),
          durationMs: Date.now() - transferStarted,
        }) + '\n',
      );
      return result;
    } catch (error) {
      fs.appendFileSync(
        path.join(directory, 'delivery-attempts.jsonl'),
        JSON.stringify({
          version: 1,
          method: 'SCP',
          status: 'failed',
          reason: 'transport',
          startedAt: new Date(transferStarted).toISOString(),
          durationMs: Date.now() - transferStarted,
        }) + '\n',
      );
      throw error;
    }
  };
  if (window.status !== 'ready') {
    record('skipped', window.status);
    console.log('Direct delivery skipped (' + window.status + '); using verified SCP');
    return fallback();
  }
  const result = JSON.parse(
    await network.ssh(
      'transfer-direct',
      ['python3', '-B', state.remote + '/delivery.py', state.remote, state.requestHash],
      JSON.stringify(payload),
    ),
  );
  if (result.status === 'unavailable') {
    record(
      'unavailable',
      ['http', 'timeout', 'network'].includes(result.reason) ? result.reason : 'download',
      result.httpStatus,
    );
    console.log('Direct download unavailable; transferring the verified archive over SCP');
    return fallback();
  }
  if (
    result.status !== 'passed' ||
    result.imageHash !== request.imageHash ||
    result.imageBytes !== request.imageBytes
  ) {
    record('failed', 'verification');
    throw Error('Direct delivery proof does not match the verified image');
  }
  record('passed', 'verified');
  writeJson(path.join(directory, 'delivery-proof.json'), result);
}
module.exports = { deliveryPayload, deliver };
