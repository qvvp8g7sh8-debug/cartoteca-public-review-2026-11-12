const {
  harnessIdentity,
  environmentIdentity,
  fixtureIdentity,
  loadProfile,
} = require('./benchmark-organizations-profile.cjs');
const { summarizeFailures } = require('./benchmark-organizations-diagnostics.cjs');
const percentile = (values, fraction) =>
  values.length
    ? [...values].sort((a, b) => a - b)[
        Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)
      ]
    : null;
function routeResults(samples) {
  return Object.fromEntries(
    [...new Set(samples.map((row) => row.name))].map((name) => {
      const rows = samples.filter((row) => row.name === name),
        ok = rows.filter((row) => row.status === 200);
      return [
        name,
        {
          requests: rows.length,
          statuses: rows.reduce((counts, row) => {
            counts[row.status] = (counts[row.status] || 0) + 1;
            return counts;
          }, {}),
          httpStatuses: rows.reduce((counts, row) => {
            const key = row.httpStatus == null ? 'none' : row.httpStatus;
            counts[key] = (counts[key] || 0) + 1;
            return counts;
          }, {}),
          errorDiagnostics: summarizeFailures(rows),
          p50Ms: percentile(
            ok.map((row) => row.ms),
            0.5,
          ),
          p95Ms: percentile(
            ok.map((row) => row.ms),
            0.95,
          ),
          p99Ms: percentile(
            ok.map((row) => row.ms),
            0.99,
          ),
          allOutcomesP95Ms: percentile(
            rows.map((row) => row.ms),
            0.95,
          ),
          maxMs: rows.reduce((max, row) => Math.max(max, row.ms), 0),
        },
      ];
    }),
  );
}
function buildResult({
  label,
  mode,
  seconds,
  fixture,
  client,
  schedule,
  workers,
  generatorCpu,
  background = null,
}) {
  const { durations, failures, failureDiagnostics, ...offered } = schedule;
  return {
    label,
    mode,
    organizations: fixture.organizations.length,
    accounts: fixture.actors.length,
    usersPerOrganization: [1, 2, 3, 4, 5],
    cardsPerOrganization: fixture.cards,
    visitsPerCard: fixture.visits,
    schema: 17,
    requestedSeconds: seconds,
    elapsedMs: schedule.elapsedMs,
    maximumConcurrentActions: schedule.maximumConcurrentActions,
    distinctAccountsTouched: client.accounts.size,
    distinctOrganizationsTouched: client.organizations.size,
    requests: client.samples.length,
    rps: (client.samples.length * 1000) / schedule.elapsedMs,
    failures: failures.length,
    failureKinds: failures.reduce((counts, name) => {
      counts[name] = (counts[name] || 0) + 1;
      return counts;
    }, {}),
    errorDiagnostics: {
      requests: summarizeFailures(client.samples),
      actions: failureDiagnostics,
    },
    peakClientInFlight: client.peak,
    routes: routeResults(client.samples),
    workers,
    background,
    arrivals: {
      ...offered,
      actionP95FromScheduledMs: percentile(durations, 0.95),
      actionP99FromScheduledMs: percentile(durations, 0.99),
    },
    generator: {
      cpuCores: (generatorCpu.user + generatorCpu.system) / (schedule.elapsedMs * 1000),
      rssMiB: process.memoryUsage().rss / 2 ** 20,
    },
    provenance: {
      harness: harnessIdentity(),
      runtime: environmentIdentity(),
      fixture: fixtureIdentity(fixture),
      profile: {
        mode,
        seconds,
        seed: schedule.seed,
        requestTimeoutMs: 15000,
        measurementIncludesWarmup: false,
        warmup: mode === 'smoke' ? '30 action preflight' : 'none',
        diskColdStateControlledByHarness: false,
        transport: 'private-docker-http',
        generatorSharesPhysicalHost: true,
        background: loadProfile().name,
        requestOrigin: loadProfile().origin,
      },
    },
    measuredAt: new Date().toISOString(),
    physicalPhones: false,
    realData: false,
    senders: false,
    correctness: { state: 'pending' },
  };
}
module.exports = { percentile, routeResults, buildResult };
