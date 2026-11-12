const fs = require('node:fs');
const path = require('node:path');

function azureUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.blob.core.windows.net') ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  )
    throw Error('Unsupported artifact delivery URL');
  return url;
}

function leaseWindow(value, now = Date.now()) {
  const url = azureUrl(value);
  const expiry = Date.parse(url.searchParams.get('se'));
  const start = url.searchParams.get('st');
  if (!Number.isFinite(expiry) || (start && !Number.isFinite(Date.parse(start))))
    return { status: 'unknown-expiry', expiresAt: null, remainingMs: null };
  const remainingMs = expiry - now;
  return {
    status:
      start && Date.parse(start) > now
        ? 'not-yet-valid'
        : remainingMs <= 0
          ? 'expired'
          : remainingMs < 60000
            ? 'near-expiry'
            : 'ready',
    expiresAt: new Date(expiry).toISOString(),
    remainingMs,
  };
}

async function createLease({ repository, run, artifactId, token, fetcher = fetch }) {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    !/^\d+$/.test(String(run)) ||
    !/^\d+$/.test(String(artifactId))
  )
    throw Error('Invalid GitHub artifact coordinates');
  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const base = 'https://api.github.com/repos/' + repository;
  const metadataResponse = await fetcher(base + '/actions/artifacts/' + artifactId, {
    headers,
    signal: AbortSignal.timeout(30000),
  });
  if (!metadataResponse.ok) throw Error('Artifact metadata request failed');
  const metadata = await metadataResponse.json();
  if (
    metadata.id !== Number(artifactId) ||
    metadata.name !== 'verified-release' ||
    metadata.expired ||
    metadata.workflow_run?.id !== Number(run) ||
    !/^[a-f0-9]{40}$/.test(metadata.workflow_run.head_sha) ||
    !/^sha256:[a-f0-9]{64}$/.test(metadata.digest) ||
    !Number.isSafeInteger(metadata.size_in_bytes) ||
    metadata.size_in_bytes < 1
  )
    throw Error('Artifact metadata does not match verified release');
  const response = await fetcher(base + '/actions/artifacts/' + artifactId + '/zip', {
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
  });
  if (response.status !== 302) throw Error('Artifact redirect request failed');
  const downloadUrl = response.headers.get('location');
  azureUrl(downloadUrl);
  return {
    version: 1,
    repository,
    run: Number(run),
    head: metadata.workflow_run.head_sha,
    artifactId: metadata.id,
    digest: metadata.digest,
    bytes: metadata.size_in_bytes,
    downloadUrl,
    expiresAt: leaseWindow(downloadUrl).expiresAt,
    createdAt: new Date().toISOString(),
  };
}

async function main() {
  const lease = await createLease({
    repository: process.env.GITHUB_REPOSITORY,
    run: process.env.RELEASE_RUN_ID,
    artifactId: process.env.RELEASE_ARTIFACT_ID,
    token: process.env.GITHUB_TOKEN,
  });
  const directory = path.join(process.env.RUNNER_TEMP, 'release-delivery-lease');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'delivery-lease.json'), JSON.stringify(lease) + '\n', {
    mode: 0o600,
  });
  // The signed URL is private artifact content; never print it or include it in image/request/state.
  console.log('Temporary delivery lease prepared for artifact ' + lease.artifactId);
}
if (require.main === module)
  main().catch(() => {
    console.error('Delivery lease unavailable');
    process.exitCode = 1;
  });
module.exports = { azureUrl, createLease, leaseWindow };
