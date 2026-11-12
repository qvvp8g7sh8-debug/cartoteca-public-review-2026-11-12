const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRequestMetrics } = require('../src/server/infrastructure/request-metrics.cjs');
const {
  stages,
  kinds,
  providers,
  outcomes,
  noAssistantTiming,
  beginAssistantTiming,
  assistantOutcome,
  createAssistantMeasurements,
} = require('../src/server/infrastructure/assistant-timing.cjs');
function response() {
  return Object.assign(new EventEmitter(), {
    setHeader() {},
    statusCode: 200,
    writableFinished: false,
  });
}
function measured(t) {
  let clock = 0;
  const metrics = createRequestMetrics({ enabled: true, intervalMs: 0, assistantNow: () => clock });
  t.after(() => metrics.close());
  const res = response(),
    sample = metrics.track({}, res);
  return {
    metrics,
    res,
    sample,
    time(value) {
      clock = value;
    },
  };
}
test('default-OFF assistant observation shares no-op functions and never reads its injected clock', () => {
  const metrics = createRequestMetrics({
    assistantNow() {
      assert.fail('Disabled observer clock');
    },
  });
  try {
    const a = metrics.track({}, response()),
      b = metrics.track({}, response());
    assert.equal(a, b);
    assert.equal(a.assistant, noAssistantTiming);
    const first = beginAssistantTiming(a.assistant, 'admission', 'llm', 'timeweb');
    assert.equal(first, beginAssistantTiming(undefined, 'domain', 'turn', 'none'));
    first();
    first('failed');
    assert.deepEqual(metrics.snapshot().assistantPhases, []);
  } finally {
    metrics.close();
  }
});
test('headers, first body byte and eventual settlement retain independent outcomes after response close', (t) => {
  const f = measured(t),
    timing = f.sample.assistant;
  const headers = beginAssistantTiming(timing, 'provider-headers', 'llm', 'timeweb');
  const byte = beginAssistantTiming(timing, 'provider-first-byte', 'llm', 'timeweb');
  f.time(10);
  headers();
  headers('failed');
  f.time(27);
  byte();
  const settle = beginAssistantTiming(timing, 'settlement', 'llm', 'timeweb');
  f.res.emit('close');
  f.time(61);
  settle();
  const rows = f.metrics.snapshot().assistantPhases;
  assert.deepEqual(
    rows.map(({ stage, outcome, count, totalMs }) => ({ stage, outcome, count, totalMs })),
    [
      { stage: 'provider-headers', outcome: 'completed', count: 1, totalMs: 10 },
      { stage: 'provider-first-byte', outcome: 'completed', count: 1, totalMs: 27 },
      { stage: 'settlement', outcome: 'completed', count: 1, totalMs: 34 },
    ],
  );
  assert.equal(f.metrics.snapshot().routes[0].aborted, 1);
  assert.equal(f.metrics.snapshot().active, 0);
});
test('assistant phases use a fixed finite tuple set and cannot retain private labels or error fields', (t) => {
  const f = measured(t),
    timing = f.sample.assistant;
  for (const stage of stages)
    for (const kind of kinds)
      for (const provider of providers)
        for (const outcome of outcomes) {
          const end = beginAssistantTiming(timing, stage, kind, provider);
          f.time(1);
          end(outcome);
        }
  const count = f.metrics.snapshot().assistantPhases.length;
  assert.ok(count > 100 && count < 200);
  for (let i = 0; i < 1000; i++) {
    beginAssistantTiming(timing, 'private-name-' + i, 'turn', 'none')();
    beginAssistantTiming(timing, 'domain', 'turn', 'private-provider-' + i)();
  }
  beginAssistantTiming(timing, 'domain', 'turn', 'none')('private-secret');
  const rows = f.metrics.snapshot().assistantPhases;
  assert.equal(rows.length, count);
  assert.ok(
    rows.every(
      (row) =>
        Object.keys(row).sort().join(',') ===
        'count,kind,maxMs,outcome,p95UpperMs,provider,stage,totalMs',
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(rows),
    /private|account|organization|token|session|text|audio/i,
  );
  f.res.writableFinished = true;
  f.res.emit('finish');
});
test('request-origin first write is distinct from phase start, and reset keeps unfinished spans valid', (t) => {
  const f = measured(t);
  f.time(20);
  const first = beginAssistantTiming(f.sample.assistant, 'tts-first-write', 'tts', 'timeweb', true);
  const ordinary = beginAssistantTiming(f.sample.assistant, 'provider-headers', 'tts', 'timeweb');
  f.metrics.snapshot({ reset: true });
  f.time(40);
  first();
  ordinary();
  assert.deepEqual(
    f.metrics.snapshot().assistantPhases.map((row) => row.totalMs),
    [40, 20],
  );
  assert.equal(f.metrics.snapshot({ reset: true }).assistantPhases.length, 2);
  assert.deepEqual(f.metrics.snapshot().assistantPhases, []);
});
test('only explicit cancellation is classified cancelled; observer, clocks and unusual getters cannot break callers', () => {
  for (const error of [{ code: 'ASSISTANT_REQUEST_ABORTED' }, { status: 499 }])
    assert.equal(assistantOutcome(error), 'cancelled');
  for (const error of [
    { status: 429 },
    { status: 502 },
    { status: 403 },
    Error('aborted cancelled secret'),
    {
      get code() {
        throw Error('private');
      },
    },
  ])
    assert.equal(assistantOutcome(error), 'failed');
  assert.doesNotThrow(() =>
    beginAssistantTiming(
      {
        begin() {
          throw Error('unavailable');
        },
      },
      'domain',
      'turn',
      'none',
    )(),
  );
  assert.doesNotThrow(() =>
    beginAssistantTiming(
      {
        begin: () => () => {
          throw Error('unavailable');
        },
      },
      'domain',
      'turn',
      'none',
    )(),
  );
  const measurements = createAssistantMeasurements({
    now() {
      throw Error('unavailable');
    },
    record() {
      assert.fail('No clock sample');
    },
    summarize: () => [],
  });
  assert.equal(measurements.observer(), noAssistantTiming);
  let clock = 10;
  const broken = createAssistantMeasurements({
    now: () => clock,
    record() {
      throw Error('sink');
    },
    summarize: () => [],
  });
  const end = broken.observer().begin('domain', 'turn', 'none');
  clock = 9;
  assert.doesNotThrow(() => end());
  const next = broken.observer().begin('domain', 'turn', 'none');
  clock = 11;
  assert.doesNotThrow(() => next());
});
