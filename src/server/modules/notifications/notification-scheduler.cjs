const { setImmediate: yieldImmediate } = require('node:timers/promises');
const { performance } = require('node:perf_hooks');

// One synchronous work item owns its own transaction. Yield only after that
// item returns, never while a platform/cabinet lock or borrowed cursor is held.
function createNotificationScheduler({ organizations, organizationBatch, work }) {
  let busy = false;
  function schedule() {
    if (busy) return false;
    busy = true;
    try {
      for (const org of organizations())
        for (const _ of work(org)) {
        }
      return true;
    } finally {
      busy = false;
    }
  }
  async function scheduleBatched({
    signal,
    canRun = () => true,
    runWork = (callback) => callback(),
  } = {}) {
    if (busy) return false;
    busy = true;
    const allowed = () => !signal?.aborted && canRun();
    let cursor = '',
      page = [],
      fallback,
      offset = 0;
    let steps = 0,
      organizationsInSlice = 0,
      sliceStarted = performance.now(),
      sliceVersion = 0;
    try {
      while (allowed()) {
        // The dispatcher owns the actual synchronous callback, never a no-op
        // permit followed by unaccounted SQL. Nothing is borrowed across await.
        const discovery = runWork(() => {
          if (!allowed()) return null;
          if (organizationBatch) return organizationBatch(cursor, 25);
          fallback ||= organizations();
          const rows = fallback.slice(offset, offset + 25);
          offset += rows.length;
          return rows;
        }, '');
        page = discovery && typeof discovery.then === 'function' ? await discovery : discovery;
        if (!allowed() || page === null) return false;
        if (!page.length) return true;
        for (const org of page) {
          if (!allowed()) return false;
          const items = work(org, () => sliceVersion);
          let scope = org;
          for (;;) {
            if (!allowed()) return false;
            const pending = runWork(() => (allowed() ? items.next() : null), scope);
            const item = pending && typeof pending.then === 'function' ? await pending : pending;
            if (!allowed() || item === null) return false;
            // Due iterators first discover a row, then yield its trusted scope
            // before the following transaction. No request supplies this hint.
            scope =
              typeof item.value?.organizationId === 'string' ? item.value.organizationId : org;
            steps++;
            if (item.done) organizationsInSlice++;
            if (
              steps >= 32 ||
              organizationsInSlice >= 25 ||
              performance.now() - sliceStarted >= 8
            ) {
              await yieldImmediate();
              if (!allowed()) return false;
              sliceVersion++;
              steps = 0;
              organizationsInSlice = 0;
              sliceStarted = performance.now();
            }
            if (item.done) break;
          }
          cursor = org;
        }
        if (page.length < 25) return true;
      }
      return false;
    } finally {
      busy = false;
    }
  }
  return { schedule, scheduleBatched };
}

module.exports = { createNotificationScheduler };
