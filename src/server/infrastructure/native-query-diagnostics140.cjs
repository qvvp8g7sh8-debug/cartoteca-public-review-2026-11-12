const { performance } = require('node:perf_hooks');
const routeNames = Object.freeze({
  '/api/cabinet/bootstrap': 'bootstrap',
  '/api/cabinet/directory': 'directory',
  '/api/cabinet/patient': 'patient',
  '/api/cabinet/patient/history': 'patient',
  '/api/cabinet/patient/upcoming': 'patient',
  '/api/cabinet/calendar': 'calendar',
  '/api/cabinet/operation': 'operation',
  '/api/cabinet/time-zone': 'timeZone',
  '/api/work-schedules': 'schedules',
  '/api/workspace': 'workspace',
  '/api/workspace/availability': 'availability',
  '/api/service-groups': 'serviceGroups',
});
const routeFields = [
  'count',
  'errors',
  'rpcCalls',
  'operationSqlCalls',
  'authMs',
  'projectionMs',
  'serializeMs',
  'totalMs',
];
const poolFields = [
  'hits',
  'misses',
  'opens',
  'openErrors',
  'evictions',
  'closes',
  'closeErrors',
  'openMs',
  'closeMs',
  'connections',
];
const add = (prior, value) => Math.min(Number.MAX_SAFE_INTEGER, prior + Math.max(0, value));
// Fixed technical dimensions only. No URL parameters, SQL, tenant, account or
// session identifiers are retained or emitted by these process-local counters.
// Counts cover recognized kernel projections. Pre-route rejection and a later
// worker cancellation belong to executor/HTTP totals, not these route counters.
function createQueryDiagnostics(owner, pool, operationSqlCalls = () => 0) {
  const routes = Object.fromEntries(
    Object.values(routeNames).map((name) => [
      name,
      Object.fromEntries(routeFields.map((field) => [field, 0])),
    ]),
  );
  return {
    begin(counters = {}) {
      const countRpc = counters.rpcCalls || (() => owner?.stats?.().calls || 0),
        countSql = counters.operationSqlCalls || operationSqlCalls;
      const started = performance.now(),
        calls = countRpc(),
        directCalls = countSql();
      const phases = { authMs: 0, projectionMs: 0, serializeMs: 0 };
      let route,
        projectionAuth = 0,
        projectionSerialized = 0,
        settled = false;
      return {
        route(pathname) {
          route = Object.hasOwn(routeNames, pathname) ? routeNames[pathname] : null;
        },
        phase(name, callback) {
          const at = performance.now();
          try {
            return callback();
          } finally {
            phases[name] += performance.now() - at;
          }
        },
        async phaseAsync(name, callback) {
          const at = performance.now();
          try {
            return await callback();
          } finally {
            phases[name] += performance.now() - at;
          }
        },
        projectionStart() {
          projectionAuth = phases.authMs;
          projectionSerialized = phases.serializeMs;
        },
        projection(elapsed) {
          phases.projectionMs += Math.max(
            0,
            elapsed -
              (phases.serializeMs - projectionSerialized) -
              (phases.authMs - projectionAuth),
          );
        },
        finish(status) {
          if (settled || !route) return;
          settled = true;
          const row = routes[route];
          row.count = add(row.count, 1);
          row.errors = add(row.errors, status >= 400 ? 1 : 0);
          row.rpcCalls = add(row.rpcCalls, Math.max(0, countRpc() - calls));
          row.operationSqlCalls = add(row.operationSqlCalls, Math.max(0, countSql() - directCalls));
          for (const name of Object.keys(phases)) row[name] = add(row[name], phases[name]);
          row.totalMs = add(row.totalMs, performance.now() - started);
        },
      };
    },
    stats() {
      const snapshot = pool.stats();
      return {
        version: 1,
        routes: Object.fromEntries(
          Object.entries(routes).map(([name, values]) => [name, { ...values }]),
        ),
        pool: Object.fromEntries(poolFields.map((name) => [name, snapshot[name]])),
      };
    },
  };
}
module.exports = { createQueryDiagnostics };
