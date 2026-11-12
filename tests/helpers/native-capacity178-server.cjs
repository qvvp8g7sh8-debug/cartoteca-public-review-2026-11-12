const { once } = require('node:events');
const { createIsolatedServer } = require('../../src/server/application/isolated-server.cjs');
const {
  normalizeNativeMemoryReport,
} = require('../../src/server/infrastructure/native-memory-observation.cjs');
let server, starting, closing;
const send = (message) =>
  new Promise((resolve) => {
    if (!process.connected) return resolve();
    process.send(message, resolve);
  });
function status() {
  const value = server.isolationStatus();
  const record = (row) =>
    row && {
      role: row.role,
      pid: row.pid,
      exited: row.exited,
      ready: row.ready,
      memoryBudget: row.memoryBudget,
      memory: row.memory && normalizeNativeMemoryReport(row.memory),
    };
  return {
    closeState: value.closeState,
    memory: value.memory,
    owner: {
      state: value.owner.state,
      application: record(value.owner.application),
      background: record(value.owner.background),
      commands: value.owner.commands.map(record),
    },
    queries: {
      workers: value.queries.workers,
      readyWorkers: value.queries.readyWorkers,
      closed: value.queries.closed,
      started: value.queries.started,
      completed: value.queries.completed,
      cancelled: value.queries.cancelled,
      timedOut: value.queries.timedOut,
      failures: value.queries.failures,
      refused: value.queries.refused,
      queryProbeStarted: value.queries.queryProbeStarted,
      queryUpgradeRequested: value.queries.queryUpgradeRequested,
      queryUpgradeGranted: value.queries.queryUpgradeGranted,
      queryUpgradeRefused: value.queries.queryUpgradeRefused,
      limits: value.queries.limits,
      pending: value.queries.pending,
      active: value.queries.active,
      workPending: value.queries.workPending,
      retainedBytes: value.queries.retainedBytes,
      reservedBytes: value.queries.reservedBytes,
      memory: value.queries.memory.map(({ index, report }) => ({
        index,
        report: report && normalizeNativeMemoryReport(report, { allowWorkerMain: true }),
      })),
    },
    commands: Object.fromEntries(
      ['active', 'pending', 'activeLimit', 'pendingLimit', 'workPending']
        .filter((key) => Number.isSafeInteger(value.commands[key]))
        .map((key) => [key, value.commands[key]]),
    ),
    commandLimit: value.commands.activeLimit,
  };
}
async function close(id) {
  if (closing) return closing;
  closing = (async () => {
    await starting?.catch(() => {});
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await send({ id, type: 'closed', status: server ? status() : null });
    if (process.connected) process.disconnect();
  })();
  return closing;
}
async function message(value) {
  if (value.type === 'start' && !starting) {
    starting = (async () => {
      server = await createIsolatedServer(value.config);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      await send({ id: value.id, type: 'ready', port: server.address().port, status: status() });
    })();
    await starting;
  } else if (value.type === 'stats' && server)
    await send({ id: value.id, type: 'stats', status: status() });
  else if (value.type === 'close') await close(value.id);
}
process.on('message', (value) => {
  void message(value).catch(async (error) => {
    const code = ['NATIVE_MEMORY_BUDGET_MISMATCH', 'NATIVE_STARTUP_CLEANUP_FAILED'].includes(
      error.code,
    )
      ? error.code
      : 'MANAGED_SYNTHETIC_STARTUP_FAILED';
    await send({ id: value.id, type: 'failed', code });
    await close().catch(() => {});
    process.exitCode = 1;
  });
});
process.once(
  'disconnect',
  () =>
    void close().catch(() => {
      process.exitCode = 1;
    }),
);
