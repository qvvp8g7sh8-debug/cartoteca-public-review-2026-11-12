// Isolated SUT entry point. One process is deliberate: mirrors the combined production role.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { setTimeout: sleep } = require('node:timers/promises');
const { DATA } = require('./benchmark-organizations-fixture.cjs');
const { readFixture } = require('./benchmark-mixed92-fixture.cjs');
const { endpoint, PROFILE, identity } = require('./benchmark-mixed92-profile.cjs');
const { createModelCassette } = require('./benchmark-mixed92-providers.cjs');
function resources() {
  const read = (name) => {
    try {
      return fs.readFileSync('/sys/fs/cgroup/' + name, 'utf8').trim();
    } catch {
      return null;
    }
  };
  let descriptors = null;
  try {
    descriptors = fs.readdirSync('/proc/self/fd').length;
  } catch {}
  return {
    memory: process.memoryUsage(),
    descriptors,
    resourceUsage: process.resourceUsage(),
    cgroup: Object.fromEntries(
      ['memory.current', 'memory.peak', 'memory.max', 'cpu.max', 'cpu.stat', 'io.stat'].map(
        (name) => [name, read(name)],
      ),
    ),
  };
}
function assistantCapacity(stats) {
  const observed = stats?.commands?.capacity ?? stats?.dialogues?.capacity ?? null;
  return {
    requested: PROFILE.assistantDialogueCapacity,
    observed,
    supported: observed !== null,
    matchesRequested: observed === PROFILE.assistantDialogueCapacity,
    compatibilitySemantics:
      observed === PROFILE.assistantDialogueCapacity
        ? 'Explicit synthetic profile capacity; product default unchanged'
        : 'Older runtime may ignore this option or expose no capacity; admission/eviction semantics differ',
  };
}
async function start({
  root = '/app',
  directory = DATA,
  base = 'http://10.234.12.2:4173',
  control = 'http://10.234.12.2:4179',
  modelDelayMs = PROFILE.modelDelayMs,
  notificationDelayMs = 3,
} = {}) {
  assert.equal(root, '/app');
  endpoint(base);
  endpoint(control, 'control');
  assert.equal(new URL(base).hostname, new URL(control).hostname);
  assert.ok([3, 3000].includes(notificationDelayMs));
  const applicationOrigin = base.replace('http:', 'https:');
  const fixture = readFixture(directory),
    cassette = createModelCassette({ latencyMs: modelDelayMs });
  const service = require(path.join(root, 'src/server/modules/assistant/service.cjs'));
  const original = service.createAssistant;
  service.createAssistant = (context, options) =>
    original(context, { ...options, fetchImpl: cassette.fetch });
  const notifications = require('./benchmark-notifications-fixture.cjs');
  const fake = require('./benchmark-notifications-adapters.cjs').createFakeNotificationAdapters(
    notifications.readManifest(directory),
    { latencyMs: 3 },
  );
  let slowDeliveries = 0;
  if (notificationDelayMs === 3000) {
    const wrap =
      (send, signal) =>
      async (...args) => {
        slowDeliveries++;
        try {
          await sleep(2997, undefined, { signal: signal(...args) });
          return await send(...args);
        } finally {
          slowDeliveries--;
        }
      };
    fake.options.telegramBot.send = wrap(
      fake.options.telegramBot.send,
      (_id, _text, _markup, signal) => signal,
    );
    fake.options.maxBot.send = wrap(fake.options.maxBot.send, (input) => input.signal);
    fake.options.pushSend = wrap(fake.options.pushSend, () => undefined);
  }
  const { createMultiServer } = require(path.join(root, 'multi-server.cjs'));
  const server = createMultiServer({
    ...fake.options,
    dataDir: directory,
    origin: applicationOrigin,
    production: false,
    processRole: 'combined',
    notificationSchema: 19,
    scheduledNotifications: false,
    assistantAppointmentSavingEnabled: false,
    assistantDialogueCapacity: PROFILE.assistantDialogueCapacity,
    paymentNetworkEnabled: false,
    trustedProxies: ['10.234.12.3'],
    tenantCacheLimit: 64,
    metricsEnabled: true,
    metricsIntervalMs: 0,
    metricsEmit() {},
    telegramIdentityAutostart: false,
  });
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  let started = false,
    stopped = false,
    cpu,
    begin,
    before;
  const controller = http.createServer(async (req, res) => {
    try {
      assert.equal(req.headers['x-synthetic-only'], PROFILE.name);
      let result;
      if (req.url === '/ready' && req.method === 'GET')
        result = {
          ready: true,
          profile: PROFILE.name,
          schema: 19,
          accounts: fixture.actors.length,
          organizations: fixture.organizations.length,
          workers: 1,
          modelDelayMs,
          notificationDelayMs,
          actualModelNetwork: false,
          harnessSha256: identity().sha256,
          transportOrigin: base,
          applicationOrigin,
          pushAvailable: server.staffPushRuntime.available,
          autosave: false,
          assistantCapacity: assistantCapacity(
            server.requestMetrics.snapshot().resources?.assistant,
          ),
        };
      else if (req.url === '/start' && req.method === 'POST') {
        assert.equal(started, false, 'Use a fresh process and fixture snapshot per measured run');
        started = true;
        begin = performance.now();
        cpu = process.cpuUsage();
        before = resources();
        loop.reset();
        server.requestMetrics.snapshot({ reset: true });
        server.telegramRuntime.start();
        server.staffPushRuntime.start();
        result = { started: true, profile: PROFILE.name, proposedSloOnly: true };
      } else if (req.url === '/stop' && req.method === 'POST') {
        assert.ok(started && !stopped);
        stopped = true;
        server.telegramRuntime.stop();
        server.staffPushRuntime.stop();
        const deadline = Date.now() + 8000;
        while (slowDeliveries && Date.now() < deadline) await sleep(10);
        await fake.settle();
        assert.equal(slowDeliveries, 0);
        result = {
          elapsedMs: performance.now() - begin,
          cpu: process.cpuUsage(cpu),
          before,
          after: resources(),
          eventLoop: {
            p50Ms: loop.percentile(50) / 1e6,
            p95Ms: loop.percentile(95) / 1e6,
            p99Ms: loop.percentile(99) / 1e6,
            maxMs: loop.max / 1e6,
          },
          metrics: server.requestMetrics.snapshot({ reset: true }),
          model: cassette.snapshot(),
          notifications: fake.snapshot(),
          notificationQueue: notifications.queueSnapshot(directory),
          assistantCapacity: assistantCapacity(
            server.requestMetrics.snapshot().resources?.assistant,
          ),
        };
      } else throw Error('Unknown synthetic control request');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  const host = new URL(base).hostname === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0';
  await new Promise((resolve) => server.listen(4173, host, resolve));
  await new Promise((resolve) => controller.listen(4179, host, resolve));
  const close = () => {
    loop.disable();
    controller.close();
    server.closeAllConnections();
    server.close();
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  return { server, controller, close };
}
module.exports = { start, resources, assistantCapacity };
if (require.main === module)
  start({ notificationDelayMs: Number(process.argv[2] || 3) })
    .then(() => console.log(JSON.stringify({ ready: true, profile: PROFILE.name })))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
