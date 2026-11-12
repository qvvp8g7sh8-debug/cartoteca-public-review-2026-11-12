const { performance } = require('node:perf_hooks');
const { fail } = require('../../shared/errors.cjs');
// The cache target may overflow while leases are active, up to a separate hard cap.
// This bounds connections in this pool, not host-wide memory or other processes.
function createTenantPool({
  open,
  limit = 64,
  maxConnections = limit * 2,
  idleMs = 0,
  now = Date.now,
}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024)
    throw Error('Invalid tenant cache limit');
  if (!Number.isSafeInteger(maxConnections) || maxConnections < limit || maxConnections > 2048)
    throw Error('Invalid tenant connection limit');
  const entries = new Map();
  if (!Number.isSafeInteger(idleMs) || idleMs < 0 || idleMs > 86400000)
    throw Error('Invalid tenant idle timeout');
  const counters = {
    hits: 0,
    misses: 0,
    opens: 0,
    openErrors: 0,
    refused: 0,
    evictions: 0,
    closes: 0,
    closeErrors: 0,
    openMs: 0,
    closeMs: 0,
    peakConnections: 0,
  };
  const closeBoundsMs = [1, 5, 10, 50, 100, 500, 1000];
  const phases = (names) =>
    Object.fromEntries(
      names.map((name) => [
        name,
        {
          count: 0,
          errors: 0,
          totalMs: 0,
          maxMs: 0,
          buckets: Array(closeBoundsMs.length + 1).fill(0),
        },
      ]),
    );
  const closePhases = phases(['cleanup', 'database']);
  const openPhases = phases(['key', 'configuration', 'schema', 'indexes']);
  function record(phases, name, elapsed, failed) {
    const phase = Object.hasOwn(phases, name) ? phases[name] : null;
    if (!phase || !Number.isFinite(elapsed) || elapsed < 0) return;
    phase.count++;
    if (failed) phase.errors++;
    phase.totalMs = Math.min(Number.MAX_SAFE_INTEGER, phase.totalMs + elapsed);
    phase.maxMs = Math.max(phase.maxMs, elapsed);
    const bucket = closeBoundsMs.findIndex((bound) => elapsed <= bound);
    phase.buckets[bucket < 0 ? closeBoundsMs.length : bucket]++;
  }
  const recordClose = (name, elapsed, failed) => record(closePhases, name, elapsed, failed);
  const recordOpen = (name, elapsed, failed) => record(openPhases, name, elapsed, failed);
  let closed = false;
  function closeEntry(id, entry, evicted = true) {
    const started = performance.now();
    // Do not remove a store from accounting unless its close succeeds.
    try {
      entry.store.close(recordClose);
      entries.delete(id);
      counters.closes++;
      if (evicted) counters.evictions++;
    } catch (error) {
      counters.closeErrors++;
      throw error;
    } finally {
      counters.closeMs += performance.now() - started;
    }
  }
  function trim(target) {
    for (const [id, entry] of entries) {
      if (entries.size <= target) break;
      if (entry.pins) continue;
      closeEntry(id, entry);
    }
  }
  function entry(id) {
    if (closed) throw Error('Tenant pool is closed');
    let value = entries.get(id);
    if (value) {
      counters.hits++;
      value.touched = now();
      entries.delete(id);
      entries.set(id, value);
      return value;
    }
    counters.misses++;
    trim(limit - 1);
    // Never close another request's pinned store or open above the hard cap.
    // Existing stores remain usable; a new scope can retry after a lease releases.
    if (entries.size >= maxConnections) {
      counters.refused++;
      throw Object.assign(
        fail(503, 'Сервер обрабатывает другие кабинеты. Повторите через секунду.'),
        { code: 'TENANT_POOL_CAPACITY', retryAfter: 1 },
      );
    }
    const started = performance.now();
    try {
      value = { store: open(id, recordOpen), pins: 0, touched: now() };
      counters.opens++;
    } catch (error) {
      counters.openErrors++;
      throw error;
    } finally {
      counters.openMs += performance.now() - started;
    }
    entries.set(id, value);
    counters.peakConnections = Math.max(counters.peakConnections, entries.size);
    return value;
  }
  function get(id) {
    return entry(id).store;
  }
  function lease() {
    const pinned = new Set();
    let released = false;
    return {
      get(id) {
        if (released) throw Error('Tenant lease already released');
        const value = entry(id);
        if (!pinned.has(value)) {
          value.pins++;
          pinned.add(value);
        }
        return value.store;
      },
      release() {
        if (released) return;
        released = true;
        for (const value of pinned) {
          value.pins--;
          value.touched = now();
        }
        pinned.clear();
        trim(limit);
      },
    };
  }
  function close() {
    closed = true;
    clearInterval(timer);
    for (const [id, entry] of entries) closeEntry(id, entry, false);
  }
  function sweep() {
    if (!idleMs || closed) return;
    for (const [id, value] of entries)
      if (!value.pins && now() - value.touched >= idleMs) closeEntry(id, value);
  }
  function stats() {
    const pinned = [...entries.values()].filter((entry) => entry.pins > 0).length;
    return {
      ...counters,
      closeBoundsMs: [...closeBoundsMs],
      closePhases: Object.fromEntries(
        Object.entries(closePhases).map(([name, phase]) => [
          name,
          { ...phase, buckets: [...phase.buckets] },
        ]),
      ),
      openBoundsMs: [...closeBoundsMs],
      openPhases: Object.fromEntries(
        Object.entries(openPhases).map(([name, phase]) => [
          name,
          { ...phase, buckets: [...phase.buckets] },
        ]),
      ),
      limit,
      maxConnections,
      idleMs,
      connections: entries.size,
      pinned,
      overBudget: Math.max(0, entries.size - limit),
    };
  }
  const timer = idleMs
    ? setInterval(
        () => {
          try {
            sweep();
          } catch {
            /* Failed closes remain tracked and are retried later. */
          }
        },
        Math.max(1000, Math.min(idleMs, 60000)),
      )
    : null;
  timer?.unref();
  return { get, lease, close, sweep, stats };
}
module.exports = { createTenantPool };
