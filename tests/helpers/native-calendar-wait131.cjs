const { parentPort, workerData } = require('node:worker_threads');
const state = new Int32Array(workerData.syntheticReadWait);
// Fixture-only barrier around the real query worker. No application hook is added.
parentPort.on('message', (message) => {
  if (message?.kind !== 'query' || !message.metadata?.url.startsWith('/api/workspace/availability'))
    return;
  if (Atomics.compareExchange(state, 0, 0, 1) !== 0) return;
  Atomics.notify(state, 0);
  Atomics.wait(state, 0, 1, 20000);
  if (Atomics.load(state, 0) === 1) throw Error('Synthetic read barrier release expired');
});
require(workerData.syntheticReadWorker);
