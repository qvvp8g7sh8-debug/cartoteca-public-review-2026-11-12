const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLease, azureUrl, leaseWindow } = require('../scripts/release/github-lease.cjs');
const { deliveryPayload, deliver } = require('../scripts/release/delivery.cjs');
const cycle = require('../scripts/release/cycle.cjs');
const { execFileSync } = require('node:child_process');
const now = new Date().toISOString();
function data() {
  const github = { repository: 'synthetic/repo', run: 123, head: 'a'.repeat(40) };
  const candidate = {
    directory: path.resolve('synthetic'),
    data: { id: 'ci-123', github, sourceHash: 'b'.repeat(64) },
  };
  const state = {
    status: 'prepared',
    sourceHash: candidate.data.sourceHash,
    archive: path.join(candidate.directory, 'image-100/image.tar'),
    remote: '/synthetic',
    requestHash: 'c'.repeat(64),
  };
  const request = {
    candidate: 'ci-123',
    sourceHash: candidate.data.sourceHash,
    imageBytes: 12,
    imageHash: 'd'.repeat(64),
  };
  const metadata = {
    id: 5,
    name: 'verified-release',
    digest: 'sha256:' + 'e'.repeat(64),
    size_in_bytes: 100,
    expired: false,
    workflow_run: { id: github.run, head_sha: github.head },
  };
  const lease = {
    version: 1,
    repository: github.repository,
    run: github.run,
    head: github.head,
    artifactId: metadata.id,
    digest: metadata.digest,
    bytes: metadata.size_in_bytes,
    downloadUrl:
      'https://synthetic.blob.core.windows.net/artifact?sig=SYNTHETIC&se=' +
      encodeURIComponent(new Date(Date.now() + 3600000).toISOString()),
    createdAt: now,
  };
  return { candidate, state, request, metadata, lease };
}
test('lease only accepts the original Azure redirect and exact artifact metadata', async () => {
  const f = data();
  const requests = [];
  const lease = await createLease({
    repository: 'synthetic/repo',
    run: 123,
    artifactId: 5,
    token: 'SYNTHETIC',
    fetcher: async (url, opts) => {
      requests.push({ url, opts });
      return url.endsWith('/zip')
        ? { status: 302, headers: new Headers({ location: f.lease.downloadUrl }) }
        : { ok: true, json: async () => f.metadata };
    },
  });
  assert.equal(lease.downloadUrl, f.lease.downloadUrl);
  assert.equal(lease.expiresAt, leaseWindow(f.lease.downloadUrl).expiresAt);
  assert.equal(requests[1].opts.redirect, 'manual');
  for (const url of [
    'http://synthetic.blob.core.windows.net/a',
    'https://blob.core.windows.net.attacker.invalid/a',
    'https://user:pass@synthetic.blob.core.windows.net/a',
    'https://synthetic.blob.core.windows.net:123/a',
  ])
    assert.throws(() => azureUrl(url));
});
test('delivery binds source, run, head, independent ZIP digest and exact image entry', () => {
  const f = data();
  assert.equal(
    deliveryPayload(f.candidate, f.state, f.request, f.lease, f.metadata).entry,
    'image-100/image.tar',
  );
  for (const change of [
    { artifactId: 6 },
    { run: 124 },
    { digest: 'sha256:' + 'f'.repeat(64) },
    { head: 'f'.repeat(40) },
    { repository: 'other/repo' },
    { createdAt: '2020-01-01' },
  ])
    assert.throws(() =>
      deliveryPayload(f.candidate, f.state, f.request, { ...f.lease, ...change }, f.metadata),
    );
});
test('URL travels via stdin; only download unavailability falls back, corrupt proof never does', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-delivery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = data();
  fs.writeFileSync(path.join(dir, 'lease.json'), JSON.stringify(f.lease));
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(f.metadata));
  const opts = {
    'delivery-lease': path.join(dir, 'lease.json'),
    'delivery-artifact': path.join(dir, 'metadata.json'),
  };
  let uploads = 0,
    response = { status: 'passed', imageBytes: 12, imageHash: f.request.imageHash };
  const network = {
    upload: async () => {
      uploads++;
    },
    ssh: async (name, args, input) => {
      assert.equal(name, 'transfer-direct');
      assert.ok(!args.join(' ').includes('SYNTHETIC'));
      assert.equal(JSON.parse(input).url, f.lease.downloadUrl);
      return JSON.stringify(response);
    },
  };
  await deliver(network, f.candidate, f.state, f.request, opts, dir);
  assert.equal(uploads, 0);
  response = { status: 'unavailable' };
  await deliver(network, f.candidate, f.state, f.request, opts, dir);
  assert.equal(uploads, 1);
  response = { status: 'passed', imageBytes: 12, imageHash: 'corrupt' };
  await assert.rejects(() => deliver(network, f.candidate, f.state, f.request, opts, dir));
  assert.equal(uploads, 1);
  const events = fs.readFileSync(path.join(dir, 'delivery-attempts.jsonl'), 'utf8');
  assert.ok(!events.includes('SYNTHETIC') && !events.includes('downloadUrl'));
  assert.ok(events.includes('verification'));
});

test('signed URL expiry, not lease age, decides whether a direct attempt is useful', () => {
  const now = Date.parse('2026-10-09T11:10:27Z');
  const url = (expiry) =>
    'https://synthetic.blob.core.windows.net/a?se=' + encodeURIComponent(expiry);
  assert.equal(leaseWindow(url('2026-10-09T11:09:43Z'), now).status, 'expired');
  assert.equal(leaseWindow(url('2026-10-09T11:11:26Z'), now).status, 'near-expiry');
  assert.equal(leaseWindow(url('2026-10-09T11:11:27Z'), now).status, 'ready');
  assert.equal(leaseWindow(url('invalid'), now).status, 'unknown-expiry');
  assert.equal(
    leaseWindow(url('2026-10-09T11:20:00Z') + '&st=2026-10-09T11:15:00Z', now).status,
    'not-yet-valid',
  );
});

test('expired, unknown and almost expired links skip SSH direct but cannot bypass artifact binding', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-delivery-expiry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = data();
  const opts = {
    'delivery-lease': path.join(dir, 'lease.json'),
    'delivery-artifact': path.join(dir, 'metadata.json'),
  };
  fs.writeFileSync(opts['delivery-artifact'], JSON.stringify(f.metadata));
  let uploads = 0;
  const network = {
    ssh: async () => {
      throw Error('Expired direct URL was contacted');
    },
    upload: async () => {
      uploads++;
    },
  };
  for (const expiry of [Date.now() - 1, Date.now() + 10000, null]) {
    const url = new URL(f.lease.downloadUrl);
    if (expiry === null) url.searchParams.delete('se');
    else url.searchParams.set('se', new Date(expiry).toISOString());
    fs.writeFileSync(opts['delivery-lease'], JSON.stringify({ ...f.lease, downloadUrl: url.href }));
    await deliver(network, f.candidate, f.state, f.request, opts, dir);
  }
  assert.equal(uploads, 3);
  fs.writeFileSync(opts['delivery-artifact'], JSON.stringify({ ...f.metadata, id: 6 }));
  await assert.rejects(
    deliver(network, f.candidate, f.state, f.request, opts, dir),
    /does not match/,
  );
  assert.equal(uploads, 3);
  const events = fs.readFileSync(path.join(dir, 'delivery-attempts.jsonl'), 'utf8');
  assert.ok(
    events.includes('expired') &&
      events.includes('near-expiry') &&
      events.includes('unknown-expiry'),
  );
  assert.equal(events.includes('SYNTHETIC'), false);
});

test('HTTP fallback reasons are bounded and diagnostics never serialize remote error text', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-delivery-reason-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = data();
  const opts = {
    'delivery-lease': path.join(dir, 'lease.json'),
    'delivery-artifact': path.join(dir, 'metadata.json'),
  };
  fs.writeFileSync(opts['delivery-lease'], JSON.stringify(f.lease));
  fs.writeFileSync(opts['delivery-artifact'], JSON.stringify(f.metadata));
  let response = {
    status: 'unavailable',
    reason: 'http',
    httpStatus: 403,
    error: f.lease.downloadUrl,
  };
  const network = { ssh: async () => JSON.stringify(response), upload: async () => {} };
  await deliver(network, f.candidate, f.state, f.request, opts, dir);
  response = {
    status: 'unavailable',
    reason: f.lease.downloadUrl,
    httpStatus: f.lease.downloadUrl,
  };
  await deliver(network, f.candidate, f.state, f.request, opts, dir);
  const rows = fs
    .readFileSync(path.join(dir, 'delivery-attempts.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(rows[0].httpStatus, 403);
  assert.equal(rows[2].reason, 'download');
  assert.equal(rows[2].httpStatus, null);
  assert.equal(JSON.stringify(rows).includes('SYNTHETIC'), false);
});
test('complete cycle retains queues, retries and unclassified work without double-counting parallel time', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-cycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stamp = (seconds) =>
    new Date(Date.parse('2026-10-09T00:00:00Z') + seconds * 1000).toISOString();
  cycle.start(root, 'test', stamp(0), stamp(10));
  cycle.mark(root, 'test', 'github', 'start', stamp(20));
  cycle.mark(root, 'test', 'preparation', 'start', stamp(25));
  cycle.mark(root, 'test', 'preparation', 'failed', stamp(30));
  cycle.mark(root, 'test', 'github', 'passed', stamp(40));
  cycle.mark(root, 'test', 'preparation', 'start', stamp(45));
  cycle.mark(root, 'test', 'preparation', 'passed', stamp(50));
  const result = cycle.finish(root, 'test', stamp(60));
  assert.equal(result.totalMs, 60000);
  assert.equal(result.measuredMs, 25000);
  assert.equal(result.unclassifiedMs, 35000);
  assert.equal(result.attempts.filter((a) => a.stage === 'preparation').length, 2);
  assert.throws(() => cycle.mark(root, 'test', 'documentation', 'start'), /closed/);
});
test(
  'Python receiver checks ZIP/image hashes, bounds, duplicate entries and temporary cleanup offline',
  { skip: process.platform === 'win32' && !process.env.CARTOTECA_TEST_PYTHON },
  () => {
    execFileSync(
      process.env.CARTOTECA_TEST_PYTHON || 'python3',
      ['-I', '-B', path.join(__dirname, 'helpers/release-delivery.py')],
      { encoding: 'utf8', timeout: 30000, windowsHide: true },
    );
  },
);
