// Same-node topology experiment only. Importing never creates data or starts work.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const legacy = require('./benchmark-mixed92-profile.cjs');
// Root-approved closed transport-error diagnostics are the only change since92b.
const REUSE_PIN = 'b9fdbafe10e47b73074f03e83ea8af7faf493a74c180676392f9eadcf9a891f6';
const roles = Object.freeze({
  combined: Object.freeze({
    sut: { processRole: 'combined', cpus: 1.5, memoryMiB: 2048, pool: 64, cacheMiB: 64 },
    generator: { cpus: 0.5, memoryMiB: 512 },
  }),
  split: Object.freeze({
    api: { processRole: 'web', cpus: 1, memoryMiB: 1536, pool: 48, cacheMiB: 48 },
    background: { processRole: 'background', cpus: 0.5, memoryMiB: 512, pool: 16, cacheMiB: 16 },
    generator: { cpus: 0.5, memoryMiB: 512 },
  }),
});
const names = ['profile', 'control', 'adapters', 'runtime', 'server', 'background'].map(
  (name) => 'benchmark-mixed95-' + name + '.cjs',
);
names.push('benchmark-mixed95.cjs');
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function identity() {
  const reused = legacy.identity();
  assert.equal(reused.sha256, REUSE_PIN, 'Frozen92b workload helpers changed');
  const files = Object.fromEntries(
    names.map((name) => [name, digest(fs.readFileSync(path.join(__dirname, name)))]),
  );
  return {
    format: 'mixed95-harness-v1',
    files,
    reused,
    sha256: digest(JSON.stringify({ files, reused })),
  };
}
function budget(topology) {
  assert.ok(Object.hasOwn(roles, topology));
  const selected = structuredClone(roles[topology]),
    values = Object.values(selected);
  assert.equal(
    values.reduce((sum, value) => sum + value.cpus, 0),
    2,
  );
  assert.equal(
    values.reduce((sum, value) => sum + value.memoryMiB, 0),
    2560,
  );
  assert.equal(
    values.reduce((sum, value) => sum + (value.pool || 0), 0),
    64,
  );
  assert.equal(
    values.reduce((sum, value) => sum + (value.cacheMiB || 0), 0),
    64,
  );
  return selected;
}
function validateJob(value) {
  assert.deepEqual(
    Object.keys(value).sort(),
    [
      'format',
      'jobId',
      'mode',
      'variant',
      'topology',
      'functionalScenario',
      'resources',
      'sourceRoot',
      'directory',
      'controlDirectory',
      'port',
      'applicationOrigin',
      'sourceSha256',
      'sourceManifestSha256',
      'fixtureSha256',
      'notificationManifestSha256',
      'harnessSha256',
      'schema',
      'assistantSaving',
      'providerNetwork',
      'assistantDialogueCapacity',
      'assistantStateBackend',
      'notificationMaintenanceEnabled',
      'sharedCabinetWrites',
      'isolatedReadBudgets',
      'modelDelayMs',
      'notificationDelayMs',
      'proofSha256',
    ].sort(),
    'Unknown job options cannot alter role composition',
  );
  assert.equal(value.format, 'mixed95-job-v1');
  assert.match(value.jobId, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
  assert.ok(['functional', 'benchmark'].includes(value.mode));
  assert.ok(['current', 'counterfactual-legacy-push'].includes(value.variant));
  if (value.variant === 'counterfactual-legacy-push') assert.equal(value.topology, 'combined');
  assert.deepEqual(value.resources, budget(value.topology));
  for (const key of [
    'sourceSha256',
    'sourceManifestSha256',
    'fixtureSha256',
    'notificationManifestSha256',
    'harnessSha256',
  ])
    assert.match(value[key], /^[a-f0-9]{64}$/);
  for (const key of ['directory', 'sourceRoot', 'controlDirectory']) {
    assert.equal(path.resolve(value[key]), value[key]);
    assert.equal(fs.realpathSync(value[key]), value[key]);
    assert.ok(!fs.lstatSync(value[key]).isSymbolicLink());
  }
  if (value.mode === 'benchmark') {
    assert.equal(value.directory, '/tmp/cartoteca-organizations-load');
    assert.equal(value.sourceRoot, '/app');
    assert.equal(value.controlDirectory, '/control');
    assert.equal(process.platform, 'linux');
    assert.equal(process.getuid(), 1000);
  } else {
    const owned = path.dirname(value.directory);
    assert.equal(path.dirname(owned), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(owned), /^cartoteca-mixed95-[A-Za-z0-9_-]+$/);
    assert.equal(value.directory, path.join(owned, 'data'));
    assert.equal(value.controlDirectory, path.join(owned, 'control'));
    assert.equal(value.sourceRoot, fs.realpathSync(path.join(__dirname, '..')));
  }
  assert.equal(value.assistantSaving, false);
  assert.equal(value.providerNetwork, false);
  assert.equal(value.assistantDialogueCapacity, 500);
  assert.ok(['file', 'rows-v1'].includes(value.assistantStateBackend));
  assert.equal(typeof value.notificationMaintenanceEnabled, 'boolean');
  assert.equal(value.sharedCabinetWrites, value.isolatedReadBudgets);
  assert.equal(typeof value.sharedCabinetWrites, 'boolean');
  assert.equal(value.modelDelayMs, 3000);
  assert.equal(value.notificationDelayMs, 3);
  assert.ok(
    ['standard', 'telegram429', 'slow-telegram', 'max-answer-retry'].includes(
      value.functionalScenario,
    ),
  );
  if (value.mode === 'benchmark') assert.equal(value.functionalScenario, 'standard');
  assert.ok(
    Number.isInteger(value.port) &&
      value.port >= 1024 &&
      value.port <= 65535 &&
      ![4174, 4186].includes(value.port),
  );
  const origin = new URL(value.applicationOrigin);
  assert.equal(origin.protocol, 'https:');
  assert.ok(['127.0.0.1', '10.234.12.2'].includes(origin.hostname));
  assert.equal(origin.port, String(value.port));
  assert.equal(origin.username + origin.password + origin.search + origin.hash, '');
  assert.equal(origin.pathname, '/');
  if (value.mode === 'benchmark') assert.equal(value.port, 4173);
  assert.ok(
    value.mode === 'functional' ? [17, 19, 20].includes(value.schema) : value.schema === 19,
  );
  const proof = { ...value };
  delete proof.proofSha256;
  assert.equal(value.proofSha256, digest(JSON.stringify(proof)), 'Job proof mismatch');
  return value;
}
function readJob(file) {
  assert.equal(fs.realpathSync(file), file);
  assert.ok(fs.statSync(file).size <= 16384);
  const job = validateJob(JSON.parse(fs.readFileSync(file, 'utf8')));
  const marker = JSON.parse(
    fs.readFileSync(path.join(job.controlDirectory, 'MIXED95-OWNED.json'), 'utf8'),
  );
  assert.equal(marker.jobId, job.jobId);
  assert.equal(marker.syntheticOnly, true);
  assert.equal(marker.proofSha256, job.proofSha256);
  assert.equal(
    digest(fs.readFileSync(path.join(job.directory, 'mixed95-fixture.json'))),
    job.fixtureSha256,
  );
  assert.equal(
    digest(fs.readFileSync(path.join(job.directory, 'notifications-profile.json'))),
    job.notificationManifestSha256,
  );
  assert.equal(
    digest(fs.readFileSync(path.join(job.controlDirectory, 'source-manifest.json'))),
    job.sourceManifestSha256,
  );
  assert.equal(identity().sha256, job.harnessSha256);
  return job;
}
function controlIdentity(job, role) {
  assert.ok(Object.hasOwn(job.resources, role) && role !== 'generator');
  return {
    jobId: job.jobId,
    role,
    proofSha256: job.proofSha256,
    sourceSha256: job.sourceSha256,
    fixtureSha256: job.fixtureSha256,
    harnessSha256: job.harnessSha256,
  };
}
function socketPath(job, role) {
  controlIdentity(job, role);
  // Windows pipes are finite functional-test transport only; benchmark remains Unix-only.
  if (process.platform === 'win32') {
    assert.equal(job.mode, 'functional', 'Ubuntu Unix sockets required for measurement');
    return '\\\\.\\pipe\\cartoteca-synthetic95-' + job.jobId + '-' + role;
  }
  const socket = path.join(job.controlDirectory, role + '.sock');
  assert.ok(Buffer.byteLength(socket) < 100, 'Unix socket path exceeds bounded lab contract');
  return socket;
}
module.exports = {
  ...legacy,
  REUSE_PIN,
  digest,
  identity,
  budget,
  validateJob,
  readJob,
  controlIdentity,
  socketPath,
};
