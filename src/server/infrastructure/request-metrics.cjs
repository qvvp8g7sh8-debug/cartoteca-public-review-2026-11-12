const { randomUUID } = require('node:crypto');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { photoProcessingStats } = require('./photos/image-processing.cjs');
const { safeStage, safeFailure } = require('./request-diagnostics.cjs');
const { createAssistantMeasurements, noAssistantTiming } = require('./assistant-timing.cjs');
const { createAssistantPlaybackMetrics } = require('./assistant-playback-metrics.cjs');

const noMeasurement = Object.freeze({
  route() {},
  phase() {},
  stage() {},
  failure() {},
  playback() {},
  assistant: noAssistantTiming,
});

const bounds = [5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10000, Infinity];
const phaseNames = new Set([
  'save-validation',
  'photo-preparation',
  'save-preparation',
  'save-notification-intent',
  'save-lock-wait',
  'save-cabinet-lock-wait',
  'save-transaction',
  'save-platform-commit',
  'save-cabinet-commit',
  'save-shared-lock-wait',
  'save-shared-cabinet-commit',
  'save-revalidation',
  'save-write',
  'booking-read-budget',
  'booking-platform-read',
  'booking-publication',
  'booking-provider-snapshot',
  'booking-services',
  'booking-readiness',
  'booking-availability',
  'booking-occupancy',
  'booking-slot-calculation',
]);
function createRequestMetrics({
  enabled = false,
  assistantEnabled = enabled,
  intervalMs = 60000,
  emit = console.log,
  resourceStats,
  assistantNow,
} = {}) {
  const routes = new Map(),
    phases = new Map(),
    failures = new Map();
  let failureOverflow = 0,
    assistantTimer = null,
    closed = false;
  function record(rows, name, ms) {
    let row = rows.get(name);
    if (!row)
      rows.set(
        name,
        (row = {
          count: 0,
          errors: 0,
          aborted: 0,
          maxMs: 0,
          totalMs: 0,
          buckets: bounds.map(() => 0),
        }),
      );
    row.count++;
    row.maxMs = Math.max(row.maxMs, ms);
    row.totalMs = Math.min(Number.MAX_SAFE_INTEGER, row.totalMs + ms);
    row.buckets[bounds.findIndex((bound) => ms <= bound)]++;
    return row;
  }
  function summaries(rows) {
    return [...rows].map(([route, row]) => {
      let count = 0;
      const bucket = row.buckets.findIndex((n) => (count += n) >= row.count * 0.95);
      return {
        route,
        count: row.count,
        errors: row.errors,
        aborted: row.aborted,
        maxMs: Math.round(row.maxMs),
        totalMs: Math.round(row.totalMs),
        p95UpperMs: Number.isFinite(bounds[bucket]) ? bounds[bucket] : null,
      };
    });
  }
  const assistant = assistantEnabled
    ? createAssistantMeasurements({
        record(rows, name, ms) {
          if (closed) return;
          record(rows, name, ms);
          armAssistantFlush();
        },
        summarize: summaries,
        ...(assistantNow ? { now: assistantNow } : {}),
      })
    : null;
  const playback = assistantEnabled ? createAssistantPlaybackMetrics() : null;
  function recordPlayback(current, body, header) {
    try {
      if (!closed && playback?.record(current, body, header)) armAssistantFlush();
    } catch {
      /* Optional client observations cannot affect the authorized operation. */
    }
  }
  function clearAssistantFlush() {
    clearTimeout(assistantTimer);
    assistantTimer = null;
  }
  function assistantSnapshot({ reset = false } = {}) {
    const result = {
      event: 'assistant_metrics',
      assistantPhases: assistant?.snapshot(reset) || [],
      playbackSummary: playback?.snapshot(reset) || null,
    };
    if (reset) clearAssistantFlush();
    return result;
  }
  function armAssistantFlush() {
    if (enabled || closed || assistantTimer !== null) return;
    // One lazy timeout per nonempty phase window, never an idle polling loop.
    assistantTimer = setTimeout(() => {
      assistantTimer = null;
      if (closed) return;
      const result = assistantSnapshot({ reset: true });
      if (!result.assistantPhases.length && !result.playbackSummary?.samples) return;
      try {
        emit(JSON.stringify(result));
      } catch {
        /* Observation must not affect a request or its accounting. */
      }
    }, 60000);
    assistantTimer.unref?.();
  }
  function assistantRoute(req) {
    try {
      if (typeof req.url !== 'string') return false;
      const query = req.url.indexOf('?'),
        path = query < 0 ? req.url : req.url.slice(0, query);
      return req.method === 'POST'
        ? [
            '/api/assistant/turn',
            '/api/assistant/transcribe',
            '/api/assistant/speak',
            '/api/assistant/speak-audio',
          ].includes(path)
        : req.method === 'GET' && path === '/api/assistant/speak-audio';
    } catch {
      return false;
    }
  }
  let active = 0,
    peak = 0,
    started = performance.now(),
    cpu = process.cpuUsage();
  const loop = enabled ? monitorEventLoopDelay({ resolution: 20 }) : null;
  loop?.enable();
  function snapshot({ reset = false } = {}) {
    const elapsedMs = performance.now() - started;
    const usage = process.cpuUsage(cpu);
    const result = {
      event: 'request_metrics',
      time: new Date().toISOString(),
      pid: process.pid,
      elapsedMs: Math.round(elapsedMs),
      active,
      peak,
      rssMiB: Math.round(process.memoryUsage().rss / 2 ** 20),
      photos: photoProcessingStats(),
      cpuCores: elapsedMs ? +((usage.user + usage.system) / (elapsedMs * 1000)).toFixed(3) : 0,
      eventLoopP95Ms: loop?.count ? +(loop.percentile(95) / 1e6).toFixed(2) : 0,
      routes: summaries(routes),
      phases: summaries(phases),
      assistantPhases: assistant?.snapshot(reset) || [],
      playbackSummary: playback?.snapshot(reset) || null,
      failures: [...failures.values()].map((row) => ({ ...row })),
      failureOverflow,
    };
    // The provider is internal and returns aggregate counters, never tenant identifiers.
    if (resourceStats) {
      try {
        result.resources = resourceStats();
      } catch {
        /* Metrics are non-fatal. */
      }
    }
    if (reset) {
      clearAssistantFlush();
      routes.clear();
      phases.clear();
      failures.clear();
      failureOverflow = 0;
      peak = active;
      started = performance.now();
      cpu = process.cpuUsage();
      loop?.reset();
    }
    return result;
  }
  function track(req, res) {
    // Only the server-generated ID is returned. Never log URL/query/body/cookie/IP.
    res.setHeader('X-Request-Id', randomUUID());
    if (closed) return noMeasurement;
    if (!enabled)
      return assistant && assistantRoute(req)
        ? { ...noMeasurement, assistant: assistant.observer(), playback: recordPlayback }
        : noMeasurement;
    const start = performance.now();
    let name = 'unmatched',
      complete = false,
      stage = 'unclassified',
      failureRecorded = false;
    active++;
    peak = Math.max(peak, active);
    const finish = () => {
      if (complete) return;
      complete = true;
      active--;
      const ms = performance.now() - start;
      const row = record(routes, name, ms);
      row.errors += Number(res.statusCode >= 500);
      row.aborted += Number(!res.writableFinished);
    };
    res.once('finish', finish);
    res.once('close', finish);
    // Caller supplies a registered route, never a user-controlled path.
    return {
      assistant: assistant?.observer() || noAssistantTiming,
      playback: recordPlayback,
      route(value) {
        name = value;
      },
      phase(value, ms, failed = false) {
        if (phaseNames.has(value) && Number.isFinite(ms) && ms >= 0)
          record(phases, value, ms).errors += Number(failed === true);
      },
      stage(value) {
        stage = safeStage(value);
      },
      failure(error, status) {
        if (failureRecorded) return;
        failureRecorded = true;
        const row = { route: name, stage, ...safeFailure(error, status) };
        const key = JSON.stringify(row);
        if (failures.has(key)) failures.get(key).count++;
        else if (failures.size < 128) failures.set(key, { ...row, count: 1 });
        else failureOverflow++;
      },
    };
  }
  // Explicit zero keeps a complete caller-controlled benchmark window without
  // disabling metrics; default production emission/reset remains every minute.
  const timer =
    enabled && intervalMs !== 0
      ? setInterval(
          () => {
            const row = snapshot({ reset: true });
            try {
              emit(JSON.stringify(row));
            } catch {
              /* Metrics must never break requests. */
            }
          },
          Math.max(1000, intervalMs),
        )
      : null;
  timer?.unref();
  return {
    track,
    snapshot,
    assistantSnapshot,
    close() {
      closed = true;
      clearAssistantFlush();
      assistant?.snapshot(true);
      playback?.close();
      clearInterval(timer);
      loop?.disable();
    },
  };
}
module.exports = { createRequestMetrics };
