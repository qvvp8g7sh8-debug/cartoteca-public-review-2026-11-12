// Stand-only launcher: exact published image, no public ports or external senders.
const fs = require('node:fs');
const path = require('node:path');
const cluster = require('node:cluster');
const http = require('node:http');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { Session } = require('node:inspector');
const { safe, DATA } = require('./benchmark-organizations-fixture.cjs');
const {
  harnessIdentity,
  environmentIdentity,
  observeTenantStorage,
  loadProfile,
} = require('./benchmark-organizations-profile.cjs');
const root = '/app',
  profile = loadProfile(),
  origin = profile.origin;
safe(DATA);
const harness = harnessIdentity();
const runtime = environmentIdentity();
const count = Number(process.env.LOAD_WORKERS || 1);
if (![1, 2, 4, 8].includes(count)) throw Error('Invalid synthetic worker count');
const tenantCacheLimit = Number(process.env.LOAD_TENANT_CACHE || 64);
if (!Number.isInteger(tenantCacheLimit) || tenantCacheLimit < 1 || tenantCacheLimit > 1024)
  throw Error('Invalid synthetic tenant cache limit');
const runtimeFlags = {
  workers: count,
  tenantCacheLimit,
  notificationSchema: 17,
  sharedCabinetWrites: process.env.CARTOTECA_SHARED_CABINET_WRITES === '1',
  isolatedReadBudgets: process.env.CARTOTECA_ISOLATED_READ_BUDGETS === '1',
  metricsEnabled: true,
  diagnosticsInstalled: process.env.LOAD_DIAGNOSTICS === '1',
  production: false,
  senders: false,
  backgroundWorkers: profile.backgroundEnabled,
  backgroundProfile: profile.name,
  fakeProviders: profile.backgroundEnabled,
  backgroundExcluded: ['publication', 'email', 'support', 'max-inbox', 'staff-max'],
  processRoleRequested: profile.processRole,
  processRoleObserved: null,
  storageLifecycleWrapper: 'options-preserving',
  startupMode: 'serial-ready-before-load',
  trustedProxy: '10.234.12.3',
};
function resources() {
  const read = (name) => {
    try {
      return fs.readFileSync('/sys/fs/cgroup/' + name, 'utf8').trim();
    } catch {
      return null;
    }
  };
  let openDescriptors = null;
  try {
    openDescriptors = fs.readdirSync('/proc/self/fd').length;
  } catch {}
  return {
    openDescriptors,
    lifetimeMaxRssKiB: process.resourceUsage().maxRSS,
    heapUsedBytes: process.memoryUsage().heapUsed,
    cgroupSharedByWorkers: {
      memoryCurrent: read('memory.current'),
      memoryPeak: read('memory.peak'),
      memoryLimit: read('memory.max'),
      cpuLimit: read('cpu.max'),
      cpuSet: read('cpuset.cpus.effective'),
      cpuStat: read('cpu.stat'),
      ioStat: read('io.stat'),
    },
  };
}
if (cluster.isPrimary) {
  let sequence = 0,
    stopping = false;
  const pending = new Map(),
    ready = new Set();
  // Cold synthetic index bootstrap must finish before the next worker opens it.
  // Every worker is ready before measurement; HTTP remains parallel during load.
  cluster.fork();
  cluster.on('message', (worker, message) => {
    if (message.ready && !ready.has(worker.id)) {
      ready.add(worker.id);
      if (ready.size < count && !stopping) cluster.fork();
    }
    if (message.reply) {
      const task = pending.get(message.reply);
      if (task) {
        task.rows.push(message.result);
        if (task.rows.length === count) {
          clearTimeout(task.timer);
          pending.delete(message.reply);
          task.resolve(task.rows);
        }
      }
    }
  });
  function broadcast(action, data = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence,
        task = {
          rows: [],
          resolve,
          timer: setTimeout(() => {
            pending.delete(id);
            reject(Error('Synthetic worker control timeout'));
          }, 60000),
        };
      pending.set(id, task);
      for (const worker of Object.values(cluster.workers)) worker.send({ action, data, id });
    });
  }
  const control = http.createServer(async (req, res) => {
    try {
      if (req.headers['x-synthetic-only'] !== '1') throw Error('Synthetic control only');
      let value;
      if (req.url === '/ready') value = { ready: ready.size === count, workers: count };
      else if (req.url === '/start' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 2048) throw Error('Control body too large');
        }
        const data = JSON.parse(body);
        if (!/^[a-z0-9-]{1,64}$/.test(data.name)) throw Error('Invalid diagnostic stage');
        value = await broadcast('start', data);
      } else if (req.url === '/stop' && req.method === 'POST') {
        const workers = await broadcast('stop');
        value = {
          workers,
          background: profile.backgroundEnabled
            ? {
                profile: profile.name,
                queue: require('./benchmark-notifications-fixture.cjs').queueSnapshot(DATA),
              }
            : null,
        };
      } else throw Error('Unknown synthetic control');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    } catch {
      res.writeHead(500);
      res.end('{"error":"Synthetic control failed"}');
    }
  });
  control.listen(4179, '0.0.0.0');
  process.on('SIGTERM', () => {
    stopping = true;
    control.close();
    for (const worker of Object.values(cluster.workers)) worker.send({ action: 'shutdown' });
    cluster.disconnect(() => process.exit(0));
  });
  cluster.on('exit', (_, code) => {
    if (!stopping) {
      console.error('Synthetic worker exited ' + code);
      process.exit(1);
    }
  });
} else {
  const storeModule = require(path.join(root, 'src/server/infrastructure/cabinet-storage.cjs'));
  const create = storeModule.createStorage;
  let opens = 0,
    closes = 0,
    openMs = 0,
    closeMs = 0,
    elapsedStart,
    cpuStart,
    resourcesStart,
    stage;
  storeModule.createStorage = observeTenantStorage(create, (event, duration) => {
    if (event === 'open') {
      opens++;
      openMs += duration;
    } else {
      closes++;
      closeMs += duration;
    }
  });
  const diagnostic =
    process.env.LOAD_DIAGNOSTICS === '1'
      ? require('/bench/instrument.cjs').install(root)
      : {
          start() {},
          stop() {
            return [];
          },
        };
  const { createMultiServer } = require(path.join(root, 'multi-server.cjs'));
  const fake = profile.backgroundEnabled
    ? require('./benchmark-notifications-adapters.cjs').createFakeNotificationAdapters(
        require('./benchmark-notifications-fixture.cjs').readManifest(DATA),
        { latencyMs: 3 },
      )
    : null;
  const server = createMultiServer({
    dataDir: DATA,
    origin,
    production: false,
    processRole: profile.processRole,
    notificationSchema: 17,
    trustedProxies: ['10.234.12.3'],
    tenantCacheLimit,
    sendMail: null,
    telegramBot: null,
    supportDelivery: {},
    maxEnabled: false,
    pushEnabled: false,
    telegramAutostart: false,
    telegramIdentityAutostart: false,
    supportAutostart: false,
    maxAutostart: false,
    pushAutostart: false,
    adminEmailAutostart: false,
    bookingPublicationAutostart: false,
    metricsEnabled: true,
    metricsIntervalMs: 0,
    metricsEmit() {},
    ...(fake?.options || {}),
  });
  // Older immutable binaries ignore this new option, but still honor explicit
  // disabled autostarts. Never claim they implemented the newer process roles.
  runtimeFlags.processRoleObserved = server.processRole || null;
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const inspector = new Session();
  inspector.connect();
  let profiling = false;
  const post = (name, values = {}) =>
    new Promise((resolve, reject) =>
      inspector.post(name, values, (error, value) => (error ? reject(error) : resolve(value))),
    );
  server.listen(4173, '0.0.0.0', () => process.send({ ready: true }));
  process.on('message', async (message) => {
    try {
      let result;
      if (message.action === 'start') {
        if (profile.backgroundEnabled && stage)
          throw Error(
            'Background profiles require a fresh process and synthetic data snapshot per stage',
          );
        stage = message.data.name;
        profiling = message.data.cpu === true;
        opens = closes = openMs = closeMs = 0;
        loop.reset();
        diagnostic.start(message.data.phases === true);
        server.requestMetrics.snapshot({ reset: true });
        elapsedStart = performance.now();
        cpuStart = process.cpuUsage();
        resourcesStart = resources();
        if (profiling) {
          await post('Profiler.enable');
          await post('Profiler.setSamplingInterval', { interval: 2000 });
          await post('Profiler.start');
        }
        if (fake) {
          server.telegramRuntime.start();
          server.staffPushRuntime.start();
        }
        result = { started: true, harness, runtime, runtimeFlags };
      } else if (message.action === 'stop') {
        if (fake) {
          server.telegramRuntime.stop();
          server.staffPushRuntime.stop();
          await fake.settle();
        }
        const elapsed = performance.now() - elapsedStart,
          usage = process.cpuUsage(cpuStart);
        if (profiling) {
          const profile = (await post('Profiler.stop')).profile;
          fs.writeFileSync(
            '/results/' + stage + '-w' + cluster.worker.id + '.cpuprofile',
            JSON.stringify(profile),
          );
          profiling = false;
        }
        result = {
          worker: cluster.worker.id,
          elapsedMs: elapsed,
          cpuCores: (usage.user + usage.system) / (elapsed * 1000),
          rssMiB: process.memoryUsage().rss / 2 ** 20,
          loopP95Ms: loop.percentile(95) / 1e6,
          loopMaxMs: loop.max / 1e6,
          tenantOpens: opens,
          tenantCloses: closes,
          tenantOpenMs: openMs,
          tenantCloseMs: closeMs,
          provenance: { harness, runtime, runtimeFlags },
          resources: { before: resourcesStart, after: resources() },
          metrics: server.requestMetrics.snapshot({ reset: true }),
          rows: diagnostic.stop(),
          background: fake?.snapshot() || null,
        };
      } else if (message.action === 'shutdown') {
        inspector.disconnect();
        server.closeAllConnections();
        server.close(() => process.exit(0));
        return;
      }
      process.send({ reply: message.id, result });
    } catch {
      console.error('Synthetic diagnostics failed');
      process.exit(1);
    }
  });
}
