const { parentPort, threadId } = require('node:worker_threads');
const {
  createNativeQueryJobs166,
} = require('../../src/server/infrastructure/native-query-jobs166.cjs');
const routes = [
  'bootstrap',
  'directory',
  'patient',
  'calendar',
  'operation',
  'timeZone',
  'schedules',
  'workspace',
  'availability',
  'serviceGroups',
];
const fields = [
  'count',
  'errors',
  'rpcCalls',
  'operationSqlCalls',
  'authMs',
  'projectionMs',
  'serializeMs',
  'totalMs',
];
const pool = [
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
const views = () => ({
  hits: 0,
  misses: 0,
  invalidated: 0,
  rejected: 0,
  entries: 0,
});
let active = 0,
  peak = 0,
  count = 0;
const kernel = {
  async run(metadata) {
    active++;
    peak = Math.max(peak, active);
    count++;
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        status: 200,
        headers: { 'x-thread': String(threadId), 'x-peak': String(peak) },
        body: Uint8Array.from(Buffer.alloc(metadata.bytes, metadata.tag)).buffer,
      };
    } finally {
      active--;
    }
  },
  stats() {
    const snapshot = {
      version: 3,
      routes: Object.fromEntries(
        routes.map((name) => [name, Object.fromEntries(fields.map((field) => [field, 0]))]),
      ),
      pool: Object.fromEntries(pool.map((field) => [field, 0])),
      readViews: {
        ...views(),
        sqlResults: { hits: 0, misses: 0, rejected: 0, entries: 0 },
        directoryResponses165: views(),
      },
    };
    snapshot.routes.directory.count = count;
    return snapshot;
  },
};
const jobs = createNativeQueryJobs166({ parentPort, kernel, capacity: 2 });
parentPort.on('message', jobs.receive);
parentPort.postMessage({
  ready: true,
  queryFeatures166: { version: 1, capacity: 2, replyCredit: true },
});
