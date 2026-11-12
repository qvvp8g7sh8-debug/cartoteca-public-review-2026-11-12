const { performance } = require('node:perf_hooks');
const {
  stages,
  outcomes,
  beginAssistantTiming,
  validAssistantTiming,
} = require('../infrastructure/assistant-timing.cjs');

const MAX_MS = 150000;
const paths = new Set([
  'POST /api/assistant/transcribe',
  'POST /api/assistant/turn',
  'POST /api/assistant/speak',
  'GET /api/assistant/speak-audio',
  'POST /api/assistant/speak-audio',
]);
const names = new Map(stages.map((stage) => [stage, 'ct_' + stage.replaceAll('-', '_')]));
const noop = () => {};

// This request-local observer emits no log, identifier, dialogue text or provider
// setting. Header durations overlap: they are spans, never additive accounting.
function createAssistantResponseTiming(
  req,
  res,
  aggregate,
  { now = () => performance.now() } = {},
) {
  let started, original;
  try {
    if (
      typeof req?.url !== 'string' ||
      !paths.has(req.method + ' ' + req.url.split('?', 1)[0]) ||
      typeof res?.writeHead !== 'function'
    )
      return aggregate;
    original = res.writeHead;
    started = now();
    if (!Number.isFinite(started)) return aggregate;
  } catch {
    return aggregate;
  }
  const durations = new Map();
  function duration(start) {
    try {
      const elapsed = now() - start;
      return Number.isFinite(elapsed) && elapsed >= 0 ? Math.min(MAX_MS, elapsed) : null;
    } catch {
      return null;
    }
  }
  const timing = {
    begin(stage, kind, provider, fromRequest = false) {
      if (!validAssistantTiming(stage, kind, provider)) return noop;
      const aggregateEnd = beginAssistantTiming(aggregate, stage, kind, provider, fromRequest);
      let start;
      try {
        start = fromRequest === true && stage === 'tts-first-write' ? started : now();
      } catch {}
      let complete = false;
      return (outcome = 'completed') => {
        if (complete) return;
        complete = true;
        aggregateEnd(outcome);
        if (!outcomes.includes(outcome) || !Number.isFinite(start)) return;
        const elapsed = duration(start);
        if (elapsed !== null)
          durations.set(stage, Math.min(MAX_MS, (durations.get(stage) || 0) + elapsed));
      };
    },
  };
  try {
    res.writeHead = function (status, ...args) {
      // Restore before calling user-visible hooks; never alter writeHead binding,
      // argument shape or its result. Errors in diagnostics cannot fail a reply.
      try {
        res.writeHead = original;
      } catch {}
      if (status >= 200 && status < 300 && !res.headersSent && !res.destroyed) {
        try {
          const elapsed = duration(started);
          const values = elapsed === null ? [] : ['ct_request;dur=' + elapsed.toFixed(1)];
          for (const [stage, name] of names) {
            if (durations.has(stage)) values.push(name + ';dur=' + durations.get(stage).toFixed(1));
          }
          if (values.length) res.setHeader('Server-Timing', values.join(', '));
        } catch {}
      }
      return original.call(this, status, ...args);
    };
  } catch {
    return aggregate;
  }
  return timing;
}

module.exports = { createAssistantResponseTiming };
