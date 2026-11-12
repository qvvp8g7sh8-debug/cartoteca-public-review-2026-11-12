const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRequestMetrics } = require('../src/server/infrastructure/request-metrics.cjs');
const {
  createSpeechService,
} = require('../src/server/modules/assistant/speech/speech-service.cjs');
const {
  createSpeechOutput,
  streamTimewebSpeech,
} = require('../src/server/modules/assistant/providers/timeweb/timeweb-speech-stream.cjs');
const MP3 = Buffer.alloc(417);
Buffer.from([255, 251, 144, 100]).copy(MP3);
const gate = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function fixture(t) {
  let clock = 0;
  const metrics = createRequestMetrics({ enabled: true, intervalMs: 0, assistantNow: () => clock });
  t.after(() => metrics.close());
  function context() {
    const req = new EventEmitter(),
      res = Object.assign(new EventEmitter(), {
        headersSent: false,
        destroyed: false,
        writableFinished: false,
        chunks: [],
        setHeader() {},
        writeHead() {
          this.headersSent = true;
        },
        write(bytes) {
          this.chunks.push(Buffer.from(bytes));
          return true;
        },
        end() {
          this.writableFinished = true;
          this.emit('finish');
        },
        destroy() {
          this.destroyed = true;
          this.emit('close');
        },
      });
    return {
      req,
      res,
      current: {
        accountId: 'synthetic-private-account',
        organizationId: 'synthetic-private-org',
        sessionId: 'synthetic-private-session',
        role: 'owner',
      },
      assistantTiming: metrics.track(req, res).assistant,
    };
  }
  return {
    metrics,
    context,
    time(value) {
      clock = value;
    },
  };
}
function upstream(read) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'audio/mpeg' }),
    body: { getReader: () => ({ read, cancel: async () => {} }), cancel: async () => {} },
  };
}
function row(f, stage, outcome = 'completed') {
  return f.metrics
    .snapshot()
    .assistantPhases.find((item) => item.stage === stage && item.outcome === outcome);
}
test('stream raw byte, validated HTTP first write and validated EOF have distinct measurements', async (t) => {
  const f = fixture(t),
    c = f.context(),
    output = createSpeechOutput(c, () => {}, 1000);
  let reads = 0;
  try {
    const result = await streamTimewebSpeech({
      provider: { model: 'synthetic', voice: 'alloy' },
      key: 'private-synthetic-key',
      payload: { input: 'Private text' },
      output,
      assistantTiming: c.assistantTiming,
      fetchImpl: async () => {
        f.time(4);
        return upstream(async () => {
          reads++;
          f.time(reads === 1 ? 12 : reads === 2 ? 30 : 35);
          return reads < 3
            ? { done: false, value: reads === 1 ? MP3.subarray(0, 4) : MP3.subarray(4) }
            : { done: true };
        });
      },
    });
    assert.equal(result.byteLength, MP3.length);
    assert.deepEqual(Buffer.concat(c.res.chunks), MP3);
    assert.equal(row(f, 'provider-headers').totalMs, 4);
    assert.equal(row(f, 'provider-first-byte').totalMs, 12);
    // The bounded packet completes at EOF; raw first-byte timing remains12ms.
    assert.equal(row(f, 'tts-first-write').totalMs, 35);
    assert.equal(row(f, 'provider-complete').totalMs, 35);
    output.end();
  } finally {
    output.dispose();
  }
  assert.equal(row(f, 'tts-first-write').count, 1);
  assert.doesNotMatch(
    JSON.stringify(f.metrics.snapshot().assistantPhases),
    /Private|private|synthetic/,
  );
});
test('invalid audio may have raw bytes but cannot produce a completed first write or provider completion', async (t) => {
  const f = fixture(t),
    c = f.context(),
    output = createSpeechOutput(c, () => {}, 1000);
  let read = false;
  try {
    await assert.rejects(
      streamTimewebSpeech({
        provider: { model: 'synthetic', voice: 'alloy' },
        key: 'synthetic',
        payload: {},
        output,
        assistantTiming: c.assistantTiming,
        fetchImpl: async () => {
          f.time(3);
          return upstream(async () => {
            f.time(9);
            if (read) return { done: true };
            read = true;
            return { done: false, value: Buffer.from('Private invalid MP3') };
          });
        },
      }),
      (error) => {
        output.observationFailed(error);
        return error.status === 502;
      },
    );
  } finally {
    output.dispose();
  }
  assert.equal(c.res.chunks.length, 0);
  assert.equal(row(f, 'provider-first-byte').totalMs, 9);
  assert.equal(row(f, 'provider-complete'), undefined);
  assert.equal(row(f, 'provider-complete', 'failed').count, 1);
  assert.equal(row(f, 'tts-first-write'), undefined);
  assert.equal(row(f, 'tts-first-write', 'failed').count, 1);
});
test('backpressure preserves drain and abort behavior while accounting each wait once', async (t) => {
  for (const cancelled of [false, true]) {
    const f = fixture(t),
      c = f.context();
    c.res.write = () => false;
    const output = createSpeechOutput(c, () => {}, 1000);
    try {
      f.time(5);
      let done = false;
      const pending = output.write(MP3).then(() => {
        done = true;
      });
      const rejected = cancelled ? assert.rejects(pending, { status: 499 }) : null;
      await Promise.resolve();
      assert.equal(done, false);
      assert.equal(row(f, 'tts-backpressure'), undefined);
      f.time(23);
      if (cancelled) {
        c.res.destroy();
        await rejected;
      } else {
        c.res.emit('drain');
        await pending;
        assert.equal(done, true);
      }
      assert.equal(row(f, 'tts-backpressure', cancelled ? 'cancelled' : 'completed').totalMs, 18);
      assert.equal(row(f, 'tts-first-write').totalMs, 5);
    } finally {
      output.dispose();
    }
    assert.equal(c.res.listenerCount('drain'), 0);
    assert.equal(c.res.listenerCount('error'), 0);
  }
});
test('shared generation outlives its HTTP owner: one provider, truthful late settlement and follower wait', async (t) => {
  const f = fixture(t),
    body = gate(),
    reached = gate(),
    settleGate = gate(),
    settlementReached = gate();
  const reservations = [],
    settled = [];
  let calls = 0,
    reads = 0,
    marks = 0;
  const state = {
    revision: 1,
    credentials: { timeweb: 'private-synthetic-key' },
    providers: { tts: { provider: 'timeweb', model: 'synthetic', voice: 'alloy' } },
    policy: { limits: { maxReplyChars: 600, requestTimeoutMs: 1000 } },
    rates: { ttsInput: 81, ttsOutput: 1620 },
  };
  const api = createSpeechService({
    scope: () => ({ state, member: { membershipId: 'private-membership' } }),
    invoke() {
      assert.fail('Streaming cannot use buffered invocation');
    },
    budget: {
      reserve(_c, _v, _k, amount) {
        const reservation = { amount };
        reservations.push(reservation);
        return reservation;
      },
      markOutbound() {
        marks++;
      },
      settle(reservation, amount) {
        settled.push({ reservation, amount });
        if (reservation.amount) {
          settlementReached.resolve();
          return settleGate.promise;
        }
      },
    },
    fetchImpl: async () => {
      calls++;
      f.time(10);
      reached.resolve();
      return upstream(async () => {
        if (++reads > 1) {
          f.time(40);
          return { done: true };
        }
        await body.promise;
        f.time(30);
        return { done: false, value: MP3 };
      });
    },
  });
  async function ticket() {
    const c = f.context(),
      result = await api.speak(c, { text: 'На какую дату?', policyVersion: 1, stream: true });
    c.url = new URL(result.streamUrl, 'http://synthetic.invalid');
    return c;
  }
  const owner = await ticket(),
    ownerPending = api.speakAudio(owner);
  await reached.promise;
  const follower = await ticket(),
    followerPending = api.speakAudio(follower);
  f.time(15);
  const ownerCancelled = assert.rejects(ownerPending, { status: 499 });
  owner.res.destroy();
  await ownerCancelled;
  assert.equal(row(f, 'tts-first-write', 'cancelled').count, 1);
  body.resolve();
  await settlementReached.promise;
  assert.equal(row(f, 'provider-complete').count, 1);
  assert.equal(row(f, 'settlement'), undefined);
  assert.equal(follower.res.chunks.length, 0);
  f.time(60);
  settleGate.resolve();
  await followerPending;
  assert.equal(calls, 1);
  assert.equal(marks, 1);
  assert.equal(reservations.length, 2);
  assert.equal(settled.length, 2);
  assert.ok(settled[0].amount > 0);
  assert.equal(settled[1].amount, 0);
  assert.deepEqual(Buffer.concat(follower.res.chunks), MP3);
  assert.equal(row(f, 'settlement').count, 2);
  assert.equal(row(f, 'settlement', 'cancelled'), undefined);
  assert.equal(row(f, 'tts-cache-wait').count, 1);
  assert.equal(row(f, 'tts-first-write').count, 1);
  await api.speakAudio(await ticket());
  assert.equal(calls, 1);
  assert.equal(row(f, 'tts-cache-wait').count, 2);
  assert.equal(row(f, 'provider-complete').count, 1);
});
