// External generator: fixed synthetic Docker network only; never targets a public site.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { safe, DATA } = require('./benchmark-organizations-fixture.cjs');
const {
  validateFixture,
  actionPlan,
  harnessIdentity,
  loadProfile,
} = require('./benchmark-organizations-profile.cjs');
const { createClient } = require('./benchmark-organizations-client.cjs');
const { runSchedule } = require('./benchmark-organizations-scheduler.cjs');
const { buildResult } = require('./benchmark-organizations-results.cjs');
const { failureDetails } = require('./benchmark-organizations-diagnostics.cjs');
safe(DATA);
const fixture = JSON.parse(fs.readFileSync(path.join(DATA, 'actors.json')));
validateFixture(fixture);
const control = 'http://10.234.12.2:4179';
const label = process.argv[2],
  mode = process.argv[3] || 'typical',
  seconds = Number(process.argv[4] || 30);
assert.match(label, /^[a-z0-9-]{1,64}$/);
assert.ok(['smoke', 'typical', 'busy', 'diagnostic', 'fixed', 'open'].includes(mode));
assert.ok(seconds >= 3 && seconds <= 3600);
const client = createClient(fixture, label);
const profile = loadProfile();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function command(route, body) {
  const response = await fetch(control + route, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Synthetic-Only': '1', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  assert.equal(response.status, 200, 'Synthetic diagnostics unavailable');
  return response.json();
}
async function main() {
  let ready = false;
  for (let n = 0; n < 100; n++) {
    try {
      if ((await command('/ready')).ready) {
        ready = true;
        break;
      }
    } catch {}
    await pause(200);
  }
  assert.ok(ready, 'Synthetic workers did not become ready');
  const all = ['busy', 'fixed', 'open'].includes(mode)
    ? fixture.actors
    : fixture.actors.filter((user) => user.role === 'owner');
  const actors = mode === 'smoke' ? fixture.actors.slice(0, 15) : all;
  if (mode === 'smoke') {
    // All three public endpoints must work before a measured series is accepted.
    for (let sequence = 0; sequence < 30; sequence++) {
      const vu = sequence % actors.length;
      await client.action(actionPlan(sequence), actors[vu], vu, sequence);
    }
  }
  client.reset();
  const started = await command('/start', {
    name: label,
    phases: mode === 'diagnostic',
    cpu: mode === 'diagnostic',
  });
  for (const worker of started) {
    assert.equal(
      worker.harness.sha256,
      harnessIdentity().sha256,
      'Generator/server harness mismatch',
    );
    assert.equal(
      worker.runtimeFlags.backgroundProfile,
      profile.name,
      'Generator/server profile mismatch',
    );
  }
  const cpu = process.cpuUsage();
  let schedule, workers, background;
  try {
    schedule = await runSchedule({
      mode,
      actors,
      seconds,
      concurrent: Number(process.argv[5] || 20),
      rate: Number(process.argv[6] || 40),
      seed: Number(process.env.LOAD_SEED || 20261012),
      action: client.action,
    });
  } finally {
    const stopped = await command('/stop', {});
    workers = stopped.workers;
    background = stopped.background;
  }
  const result = buildResult({
    label,
    mode,
    seconds,
    fixture,
    client,
    schedule,
    workers,
    generatorCpu: process.cpuUsage(cpu),
    background,
  });
  const output = '/results/' + label + '.json';
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  const correctness = await client.reconcile();
  const owners = fixture.actors.filter((user) => user.role === 'owner');
  let isolation = 0;
  if (owners.length > 1)
    for (let index = 0; index < Math.min(owners.length, 20); index++) {
      try {
        await client.request(
          owners[index],
          index,
          'isolation',
          '/api/cabinet/patient?id=' + owners[(index + 1) % owners.length].patient,
        );
        throw Error('Foreign tenant allowed');
      } catch (error) {
        assert.equal(error.status, 404);
        isolation++;
      }
    }
  result.correctness = {
    ...correctness,
    foreignOrganizationsDenied: isolation,
    state:
      correctness.unresolvedWrites ||
      correctness.mismatchedRecords ||
      correctness.verificationErrors
        ? 'incomplete'
        : 'verified-latest-writes',
    scope:
      'Latest write per participating account; no mutation retry, no claim about superseded historical values',
  };
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      label,
      organizations: result.organizations,
      accounts: result.accounts,
      maximumConcurrentActions: result.maximumConcurrentActions,
      distinctOrganizationsTouched: result.distinctOrganizationsTouched,
      rps: result.rps,
      failures: result.failures,
      arrivals: result.arrivals,
      p95: Object.fromEntries(
        Object.entries(result.routes).map(([name, route]) => [name, route.allOutcomesP95Ms]),
      ),
      tenantOpens: workers.reduce((total, worker) => total + worker.tenantOpens, 0),
      correctness: result.correctness,
    }),
  );
  if (result.failures || result.correctness.state === 'incomplete') process.exitCode = 1;
}
main().catch((error) => {
  console.error(JSON.stringify({ event: 'synthetic-benchmark-failed', failure: failureDetails(error) }));
  process.exitCode = 1;
});
