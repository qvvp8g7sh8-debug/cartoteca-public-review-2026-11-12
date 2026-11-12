const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createNativeExecutor } = require('../src/server/infrastructure/native-executor.cjs');

function diagnostics(version, snapshot = false) {
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
  const view = { hits: 2, misses: 3, invalidated: 0, rejected: 0, entries: 2 };
  return {
    version,
    routes: Object.fromEntries(
      routes.map((name) => [
        name,
        Object.fromEntries(routeFields.map((key) => [key, key.endsWith('Ms') ? 0.25 : 2])),
      ]),
    ),
    pool: Object.fromEntries(poolFields.map((key) => [key, key.endsWith('Ms') ? 0.5 : 1])),
    ...(version > 1
      ? {
          readViews: {
            ...view,
            sqlResults: { hits: 1, misses: 2, rejected: 0, entries: 1 },
            ...(version === 3 ? { directoryResponses165: { ...view } } : {}),
            ...(snapshot
              ? {
                  directorySnapshots180: {
                    hits: 11,
                    misses: 4,
                    rejected: 0,
                    expired: 1,
                    evicted: 2,
                    entries: 2,
                    rows: 3000,
                    maxEntries: 128,
                    maxRows: 150000,
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}
async function fixture(t) {
  let worker;
  class ControlledWorker extends EventEmitter {
    messages = [];
    constructor() {
      super();
      queueMicrotask(() => this.emit('message', { ready: true }));
    }
    postMessage(message) {
      this.messages.push(message);
    }
    terminate() {
      queueMicrotask(() => this.emit('exit', 0));
      return Promise.resolve(0);
    }
  }
  const executor = createNativeExecutor({
    filename: __filename,
    concurrency: 1,
    timeoutMs: 2000,
    startupMs: 2000,
    workerFactory() {
      worker = new ControlledWorker();
      return worker;
    },
  });
  t.after(() => executor.close({ force: true }));
  await executor.ready();
  return {
    executor,
    async send(value) {
      const count = worker.messages.length;
      const pending = executor.run({ kind: 'query', metadata: {} });
      const deadline = Date.now() + 2000;
      while (worker.messages.length === count) {
        assert.ok(Date.now() < deadline, 'owned executor did not dispatch');
        await new Promise(setImmediate);
      }
      worker.emit('message', {
        id: worker.messages.at(-1).id,
        queryDiagnostics: value,
        result: { status: 200, headers: {}, body: Uint8Array.from([1, 2, 3]).buffer },
      });
      const result = await pending;
      result.release();
      return executor.stats().queryDiagnostics[0].snapshot;
    },
  };
}
test('182 legacy v1/v2/v3 diagnostics stay byte exact without snapshot fields', async (t) => {
  const f = await fixture(t);
  for (const version of [1, 2, 3]) {
    const value = diagnostics(version),
      expected = JSON.stringify(value);
    assert.equal(JSON.stringify(await f.send(value)), expected);
  }
});
test('182 bounded snapshot counters survive executor receipt and independent stats clones', async (t) => {
  const f = await fixture(t),
    value = diagnostics(3, true),
    expected = structuredClone(value);
  assert.deepEqual(await f.send(value), expected);
  value.readViews.directorySnapshots180.hits = 999;
  const external = f.executor.stats();
  external.queryDiagnostics[0].snapshot.readViews.directorySnapshots180.rows = 0;
  assert.deepEqual(f.executor.stats().queryDiagnostics[0].snapshot, expected);
  const maximum = diagnostics(3, true);
  maximum.readViews.directorySnapshots180.entries = 128;
  maximum.readViews.directorySnapshots180.rows = 150000;
  maximum.readViews.directorySnapshots180.hits = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(await f.send(maximum), maximum);
});
test('182 snapshot diagnostics reject private, extra, missing and malformed bounded fields', async (t) => {
  const f = await fixture(t);
  const invalid = [];
  const changed = (mutate) => {
    const value = diagnostics(3, true);
    mutate(value);
    invalid.push(value);
  };
  changed((v) => {
    v.readViews.directorySnapshots180.tenantId = 'PRIVATE';
  });
  changed((v) => {
    v.readViews.directorySnapshots180.clinicalRows = [];
  });
  changed((v) => {
    v.readViews.unknownSnapshot = {};
  });
  changed((v) => {
    delete v.readViews.directorySnapshots180.maxRows;
  });
  changed((v) => {
    v.readViews.directorySnapshots180 = null;
  });
  for (const value of [-1, 0.5, NaN, Infinity, '1', true, undefined, Number.MAX_SAFE_INTEGER + 1])
    changed((v) => {
      v.readViews.directorySnapshots180.hits = value;
    });
  for (const [key, value] of [
    ['maxEntries', 0],
    ['maxEntries', 129],
    ['maxRows', 0],
    ['maxRows', 150001],
    ['entries', 129],
    ['rows', 150001],
  ])
    changed((v) => {
      v.readViews.directorySnapshots180[key] = value;
    });
  changed((v) => {
    v.readViews.directorySnapshots180.entries = 0;
  });
  invalid.push(diagnostics(2, true));
  changed((v) => {
    v.version = 4;
  });
  for (const value of invalid) assert.equal(await f.send(value), null);
  assert.equal(JSON.stringify(f.executor.stats()).includes('PRIVATE'), false);
  assert.deepEqual(
    await f.send(diagnostics(3, true)),
    diagnostics(3, true),
    'bad telemetry must not retire the physical owner',
  );
});
