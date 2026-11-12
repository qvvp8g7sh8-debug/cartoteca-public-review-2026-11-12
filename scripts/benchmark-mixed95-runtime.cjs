// Synthetic role composition. Production runtime role/lease/ACL paths are not patched.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { setTimeout: sleep } = require('node:timers/promises');
const { createAdapters } = require('./benchmark-mixed95-adapters.cjs');
const { validateManifest } = require('./benchmark-notifications-fixture.cjs');
const { resources, assistantCapacity } = require('./benchmark-mixed92-server.cjs');
const { controlIdentity, digest } = require('./benchmark-mixed95-profile.cjs');
function queueSnapshot(job) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(job.directory, 'platform', 'platform.sqlite'), {
    readOnly: true,
  });
  try {
    const queues = {};
    for (const table of [
      'notification_channel_jobs',
      'staff_push_jobs',
      'staff_notification_jobs',
      'staff_max_jobs',
      'max_event_inbox',
    ]) {
      const exists = db
        .prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?')
        .get('table', table);
      assert.ok(exists, 'Required notification queue table missing: ' + table);
      queues[table] = db
        .prepare('SELECT status,count(*) jobs FROM ' + table + ' GROUP BY status')
        .all();
    }
    const coordination = db
      .prepare('SELECT value FROM telegram_runtime WHERE key=?')
      .get('application-process-roles');
    return {
      profile: 'notifications-v1',
      queues,
      platformSchema: db.prepare('PRAGMA user_version').get().user_version,
      roleLease: {
        present: Boolean(coordination),
        ciphertextSha256: coordination ? digest(coordination.value) : null,
      },
    };
  } finally {
    db.close();
  }
}
async function createRole(job, role) {
  const selected = job.resources[role];
  assert.ok(selected && role !== 'generator');
  const processIdentity = {
    pidNamespace:
      process.platform === 'linux' ? fs.readlinkSync('/proc/self/ns/pid') : 'windows-host',
    pid: process.pid,
    lifecycleId: randomUUID(),
  };
  if (process.platform === 'linux')
    assert.match(processIdentity.pidNamespace, /^pid:\[[0-9]{1,20}\]$/);
  else assert.equal(job.mode, 'functional', 'Measurement requires a real Linux PID namespace');
  const sourceFiles = require(path.join(job.sourceRoot, 'scripts/release/files.cjs'));
  const source = JSON.parse(
    fs.readFileSync(path.join(job.controlDirectory, 'source-manifest.json'), 'utf8'),
  );
  assert.equal(sourceFiles.objectHash(source), job.sourceSha256);
  assert.equal(sourceFiles.objectHash(sourceFiles.manifest(job.sourceRoot)), job.sourceSha256);
  const fixture = JSON.parse(
    fs.readFileSync(path.join(job.directory, 'mixed95-fixture.json'), 'utf8'),
  );
  const manifest = validateManifest(
    JSON.parse(fs.readFileSync(path.join(job.directory, 'notifications-profile.json'), 'utf8')),
  );
  const adapters = createAdapters(job, role, manifest);
  const { fake, cassette, forbidden, identityCalls } = adapters;
  const delivery = selected.processRole !== 'web';
  const service = require(path.join(job.sourceRoot, 'src/server/modules/assistant/service.cjs'));
  const original = service.createAssistant;
  service.createAssistant = (context, options) =>
    original(context, {
      ...options,
      fetchImpl: adapters.fetch,
    });
  const server = require(path.join(job.sourceRoot, 'multi-server.cjs')).createMultiServer({
    ...fake.options,
    dataDir: job.directory,
    origin: job.applicationOrigin,
    production: false,
    processRole: selected.processRole,
    notificationSchema: job.schema,
    scheduledNotifications: false,
    assistantAppointmentSavingEnabled: false,
    assistantStateBackend: job.assistantStateBackend,
    assistantDialogueCapacity: 500,
    assistantCodexEnabled: false,
    assistantLocalSpeechEnabled: false,
    paymentNetworkEnabled: false,
    trustedProxies: ['10.234.12.3'],
    tenantCacheLimit: selected.pool,
    tenantReadCacheBytes: selected.cacheMiB * 1024 ** 2,
    sharedCabinetWrites: job.sharedCabinetWrites,
    isolatedReadBudgets: job.isolatedReadBudgets,
    notificationMaintenanceEnabled: job.notificationMaintenanceEnabled,
    metricsEnabled: true,
    metricsIntervalMs: 0,
    metricsEmit() {},
    telegramIdentityAutostart: false,
  });
  assert.equal(
    typeof server.stopBackground,
    'function',
    'A coherently frozen95 runtime stop hook is required',
  );
  await server.telegramRuntime.initialize();
  assert.equal(
    server.telegramRuntime.status().connected,
    true,
    'Role identity must be ready before measurement',
  );
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const receipt = (phase, value) =>
    fs.writeFileSync(
      path.join(job.controlDirectory, role + '-' + phase + '.json'),
      JSON.stringify({ identity: controlIdentity(job, role), phase, value }),
      { flag: 'wx', mode: 0o600 },
    );
  let started = false,
    stopped = false,
    before,
    cpu,
    begin,
    stopReceipt;
  const snapshot = () => ({
    identity: controlIdentity(job, role),
    pid: process.pid,
    processIdentity,
    role: selected.processRole,
    applicationListening: Boolean(server.address()),
    background: server.backgroundStatus(),
    capturedAt: new Date().toISOString(),
    resources: resources(),
    metrics: server.requestMetrics.snapshot(),
    notifications: fake.snapshot(),
    notificationQueue: queueSnapshot(job),
    model: cassette.snapshot(),
    forbidden: { ...forbidden },
    providerIdentity: {
      telegram: server.telegramRuntime.status(),
      max: fake.options.maxBotIdentity,
      pushAvailable: server.staffPushRuntime.available,
    },
    identityCalls: { ...identityCalls },
    transportProof: adapters.proof(),
    assistantCapacity: assistantCapacity(server.requestMetrics.snapshot().resources?.assistant),
    eventLoop: {
      p50Ms: loop.percentile(50) / 1e6,
      p95Ms: loop.percentile(95) / 1e6,
      p99Ms: loop.percentile(99) / 1e6,
      maxMs: loop.max / 1e6,
    },
    ...(started
      ? { elapsedMs: performance.now() - begin, cpu: process.cpuUsage(cpu), before }
      : {}),
  });
  server.once('backgroundError', () => {
    const observed = snapshot();
    receipt('lease-lost', observed);
    if (job.mode === 'functional')
      process.send?.({
        event: 'mixed95-functional-lease-lost',
        identity: controlIdentity(job, role),
      });
  });
  return {
    server,
    fixture,
    snapshot,
    async prepare() {
      if (selected.processRole === 'background') assert.equal(server.startBackground(), true);
      const prepared = snapshot();
      receipt('prepared', prepared);
      return prepared;
    },
    async start() {
      assert.equal(started, false);
      assert.equal(stopped, false);
      const preMeasure = snapshot();
      started = true;
      begin = performance.now();
      cpu = process.cpuUsage();
      before = resources();
      loop.reset();
      server.requestMetrics.snapshot({ reset: true });
      if (delivery) {
        assert.equal(server.backgroundStatus().active, true);
        server.telegramRuntime.start();
        server.staffPushRuntime.start();
        server.maxRuntime.start();
      }
      const result = {
        started: true,
        startedAt: new Date().toISOString(),
        identity: controlIdentity(job, role),
        preMeasure,
      };
      receipt('start', result);
      return result;
    },
    async stop() {
      assert.ok(started && !stopped);
      stopped = true;
      const requestedAt = new Date().toISOString(),
        previousBackground = server.backgroundStatus(),
        stoppedOwner = server.stopBackground();
      assert.equal(stoppedOwner, delivery && previousBackground.state !== 'lease-lost');
      await adapters.settle();
      const deadline = Date.now() + 8000;
      const pendingWrites = () => {
        const queue = server.requestMetrics.snapshot().resources?.writeQueue;
        assert.ok(queue, 'Missing write-queue metrics cannot prove quiescence');
        assert.ok(Number.isSafeInteger(queue.pending) && queue.pending >= 0);
        return queue.pending;
      };
      while (pendingWrites() > 0 && Date.now() < deadline) await sleep(10);
      assert.equal(pendingWrites(), 0);
      assert.equal(server.backgroundStatus().active, false);
      stopReceipt = {
        requestedAt,
        settledAt: new Date().toISOString(),
        stoppedOwner,
        previousBackground,
        snapshot: snapshot(),
      };
      receipt('stop', stopReceipt);
      return stopReceipt;
    },
    handlers() {
      return {
        ready: async () => snapshot(),
        start: () => this.start(),
        stop: () => this.stop(),
        snapshot: async () => {
          assert.ok(stopReceipt);
          return snapshot();
        },
      };
    },
    async close() {
      loop.disable();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
      service.createAssistant = original;
    },
  };
}
module.exports = { createRole, queueSnapshot };
