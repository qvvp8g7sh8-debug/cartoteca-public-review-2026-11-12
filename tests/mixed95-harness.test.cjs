const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const profile = require('../scripts/benchmark-mixed95-profile.cjs');
const control = require('../scripts/benchmark-mixed95-control.cjs');
const { aggregate } = require('../scripts/benchmark-mixed95-server.cjs');

const identity = {
  jobId: randomUUID(),
  role: 'background',
  sourceSha256: 'a'.repeat(64),
  proofSha256: 'b'.repeat(64),
  fixtureSha256: 'c'.repeat(64),
  harnessSha256: 'd'.repeat(64),
};

test('both95 topologies retain identical total resources and approved unchanged workload helpers', () => {
  for (const topology of ['combined', 'split']) {
    const budget = profile.budget(topology),
      values = Object.values(budget);
    assert.equal(
      values.reduce((n, v) => n + v.cpus, 0),
      2,
    );
    assert.equal(
      values.reduce((n, v) => n + v.memoryMiB, 0),
      2560,
    );
    assert.equal(
      values.reduce((n, v) => n + (v.pool || 0), 0),
      64,
    );
    assert.equal(
      values.reduce((n, v) => n + (v.cacheMiB || 0), 0),
      64,
    );
    budget.generator.cpus = 100;
    assert.equal(profile.budget(topology).generator.cpus, 0.5);
  }
  assert.equal(profile.identity().reused.sha256, profile.REUSE_PIN);
  assert.throws(() => profile.budget('remote'));
});

test('closed synthetic job rejects external origins, hidden configuration, changed budgets and unproved source', (t) => {
  const owned = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cartoteca-mixed95-'));
  const directory = path.join(owned, 'data'),
    controlDirectory = path.join(owned, 'control');
  fs.mkdirSync(directory);
  fs.mkdirSync(controlDirectory);
  t.after(() => fs.rmSync(owned, { recursive: true }));
  const job = {
    format: 'mixed95-job-v1',
    jobId: randomUUID(),
    mode: 'functional',
    variant: 'current',
    topology: 'split',
    functionalScenario: 'standard',
    resources: profile.budget('split'),
    sourceRoot: fs.realpathSync(path.join(__dirname, '..')),
    directory,
    controlDirectory,
    port: 45001,
    applicationOrigin: 'https://127.0.0.1:45001',
    sourceSha256: 'a'.repeat(64),
    sourceManifestSha256: 'b'.repeat(64),
    fixtureSha256: 'c'.repeat(64),
    notificationManifestSha256: 'd'.repeat(64),
    harnessSha256: profile.identity().sha256,
    schema: 17,
    assistantSaving: false,
    providerNetwork: false,
    assistantDialogueCapacity: 500,
    assistantStateBackend: 'file',
    notificationMaintenanceEnabled: false,
    sharedCabinetWrites: false,
    isolatedReadBudgets: false,
    modelDelayMs: 3000,
    notificationDelayMs: 3,
  };
  const prove = (value) => ({ ...value, proofSha256: profile.digest(JSON.stringify(value)) });
  assert.equal(profile.validateJob(prove(job)).port, 45001);
  for (const mutate of [
    (v) => {
      v.applicationOrigin = 'https://example.org:45001';
    },
    (v) => {
      v.directory = fs.realpathSync(os.tmpdir());
    },
    (v) => {
      v.assistantSaving = true;
    },
    (v) => {
      v.providerNetwork = true;
    },
    (v) => {
      v.notificationDelayMs = 0;
    },
    (v) => {
      v.modelDelayMs = 0;
    },
    (v) => {
      v.resources.background.memoryMiB = 2048;
    },
    (v) => {
      v.port = 4174;
    },
    (v) => {
      v.port = 4186;
    },
    (v) => {
      v.isolatedReadBudgets = true;
    },
    (v) => {
      v.arbitraryCommand = 'anything';
    },
    (v) => {
      v.variant = 'counterfactual-legacy-push';
    },
  ]) {
    const altered = structuredClone(job);
    mutate(altered);
    assert.throws(() => profile.validateJob(prove(altered)));
  }
  assert.throws(() => profile.validateJob({ ...prove(job), proofSha256: 'f'.repeat(64) }));
});

test('bounded control enforces identity, closed verbs, phases, exact replay and failures', async () => {
  const calls = [],
    phases = control.createPhases(
      identity,
      Object.fromEntries(
        ['ready', 'start', 'stop', 'snapshot'].map((verb) => [
          verb,
          async () => {
            calls.push(verb);
            return verb;
          },
        ]),
      ),
    );
  await assert.rejects(phases.dispatch({ ...control.request(identity, 'ready'), sql: 'anything' }));
  await assert.rejects(
    phases.dispatch(control.request({ ...identity, jobId: randomUUID() }, 'start')),
  );
  await assert.rejects(phases.dispatch({ ...control.request(identity, 'ready'), verb: 'exec' }));
  await assert.rejects(phases.dispatch(control.request(identity, 'snapshot')));
  const start = control.request(identity, 'start');
  const receipt = await phases.dispatch(start);
  assert.deepEqual(await phases.dispatch(start), receipt);
  assert.deepEqual(calls, ['start']);
  await assert.rejects(phases.dispatch({ ...start, verb: 'stop' }));
  await assert.rejects(phases.dispatch(control.request(identity, 'ready')));
  await phases.dispatch(control.request(identity, 'stop'));
  assert.equal((await phases.dispatch(control.request(identity, 'snapshot'))).phase, 'stopped');
  await assert.rejects(phases.dispatch(control.request(identity, 'start')));
  const failed = control.createPhases(identity, {
    start: async () => {
      throw Error('Synthetic stop');
    },
  });
  await assert.rejects(failed.dispatch(control.request(identity, 'start')), /Synthetic stop/);
  assert.equal(failed.phase(), 'failed');
  await assert.rejects(failed.dispatch(control.request(identity, 'start')));
});

test('actual local control rejects oversized and multiline framing without invoking handlers', async (t) => {
  const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-control95-'));
  const endpoint =
    process.platform === 'win32'
      ? '\\\\.\\pipe\\cartoteca-control95-' + randomUUID()
      : path.join(owned, 'role.sock');
  let calls = 0;
  const phases = control.createPhases(identity, { ready: async () => ++calls });
  const server = await control.listen(endpoint, phases);
  t.after(async () => {
    await server.close();
    fs.rmSync(owned, { recursive: true });
  });
  assert.equal(await control.call(endpoint, identity, 'ready'), 1);
  const raw = (body) =>
    new Promise((resolve, reject) => {
      const client = net.createConnection(endpoint);
      let reply = '';
      client.on('connect', () => client.write(body));
      client.on('data', (chunk) => {
        reply += chunk;
      });
      client.on('error', (error) => (error.code === 'ECONNRESET' ? resolve(reply) : reject(error)));
      client.on('end', () => resolve(reply));
      client.setTimeout(2000, () => client.destroy(Error('Finite control timeout')));
    });
  const one = JSON.stringify(control.request(identity, 'ready'));
  assert.equal(JSON.parse(await raw(one + '\n' + one + '\n')).ok, false);
  assert.equal(await raw('x'.repeat(control.MAX_REQUEST + 1)), '');
  assert.equal(calls, 1);
});

test('control client rejects abrupt close, overlarge reply and mismatched receipt without hanging', async (t) => {
  const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-control95-'));
  t.after(() => fs.rmSync(owned, { recursive: true }));
  for (const scenario of ['closed', 'oversized', 'identity']) {
    const endpoint =
      process.platform === 'win32'
        ? '\\\\.\\pipe\\cartoteca-control95-' + randomUUID()
        : path.join(owned, scenario + '.sock');
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      let bytes = '';
      socket.on('error', () => {});
      let consumed = false;
      socket.on('data', (chunk) => {
        bytes += chunk;
        if (consumed || !bytes.includes('\n')) return;
        consumed = true;
        if (scenario === 'closed') socket.destroy();
        else if (scenario === 'oversized') socket.end('x'.repeat(control.MAX_REPLY + 2048));
        else
          socket.end(
            JSON.stringify({
              ok: true,
              reply: { ...JSON.parse(bytes), identity: { ...identity, role: 'api' }, result: {} },
            }) + '\n',
          );
      });
    });
    await new Promise((resolve) => server.listen(endpoint, resolve));
    try {
      await assert.rejects(control.call(endpoint, identity, 'ready'));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

function snapshot(job, role, pid) {
  return {
    identity: profile.controlIdentity(job, role),
    pid,
    processIdentity: { pidNamespace: 'pid:[12345]', pid, lifecycleId: randomUUID() },
    providerIdentity: {
      telegram: { configured: true, connected: true, username: 'synthetic', botId: '123' },
      max: { botId: '456' },
      pushAvailable: true,
    },
    applicationListening: role !== 'background',
    background: { active: false },
    notifications: {
      inFlight: 0,
      polls: role === 'background' ? 2 : 0,
      counters: { telegram: { attempts: role === 'background' ? 3 : 0 } },
    },
    metrics: { resources: { actual: true } },
    model: { calls: 0 },
    forbidden: { send: 0, poll: 0, model: 0 },
    cpu: { user: pid, system: 3 },
    resources: { memory: { rss: 100 * pid } },
    eventLoop: { p95Ms: pid },
    elapsedMs: 1000,
  };
}
test('aggregation requires actual role proof and retains separate tails with distinct PID CPU accounting', () => {
  const job = {
    ...identity,
    topology: 'split',
    variant: 'current',
    resources: profile.budget('split'),
  };
  const web = snapshot(job, 'api', 10),
    bg = snapshot(job, 'background', 20);
  const result = aggregate(job, web, bg);
  assert.deepEqual(result.cpu, { user: 30, system: 6 });
  assert.equal(result.aggregateCPU.uniqueProcesses, 2);
  assert.equal(result.eventLoop.p95Ms, 10);
  assert.equal(result.roles.background.eventLoop.p95Ms, 20);
  assert.equal(result.memory.rssAfterSum, 3000);
  for (const mutate of [
    (v) => {
      delete v.metrics.resources;
    },
    (v) => {
      v.pid = 10;
      v.processIdentity.pid = 10;
    },
    (v) => {
      v.applicationListening = true;
    },
    (v) => {
      v.background.active = true;
    },
    (v) => {
      v.notifications.inFlight = 1;
    },
    (v) => {
      v.model.calls = 1;
    },
    (v) => {
      v.providerIdentity.max.botId = 'different';
    },
  ]) {
    const altered = structuredClone(bg);
    mutate(altered);
    assert.throws(() => aggregate(job, web, altered));
  }
  const invalidWeb = structuredClone(web);
  invalidWeb.notifications.counters.telegram.attempts = 1;
  assert.throws(() => aggregate(job, invalidWeb, bg));
  const combined = { ...job, topology: 'combined', resources: profile.budget('combined') },
    same = snapshot(combined, 'sut', 30);
  assert.equal(aggregate(combined, same, same).aggregateCPU.uniqueProcesses, 1);
  assert.deepEqual(aggregate(combined, same, same).cpu, { user: 30, system: 3 });
  const namespacedWeb = structuredClone(web),
    namespacedBg = structuredClone(bg);
  namespacedWeb.pid = namespacedBg.pid = 1;
  namespacedWeb.processIdentity.pid = namespacedBg.processIdentity.pid = 1;
  namespacedBg.processIdentity.pidNamespace = 'pid:[98765]';
  assert.equal(aggregate(job, namespacedWeb, namespacedBg).aggregateCPU.uniqueProcesses, 2);
  namespacedBg.processIdentity.pidNamespace = namespacedWeb.processIdentity.pidNamespace;
  assert.throws(() => aggregate(job, namespacedWeb, namespacedBg));
});
