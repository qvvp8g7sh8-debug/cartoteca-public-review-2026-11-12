const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createIsolatedServer } = require('../../src/server/application/isolated-server.cjs');
const MiB = 1024 * 1024;
async function main() {
  for (const nativeQueryWorkers of [2, 6]) {
    let seen;
    const owner = Object.assign(new EventEmitter(), {
      providerStatus: () => ({
        providers: { telegram: { configured: false }, max: { configured: false } },
      }),
      stats: () => ({ state: 'ready' }),
      endpoint: () => ({ host: '127.0.0.1', port: 1 }),
      commandEndpoint: () => ({ host: '127.0.0.1', port: 1 }),
      reserveCommand() {},
      close: async () => {},
    });
    const server = await createIsolatedServer(
      {
        production: false,
        origin: '',
        storageBackend: 'postgres',
        postgresProfile: 'local',
        postgresRevisionProfile: 3,
        postgres: {
          host: '127.0.0.1',
          port: 5432,
          database: 'synthetic',
          user: 'synthetic',
          password: 'synthetic',
        },
        nativeMemoryBudgetVersion: 1,
        nativeMemoryBudgetMiB: 8192,
        nativeQueryWorkers,
        nativeCommandOwners: 4,
        nativeCommandIsolation: true,
        tenantReadCacheBytes: 1152 * MiB,
        nativeDirectorySnapshots180: true,
      },
      {
        startApplication: async () => owner,
        createExecutor: (options) => {
          seen = options;
          return { ready: async () => {}, close: async () => {}, stats: () => ({}) };
        },
      },
    );
    try {
      assert.equal(seen.concurrency, nativeQueryWorkers);
      assert.equal(seen.workerData.config.tenantReadCacheBytes, 192 * MiB);
      assert.equal(seen.workerData.config.directoryMaxRows180, 150000);
      assert.equal(seen.workerData.config.nativeDirectorySnapshots180, true);
      assert.equal(seen.resourceLimits.maxOldGenerationSizeMb, 256);
      const status = server.isolationStatus();
      assert.equal(status.memory.budget.topology.isolateCount, 14 + 2 * nativeQueryWorkers);
      assert.equal(status.memory.gateway.main.heapSizeLimitBytes, 262 * MiB);
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
  process.stdout.write(
    JSON.stringify({
      queryCounts: [2, 6],
      actualGatewayHeapMiB: 262,
      mockedApplicationOwners: true,
    }),
  );
}
void main().catch((error) => {
  process.stderr.write(error.stack);
  process.exitCode = 1;
});
