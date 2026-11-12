const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const {
  sampleIsolateMemory,
  assertNativeMemoryProcess,
} = require('../../src/server/infrastructure/native-memory-observation.cjs');

// This helper creates real isolates only. It opens no database, listener or DATA.
let descendantsStarted = 0;
function closedFailure(error) {
  return ['NATIVE_MEMORY_BUDGET_MISMATCH', 'NATIVE_MEMORY_BUDGET_INVALID'].includes(error?.code)
    ? error.code
    : 'PHYSICAL_PROBE_FAILED';
}
function child(input) {
  descendantsStarted++;
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {
      workerData: input,
      resourceLimits: input.processPlan.workerResourceLimits,
      ...(input.clearWorkerExecArgv ? { execArgv: [] } : {}),
    });
    let result;
    worker.once('message', (value) => {
      result = value;
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0 || !result) reject(Error('Physical probe did not close.'));
      else resolve(result);
    });
  });
}
async function largeQuery() {
  const path = require('node:path');
  const { createHash } = require('node:crypto');
  const { nativeIsolatedFixture } = require('./native-isolated-fixture.cjs');
  const { createStorage } = require('../../src/server/infrastructure/cabinet-storage.cjs');
  const {
    createNativeQueryKernel,
  } = require('../../src/server/infrastructure/native-query-kernel.cjs');
  const {
    largePatient,
    textFingerprint,
    jsonFingerprint,
  } = require('./native-memory-large139.cjs');
  const cleanup = [];
  let fixture, storage, kernel;
  const result = {};
  try {
    fixture = await nativeIsolatedFixture({ after: (callback) => cleanup.push(callback) });
    const actor = fixture.actors[0];
    storage = createStorage(path.join(fixture.directory, 'tenants', actor.organizationId));
    const initial = storage.read();
    const patient = largePatient(actor.patientId, initial.patients[0]);
    storage.write({ ...initial, patients: [patient] });
    const expected = jsonFingerprint(storage.read());
    assert.ok(expected.bytes > 32 * 1000 * 1000 && expected.bytes < 64 * 1024 * 1024);
    storage.close();
    storage = null;
    kernel = createNativeQueryKernel({ ...fixture.config, tenantReadCacheBytes: 8 * 1024 * 1024 });
    const disconnected = { configured: false, connected: false, botId: '' };
    const response = await kernel.run({
      method: 'GET',
      url: '/api/cabinet/patient?id=' + actor.patientId,
      localPort: 4174,
      remoteAddress: '127.0.0.1',
      headers: {
        host: '127.0.0.1:4174',
        cookie: 'cartoteca_v2_session=' + actor.token,
        'x-cartoteca-account-id': actor.accountId,
        'x-cartoteca-organization-id': actor.organizationId,
      },
      runtime: {
        timestamp: Date.now(),
        telegram: disconnected,
        providers: { telegram: disconnected, max: disconnected },
      },
    });
    result.status = response.status;
    result.bodyBytes = response.body.byteLength;
    result.bodySha256 = createHash('sha256').update(new Uint8Array(response.body)).digest('hex');
    result.expectedBodySha256 = expected.sha256;
    result.textSha256 = textFingerprint(patient);
    result.visits = patient.visits.length;
    result.actualQueryKernel = true;
    assert.equal(response.status, 200);
    assert.equal(result.bodyBytes, expected.bytes);
    assert.equal(result.bodySha256, expected.sha256);
  } finally {
    await kernel?.close();
    storage?.close();
    for (const callback of cleanup.reverse()) await callback();
    result.fixtureRemoved = !!fixture && !fs.existsSync(fixture.directory);
  }
  return result;
}
async function inspect(input) {
  const sample = sampleIsolateMemory();
  try {
    const attestation = input.unattested ? null : assertNativeMemoryProcess(input.processPlan);
    if (input.largeQuery)
      return {
        accepted: true,
        label: input.label,
        sample,
        attestation,
        descendantsStarted,
        children: [],
        largeQuery: await largeQuery(),
      };
    const children = await Promise.all(
      input.tree.map((entry) => child({ ...input, label: entry.label, tree: entry.children })),
    );
    return {
      accepted: true,
      label: input.label,
      sample,
      attestation,
      descendantsStarted,
      children,
    };
  } catch (error) {
    return {
      accepted: false,
      code: closedFailure(error),
      label: input.label,
      sample,
      descendantsStarted,
      children: [],
    };
  }
}
if (isMainThread) {
  const input = fs.readFileSync(0);
  if (input.length > 16384) throw Error('Physical input is too large.');
  const deadline = setTimeout(() => process.exit(3), 25000);
  deadline.unref();
  inspect(JSON.parse(input)).then(
    (result) => process.stdout.write(JSON.stringify(result) + '\n'),
    () => process.exit(2),
  );
} else {
  inspect(workerData).then(
    (result) => {
      parentPort.postMessage(result);
      parentPort.close();
    },
    () => process.exit(2),
  );
}
