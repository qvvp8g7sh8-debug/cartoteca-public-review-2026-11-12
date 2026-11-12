const { parentPort, workerData } = require('node:worker_threads');
const { createNativeQueryKernel } = require('./native-query-kernel.cjs');
const { createPostgresReadOperations } = require('./postgres/read-operations145.cjs');
const { createNativeQueryJobs166 } = require('./native-query-jobs166.cjs');
const {
  assertNativeMemoryProcess,
  startMemorySampling,
} = require('./native-memory-observation.cjs');
async function start() {
  const memoryProcess = workerData.config.nativeMemoryProcess;
  const memoryBudget = memoryProcess ? assertNativeMemoryProcess(memoryProcess) : null;
  const memorySampling = startMemorySampling(memoryProcess, workerData.nativeMemoryMailbox);
  const config = await require('./postgres/initialize.cjs').initializePostgresOwner(
    {
      ...workerData.config,
      ...(memoryProcess ? { nativeMemoryMailbox: workerData.nativeDatabaseMemoryMailbox } : {}),
    },
    {
      onFatal: () => {
        parentPort.postMessage({ fatal: true });
        process.exit(1);
      },
    },
  );
  let kernel, readOperations;
  try {
    readOperations = await createPostgresReadOperations(config, {
      readOwnerCapacity166: 2,
    });
    kernel = createNativeQueryKernel(config, { readOperations });
  } catch (error) {
    await readOperations?.close().catch(() => {});
    await config.databaseOwner?.close();
    throw error;
  }
  const capacity = readOperations?.capacity166 === 2 ? 2 : 1;
  const jobs = createNativeQueryJobs166({
    parentPort,
    kernel,
    capacity,
    sample: () => memorySampling?.publish(),
  });
  parentPort.on('message', jobs.receive);
  parentPort.postMessage({
    ready: true,
    ...(capacity === 2 ? { queryFeatures166: { version: 1, capacity: 2, replyCredit: true } } : {}),
    ...(memoryBudget ? { memoryBudget } : {}),
  });
}
start().catch((error) => {
  parentPort.postMessage({
    startupFailed: true,
    ...(error.code === 'NATIVE_MEMORY_BUDGET_MISMATCH' ? { code: error.code } : {}),
  });
  process.exitCode = 1;
  parentPort.close();
});
