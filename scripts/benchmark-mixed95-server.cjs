// One API listener. Combined and split share this exact benchmark coordinator.
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  readJob,
  controlIdentity,
  socketPath,
  PROFILE,
  identity: harnessIdentity,
} = require('./benchmark-mixed95-profile.cjs');
const control = require('./benchmark-mixed95-control.cjs');
const { createRole } = require('./benchmark-mixed95-runtime.cjs');
function processKey(row) {
  const actual = row.processIdentity;
  assert.equal(actual.pid, row.pid);
  assert.ok(Number.isSafeInteger(actual.pid) && actual.pid > 0);
  assert.match(actual.pidNamespace, /^(?:pid:\[[0-9]{1,20}\]|windows-host)$/);
  assert.match(actual.lifecycleId, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
  return JSON.stringify([actual.pidNamespace, actual.pid, actual.lifecycleId]);
}
function channelIdentity(row) {
  const { telegram, max, pushAvailable } = row.providerIdentity;
  assert.equal(telegram.configured, true);
  assert.equal(telegram.connected, true);
  assert.equal(pushAvailable, true);
  return { telegram: { username: telegram.username, botId: telegram.botId }, max, pushAvailable };
}
function aggregate(job, web, background) {
  const webKey = processKey(web),
    backgroundKey = processKey(background);
  assert.deepEqual(
    channelIdentity(web),
    channelIdentity(background),
    'Configured role identities must agree',
  );
  assert.deepEqual(web.identity, controlIdentity(job, job.topology === 'combined' ? 'sut' : 'api'));
  assert.deepEqual(
    background.identity,
    controlIdentity(job, job.topology === 'combined' ? 'sut' : 'background'),
  );
  assert.equal(background.background.active, false);
  assert.equal(background.notifications.inFlight, 0);
  assert.ok(
    web.metrics.resources && background.metrics.resources,
    'Missing role metrics cannot become zero',
  );
  if (job.topology === 'split') {
    assert.notEqual(
      JSON.stringify([web.processIdentity.pidNamespace, web.pid]),
      JSON.stringify([background.processIdentity.pidNamespace, background.pid]),
      'Role processes must differ even when separate containers both report PID1',
    );
    assert.notEqual(webKey, backgroundKey);
    assert.equal(background.applicationListening, false);
    assert.deepEqual(web.forbidden, { send: 0, poll: 0, model: 0 });
    assert.equal(web.notifications.polls, 0);
    for (const row of Object.values(web.notifications.counters)) assert.equal(row.attempts, 0);
    assert.equal(background.model.calls, 0);
    assert.equal(background.forbidden.model, 0);
  } else assert.equal(webKey, backgroundKey);
  const processes = [...new Map([web, background].map((row) => [processKey(row), row])).values()];
  const cpu = processes.reduce(
    (sum, row) => ({ user: sum.user + row.cpu.user, system: sum.system + row.cpu.system }),
    { user: 0, system: 0 },
  );
  return {
    topology: job.topology,
    variant: job.variant,
    proofSha256: job.proofSha256,
    rolesCorrect: true,
    elapsedMs: web.elapsedMs,
    cpu,
    before: web.before,
    after: web.resources,
    eventLoop: web.eventLoop,
    metrics: web.metrics,
    model: web.model,
    notifications: background.notifications,
    notificationQueue: background.notificationQueue,
    assistantCapacity: web.assistantCapacity,
    roles: { web, background, colocated: job.topology === 'combined' },
    aggregateCPU: {
      ...cpu,
      uniqueProcesses: processes.length,
      method:
        'Sum CPU deltas once per PID namespace, PID and process lifetime; retain raw identities',
    },
    memory: {
      rssAfterSum: processes.reduce((sum, row) => sum + row.resources.memory.rss, 0),
      independentPeakSumIsOnlyUpperBound: true,
    },
    resourceBudget: job.resources,
    caveats: [
      'Role event-loop percentiles are separate; never average or sum p95',
      'Stop/drain role snapshots have distinct timestamps and are not an atomic distributed snapshot',
    ],
  };
}
const listenHttp = (server, port, host) =>
  new Promise((resolve, reject) => {
    const failed = (error) => {
      server.off('listening', ready);
      reject(error);
    };
    const ready = () => {
      server.off('error', failed);
      resolve();
    };
    server.once('error', failed);
    server.once('listening', ready);
    server.listen(port, host);
  });
async function start({ jobFile } = {}) {
  const job = readJob(jobFile),
    role = job.topology === 'combined' ? 'sut' : 'api';
  const runtime = await createRole(job, role);
  let controller, local, closing;
  const close = () =>
    (closing ||= (async () => {
      if (controller) {
        controller.closeAllConnections();
        await new Promise((resolve) => controller.close(resolve));
      }
      if (local) await local.close();
      await runtime.close();
    })());
  try {
    const host = job.mode === 'functional' ? '127.0.0.1' : '0.0.0.0';
    await listenHttp(runtime.server, job.port, host);
    await runtime.prepare();
    const phases = control.createPhases(controlIdentity(job, role), runtime.handlers());
    local = await control.listen(socketPath(job, role), phases);
    const owner = job.topology === 'combined' ? role : 'background';
    const background = (verb) =>
      job.topology === 'combined'
        ? phases
            .dispatch(control.request(controlIdentity(job, role), verb))
            .then((reply) => reply.result)
        : control.call(socketPath(job, owner), controlIdentity(job, owner), verb);
    let stopped, before;
    if (job.mode === 'benchmark') {
      controller = http.createServer(async (req, res) => {
        try {
          assert.equal(req.headers['x-synthetic-only'], PROFILE.name);
          let result;
          if (req.method === 'GET' && req.url === '/ready') {
            const web = await phases.dispatch(control.request(controlIdentity(job, role), 'ready'));
            const delivery = job.topology === 'combined' ? web.result : await background('ready');
            assert.deepEqual(channelIdentity(web.result), channelIdentity(delivery));
            assert.equal(
              delivery.background.active,
              true,
              'Background owner must already hold its official lease',
            );
            result = {
              ready: true,
              profile: PROFILE.name,
              schema: job.schema,
              accounts: runtime.fixture.actors.length,
              organizations: runtime.fixture.organizations.length,
              workers: 1,
              modelDelayMs: job.modelDelayMs,
              notificationDelayMs: job.notificationDelayMs,
              actualModelNetwork: false,
              harnessSha256: harnessIdentity().reused.sha256,
              harness95: harnessIdentity(),
              jobProofSha256: job.proofSha256,
              topology: job.topology,
              variant: job.variant,
              sourceSha256: job.sourceSha256,
              fixtureSha256: job.fixtureSha256,
              pushAvailable: runtime.server.staffPushRuntime.available,
              autosave: false,
              assistantCapacity: web.result.assistantCapacity,
              roles: { web: web.result, background: delivery },
            };
          } else if (req.method === 'POST' && req.url === '/start') {
            assert.equal(before, undefined);
            // Both roles reset their own actual metrics before any delivery timer starts.
            if (job.topology === 'split') {
              const web = await phases.dispatch(
                control.request(controlIdentity(job, role), 'start'),
              );
              const delivery = await background('start');
              before = { web: web.result, background: delivery };
            } else before = { combined: await background('start') };
            result = {
              started: true,
              profile: PROFILE.name,
              proposedSloOnly: true,
              barriers: before,
            };
          } else if (req.method === 'POST' && req.url === '/stop') {
            assert.ok(before && !stopped);
            const delivery = await background('stop');
            assert.equal(
              delivery.previousBackground.active,
              true,
              'Lost background lease is negative comparison evidence',
            );
            const web =
              job.topology === 'combined'
                ? delivery
                : (await phases.dispatch(control.request(controlIdentity(job, role), 'stop')))
                    .result;
            stopped = aggregate(job, web.snapshot, delivery.snapshot);
            stopped.barriers = {
              start: before,
              stop: {
                web: web.requestedAt,
                background: delivery.requestedAt,
                webSettled: web.settledAt,
                backgroundSettled: delivery.settledAt,
              },
            };
            result = stopped;
          } else throw Error('Unknown or out-of-order synthetic control command');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message.slice(0, 300), incomplete: true }));
        }
      });
      await listenHttp(controller, 4179, host);
    }
    process.once('SIGTERM', () => void close());
    process.once('SIGINT', () => void close());
    return { runtime, phases, close, job, role };
  } catch (error) {
    await close();
    throw error;
  }
}
module.exports = { start, aggregate };
if (require.main === module)
  start({ jobFile: process.argv[2] })
    .then(({ job, role, runtime }) => {
      const ready = {
        ready: true,
        role,
        identity: controlIdentity(job, role),
        port: runtime.server.address().port,
      };
      process.send?.(ready);
      console.log(JSON.stringify(ready));
    })
    .catch((error) => {
      console.error(JSON.stringify({ ready: false, error: error.message.slice(0, 300) }));
      process.exitCode = 1;
    });
