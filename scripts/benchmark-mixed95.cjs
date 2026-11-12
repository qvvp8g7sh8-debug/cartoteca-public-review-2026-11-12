// Unchanged92b scheduler/client/reconciliation;95 adds topology evidence without relabelling old runs.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { readJob, identity } = require('./benchmark-mixed95-profile.cjs');
async function run({ jobFile, ...options } = {}) {
  const job = readJob(jobFile);
  assert.equal(job.mode, 'benchmark');
  const result = await require('./benchmark-mixed92.cjs').run({
    ...options,
    directory: job.directory,
  });
  const raw = JSON.parse(fs.readFileSync(result.output, 'utf8'));
  assert.equal(raw.server.proofSha256, job.proofSha256);
  assert.equal(raw.server.topology, job.topology);
  assert.equal(raw.server.variant, job.variant);
  assert.equal(
    raw.server.rolesCorrect,
    true,
    'Missing role proof never becomes successful empty background',
  );
  raw.experiment = 'mixed95-topology-v1';
  raw.variant = job.variant;
  raw.provenance.harness95 = identity();
  raw.provenance.jobProofSha256 = job.proofSha256;
  raw.provenance.sourceSha256 = job.sourceSha256;
  raw.provenance.fixtureSha256 = job.fixtureSha256;
  raw.provenance.resourceBudget = job.resources;
  raw.limitations.push(
    'Single same-node web/background experiment; no horizontal web, HA, real provider or continuous voice capacity proof',
  );
  const output = result.output.replace(/-mixed92\.json$/, '-mixed95.json');
  assert.notEqual(output, result.output);
  fs.writeFileSync(output, JSON.stringify(raw, null, 2), { flag: 'wx', mode: 0o600 });
  return {
    ...result,
    output,
    rawUnmodified92ProducerOutput: result.output,
    topology: job.topology,
  };
}
module.exports = { run };
if (require.main === module)
  run({
    jobFile: process.argv[2],
    label: process.argv[3],
    seconds: Number(process.argv[4] || 60),
    rate: Number(process.argv[5] || 600),
    active: Number(process.argv[6] || 3000),
  })
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
