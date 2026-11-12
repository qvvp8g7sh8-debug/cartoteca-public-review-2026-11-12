// External generator; requires an explicit marked synthetic fixture and literal isolated endpoints.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DATA } = require('./benchmark-organizations-fixture.cjs');
const { readFixture } = require('./benchmark-mixed92-fixture.cjs');
const {
  PROFILE,
  MIX,
  SLO,
  SLO_P99,
  endpoint,
  actorsFor,
  identity,
} = require('./benchmark-mixed92-profile.cjs');
const { createClient } = require('./benchmark-mixed92-client.cjs');
const { runSchedule } = require('./benchmark-mixed92-scheduler.cjs');
const { notificationCorrectness } = require('./benchmark-mixed92-results.cjs');
async function run({
  label,
  seconds = 60,
  rate = 600,
  active = 3000,
  cohort = 0,
  base = 'http://10.234.12.2:4173',
  control = 'http://10.234.12.2:4179',
  directory = DATA,
} = {}) {
  assert.match(label, /^[a-z0-9-]{1,64}$/);
  endpoint(base);
  endpoint(control, 'control');
  assert.equal(new URL(base).hostname, new URL(control).hostname);
  const fixture = readFixture(directory),
    actors = actorsFor(fixture, active, cohort);
  const jpeg = fs.readFileSync(path.join(directory, 'mixed92-photo.jpg'));
  assert.equal(crypto.createHash('sha256').update(jpeg).digest('hex'), fixture.jpegSha256);
  const client = createClient(fixture, { base, jpeg });
  async function command(route, method = 'POST') {
    const response = await fetch(control + route, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      headers: { 'X-Synthetic-Only': PROFILE.name },
    });
    assert.equal(response.status, 200, 'Synthetic control failed');
    return response.json();
  }
  const ready = await command('/ready', 'GET');
  assert.equal(ready.profile, PROFILE.name);
  assert.equal(ready.schema, 19);
  assert.equal(ready.actualModelNetwork, false);
  assert.equal(ready.harnessSha256, identity().sha256);
  assert.equal(ready.pushAvailable, true, 'Synthetic Push must be available before measuring');
  assert.equal(ready.accounts, fixture.actors.length);
  const cpu = process.cpuUsage(),
    before = process.memoryUsage();
  let schedule, server;
  await command('/start');
  try {
    schedule = await runSchedule({ actors, seconds, rate, action: client.action });
  } finally {
    server = await command('/stop');
  }
  const http = client.snapshot(),
    correctness = await client.reconcile();
  const result = {
    label,
    profile: PROFILE,
    mix: MIX,
    proposedP95SloMs: SLO,
    proposedP99SloMs: SLO_P99,
    assistantCapacity: { before: ready.assistantCapacity, after: server.assistantCapacity },
    scope:
      fixture.actors.length === PROFILE.accounts &&
      active === PROFILE.active &&
      rate === PROFILE.actionRate
        ? 'target'
        : 'smoke-or-partial',
    targetPopulationMet:
      fixture.actors.length === PROFILE.accounts &&
      fixture.organizations.length === PROFILE.organizations,
    targetActiveMet: active === PROFILE.active && rate === PROFILE.actionRate,
    provenance: {
      harness: identity(),
      environment: require('./benchmark-organizations-profile.cjs').environmentIdentity(),
    },
    fixture: {
      organizations: fixture.organizations.length,
      accounts: fixture.actors.length,
      cards: fixture.cards,
      active: actors.length,
      cohort,
      voicePilotAccounts: fixture.voicePilotAccounts,
      photoCohortAccounts: fixture.photoCohortAccounts,
      jpegBytes: jpeg.length,
      jpegSha256: fixture.jpegSha256,
    },
    schedule,
    http,
    correctness,
    errors: client.errors(),
    notificationCorrectness: notificationCorrectness(server.notifications),
    server,
    generator: {
      cpu: process.cpuUsage(cpu),
      before,
      after: process.memoryUsage(),
      resourceUsage: process.resourceUsage(),
    },
    accepted: Boolean(
      fixture.actors.length === PROFILE.accounts &&
      fixture.organizations.length === PROFILE.organizations &&
      active === PROFILE.active &&
      rate === PROFILE.actionRate &&
      schedule &&
      Object.keys(MIX).every((name) => schedule.classes[name]?.withinProposedSlo) &&
      schedule.coveredAccounts === actors.length &&
      correctness.attempted > 0 &&
      correctness.committed === correctness.attempted - correctness.rejected &&
      correctness.tenantIsolation === Math.min(20, fixture.organizations.length - 1) &&
      notificationCorrectness(server.notifications) &&
      server.assistantCapacity.matchesRequested &&
      !correctness.unknown &&
      !correctness.mismatched &&
      !correctness.tenantIsolationFailures,
    ),
    limitations: [
      'Initial voice turn plus synthetic streamed TTS/audio; no real microphone, STT, speaker, provider network or continuous conversation',
      'In-memory notification acknowledgements do not prove external provider delivery',
      'Registered population and active cohort differ; actual coverage is reported',
      'SLOs are proposed targets, not an already achieved capacity claim',
    ],
  };
  const output = '/results/' + label + '-mixed92.json';
  fs.writeFileSync(output, JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
  return { output, accepted: result.accepted, schedule, correctness };
}
module.exports = { run };
if (require.main === module)
  run({
    label: process.argv[2],
    seconds: Number(process.argv[3] || 60),
    rate: Number(process.argv[4] || 600),
    active: Number(process.argv[5] || 3000),
    cohort: Number(process.argv[6] || 0),
  })
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
