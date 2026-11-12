// Advisory process-local activity only. No payload, authority or commit claim.
// A synchronous outer transaction settles before the coalesced microtask runs;
// rollback can cause a harmless fresh probe, never delivery without validation.
const databases = new WeakMap();
function createQueueActivity(db, key) {
  let queues = databases.get(db);
  if (!queues) databases.set(db, (queues = new Map()));
  if (!queues.has(key))
    queues.set(key, { listeners: new Set(), pending: new Set(), queued: false });
  const state = queues.get(key);
  return {
    subscribe(callback) {
      const listener = { callback, active: true };
      state.listeners.add(listener);
      return () => {
        listener.active = false;
        state.listeners.delete(listener);
      };
    },
    notify() {
      for (const listener of state.listeners) state.pending.add(listener);
      if (state.queued || !state.pending.size) return;
      state.queued = true;
      globalThis.queueMicrotask(() => {
        const pending = [...state.pending];
        state.pending.clear();
        state.queued = false;
        for (const listener of pending)
          if (listener.active) {
            try {
              listener.callback();
            } catch {
              /* Advisory wake cannot change a committed result. */
            }
          }
      });
    },
  };
}
module.exports = { createQueueActivity };
