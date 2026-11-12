const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRequestMetrics } = require('../src/server/infrastructure/request-metrics.cjs');
const { callTimeweb } = require('../src/server/modules/assistant/providers/timeweb/timeweb.cjs');
function fixture(t) {
  let clock = 0;
  const metrics = createRequestMetrics({ enabled: true, intervalMs: 0, assistantNow: () => clock });
  t.after(() => metrics.close());
  const res = Object.assign(new EventEmitter(), { setHeader() {} });
  return {
    metrics,
    timing: metrics.track({}, res).assistant,
    time(value) {
      clock = value;
    },
  };
}
function call(f, fetchImpl, extra = {}) {
  return callTimeweb({
    kind: 'llm',
    provider: { model: 'synthetic' },
    key: 'private-synthetic-key',
    payload: { messages: [{ role: 'user', content: 'Private synthetic client command' }] },
    timeoutMs: 1000,
    guard() {},
    fetchImpl,
    assistantTiming: f.timing,
    ...extra,
  });
}
function body(f, bytes, { status = 200, empty = false } = {}) {
  let reads = 0;
  return {
    ok: status === 200,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: {
      cancel: async () => {},
      getReader: () => ({
        cancel: async () => {},
        async read() {
          f.time(++reads === 1 ? 27 : 35);
          return reads === 1 && !empty ? { done: false, value: bytes } : { done: true };
        },
      }),
    },
  };
}
test('buffered Timeweb observes real headers and first nonempty body separately from schema validity', async (t) => {
  for (const valid of [true, false]) {
    const f = fixture(t),
      response = body(
        f,
        Buffer.from(
          valid
            ? JSON.stringify({
                choices: [{ finish_reason: 'stop', message: { content: '{"intent":"calendar"}' } }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
              })
            : 'invalid private response',
        ),
      );
    const pending = call(f, async () => {
      f.time(10);
      return response;
    });
    if (valid) assert.equal((await pending).text, '{"intent":"calendar"}');
    else await assert.rejects(pending, { status: 502 });
    assert.deepEqual(
      f.metrics
        .snapshot()
        .assistantPhases.map(({ stage, outcome, totalMs }) => ({ stage, outcome, totalMs })),
      [
        { stage: 'provider-headers', outcome: 'completed', totalMs: 10 },
        { stage: 'provider-first-byte', outcome: 'completed', totalMs: 27 },
      ],
    );
    assert.doesNotMatch(
      JSON.stringify(f.metrics.snapshot().assistantPhases),
      /Private|private|synthetic/,
    );
  }
});
test('429 and empty-body failures have no completed first-byte sample or invented zero latency', async (t) => {
  for (const options of [{ status: 429 }, { empty: true }]) {
    const f = fixture(t);
    await assert.rejects(
      call(f, async () => {
        f.time(10);
        return body(f, Buffer.alloc(0), options);
      }),
      { status: options.status || 502 },
    );
    const rows = f.metrics.snapshot().assistantPhases;
    assert.equal(rows.find((row) => row.stage === 'provider-headers').outcome, 'completed');
    const byte = rows.find((row) => row.stage === 'provider-first-byte');
    assert.equal(byte.outcome, 'failed');
    assert.ok(byte.totalMs >= 10);
  }
});
test('cancelled header wait records cancellation and does not await an uncooperative provider', async (t) => {
  const f = fixture(t),
    controller = new AbortController();
  let started;
  const reached = new Promise((resolve) => {
    started = resolve;
  });
  const pending = call(
    f,
    () => {
      started();
      return new Promise(() => {});
    },
    { signal: controller.signal },
  );
  await reached;
  f.time(19);
  controller.abort();
  await assert.rejects(pending, { code: 'ASSISTANT_REQUEST_ABORTED' });
  assert.deepEqual(
    f.metrics.snapshot().assistantPhases.map(({ outcome, totalMs }) => ({ outcome, totalMs })),
    [
      { outcome: 'cancelled', totalMs: 19 },
      { outcome: 'cancelled', totalMs: 19 },
    ],
  );
});
test('throwing timing sinks preserve outbound admission ordering and verified provider content', async () => {
  let mark,
    reached = false,
    calls = 0;
  const admission = new Promise((resolve) => {
    mark = resolve;
  });
  const f = {
    timing: {
      begin() {
        throw Error('private observer outage');
      },
    },
  };
  const pending = call(
    f,
    async () => {
      calls++;
      assert.equal(reached, true);
      return Response.json({ choices: [{ message: { content: 'verified result' } }] });
    },
    { onOutbound: () => admission },
  );
  await Promise.resolve();
  assert.equal(calls, 0);
  reached = true;
  mark();
  assert.equal((await pending).text, 'verified result');
  assert.equal(calls, 1);
});
