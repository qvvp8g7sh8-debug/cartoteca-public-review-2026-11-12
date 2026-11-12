const { performance } = require('node:perf_hooks');

const stages = Object.freeze([
  'access',
  'data-read',
  'admission',
  'provider-prepare',
  'outbound-mark',
  'provider-headers',
  'provider-first-byte',
  'provider-complete',
  'settlement',
  'interpretation',
  'domain',
  'tts-cache-wait',
  'tts-first-write',
  'tts-backpressure',
]);
const outcomes = Object.freeze(['completed', 'failed', 'cancelled']);
const providers = Object.freeze(['none', 'timeweb', 'codex', 'local', 'demo']);
const kinds = Object.freeze(['stt', 'llm', 'tts', 'turn']);
const noopEnd = () => {};
const noAssistantTiming = Object.freeze({ begin: () => noopEnd });
const combinations = [];
function add(stage, kind, provider) {
  for (const outcome of outcomes)
    combinations.push(Object.freeze({ stage, kind, provider, outcome }));
}
for (const stage of [
  'admission',
  'provider-prepare',
  'outbound-mark',
  'provider-complete',
  'settlement',
])
  for (const [kind, choices] of [
    ['stt', ['timeweb', 'local', 'demo']],
    ['llm', ['timeweb', 'codex', 'demo']],
    ['tts', ['timeweb', 'local', 'demo']],
  ])
    for (const provider of choices) add(stage, kind, provider);
for (const stage of ['provider-headers', 'provider-first-byte'])
  for (const kind of ['stt', 'llm', 'tts']) add(stage, kind, 'timeweb');
add('interpretation', 'turn', 'none');
for (const provider of ['timeweb', 'codex', 'demo']) add('interpretation', 'llm', provider);
add('domain', 'turn', 'none');
add('access', 'turn', 'none');
add('data-read', 'turn', 'none');
for (const stage of ['tts-cache-wait', 'tts-first-write', 'tts-backpressure'])
  add(stage, 'tts', 'timeweb');
const indices = new Map(
  combinations.map((row, index) => [JSON.stringify(Object.values(row)), index]),
);
function validAssistantTiming(stage, kind, provider) {
  return (
    typeof stage === 'string' &&
    typeof kind === 'string' &&
    typeof provider === 'string' &&
    indices.has(JSON.stringify([stage, kind, provider, 'completed']))
  );
}

function assistantOutcome(error) {
  try {
    return error?.code === 'ASSISTANT_REQUEST_ABORTED' || error?.status === 499
      ? 'cancelled'
      : 'failed';
  } catch {
    return 'failed';
  }
}
// Observer failures must not affect admission, accounting, guards or returned data.
function beginAssistantTiming(timing, stage, kind, provider, fromRequest = false) {
  if (!timing || timing === noAssistantTiming) return noopEnd;
  try {
    const end = timing.begin(stage, kind, provider, fromRequest);
    if (typeof end !== 'function' || end === noopEnd) return noopEnd;
    return (outcome = 'completed') => {
      try {
        end(outcome);
      } catch {}
    };
  } catch {
    return noopEnd;
  }
}
function createAssistantMeasurements({ record, summarize, now = () => performance.now() }) {
  const rows = new Map();
  function observer() {
    let requestStart;
    try {
      requestStart = now();
    } catch {
      return noAssistantTiming;
    }
    if (!Number.isFinite(requestStart)) return noAssistantTiming;
    return {
      begin(stage, kind, provider, fromRequest = false) {
        try {
          const key = JSON.stringify([stage, kind, provider, 'completed']);
          if (!indices.has(key)) return noopEnd;
          const start = fromRequest === true && stage === 'tts-first-write' ? requestStart : now();
          if (!Number.isFinite(start)) return noopEnd;
          let finished = false;
          return (outcome = 'completed') => {
            if (finished) return;
            finished = true;
            try {
              const index = indices.get(JSON.stringify([stage, kind, provider, outcome]));
              const ms = now() - start;
              if (index !== undefined && Number.isFinite(ms) && ms >= 0) record(rows, index, ms);
            } catch {}
          };
        } catch {
          return noopEnd;
        }
      },
    };
  }
  return {
    observer,
    snapshot(reset = false) {
      const result = summarize(rows).map(({ route, count, maxMs, totalMs, p95UpperMs }) => ({
        ...combinations[route],
        count,
        maxMs,
        totalMs,
        p95UpperMs,
      }));
      if (reset) rows.clear();
      return result;
    },
  };
}
module.exports = {
  stages,
  outcomes,
  providers,
  kinds,
  noAssistantTiming,
  beginAssistantTiming,
  assistantOutcome,
  createAssistantMeasurements,
  validAssistantTiming,
};
