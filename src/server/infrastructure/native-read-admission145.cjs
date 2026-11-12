const { AbortController } = globalThis;

// Private reader protocol: a bounded PG byte/row probe may yield its estimate
// before requesting the legacy full-read allowance. HTTP metadata never grants
// this capability; only the executor's closed route classifier can start it.
function createReadWorkUpgrade({
  workBudget,
  now,
  interrupted,
  cancel,
  stopWorker,
  record = () => {},
  getItem = (slot) => slot.item,
  ownsItem = (slot, item) => slot.item === item,
  beforeUpgrade = () => true,
}) {
  return function upgradeReadWork(slot, message) {
    const item = getItem(slot, message);
    if (
      !item ||
      !workBudget ||
      slot.stopping ||
      item.mutating ||
      item.workKind !== 'query-probe' ||
      item.upgraded ||
      message.memoryClass !== 'query' ||
      Object.keys(message).length !== 2 ||
      !item.workLease
    )
      return stopWorker(slot);
    // The completed probe owns only bounded metadata, covered by the worker's
    // baseline. No ciphertext or decoded result may be fetched before this
    // grant. After any isolate gate drains its sibling probe, yield this probe
    // estimate before joining the shared heavy FIFO.
    item.upgraded = item.upgradePending = true;
    record('queryUpgradeRequested');
    const begin = () => {
      if (!ownsItem(slot, item) || slot.stopping) return;
      if (interrupted(item)) return cancel(item);
      beginOwnedUpgrade();
    };
    if (beforeUpgrade(slot, item, begin)) begin();
    function beginOwnedUpgrade() {
      item.workLease.release();
      item.workLease = null;
      const abort = new AbortController();
      item.upgradeAbort = abort;
      workBudget
        .acquire('query', {
          signal: abort.signal,
          timeoutMs: Math.max(1, Math.ceil(item.deadline - now())),
        })
        .then(
          (lease) => {
            if (!ownsItem(slot, item) || slot.stopping || interrupted(item)) {
              lease.release();
              if (ownsItem(slot, item) && !slot.stopping) cancel(item);
              return;
            }
            item.workLease = lease;
            item.workKind = 'query';
            item.upgradePending = false;
            record('queryUpgradeGranted');
            try {
              slot.worker.postMessage({ id: item.id, memoryGranted: 'query' });
            } catch {
              stopWorker(slot);
            }
          },
          (error) => {
            if (!ownsItem(slot, item) || slot.stopping) return;
            item.upgradePending = false;
            record('queryUpgradeRefused');
            try {
              slot.worker.postMessage({
                id: item.id,
                memoryError: {
                  code: error.code || 'NATIVE_MEMORY_WORK_CAPACITY',
                },
              });
            } catch {
              stopWorker(slot);
            }
          },
        );
    }
  };
}
module.exports = { createReadWorkUpgrade };
