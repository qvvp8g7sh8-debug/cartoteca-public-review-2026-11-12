const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, getEventListeners } = require('node:events');
const {
  createSpeechService,
  speechPayload,
} = require('../src/server/modules/assistant/speech/speech-service.cjs');
const { createSpeechOutput } = require('../src/server/modules/assistant/providers/timeweb/timeweb-speech-stream.cjs');
const MP3 = Buffer.alloc(417);
Buffer.from([255, 251, 144, 100]).copy(MP3);
const COMPLETE = Buffer.concat([MP3, MP3]);
const gate = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = async () => {
  for (let index = 0; index < 3; index++) await new Promise(setImmediate);
};
function http(actor) {
  const req = Object.assign(new EventEmitter(), { complete: true, aborted: false });
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    writableFinished: false,
    destroyed: false,
    chunks: [],
    writeHead(status, headers) {
      this.headersSent = true;
      this.status = status;
      this.headers = headers;
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
  return { req, res, current: { ...actor } };
}
function provider() {
  const queue = [],
    calls = [];
  function plan({ phase = 'body', bytes = COMPLETE, pendingCancel = false } = {}) {
    const headers = gate(),
      body = gate(),
      cancellation = gate();
    const row = {
      phase,
      bytes,
      signal: null,
      cancelCalls: 0,
      readCalls: 0,
      waiting: false,
      release() {
        headers.resolve();
        body.resolve();
      },
      releaseCancellation() {
        cancellation.resolve();
      },
    };
    queue.push(row);
    row.headers = headers;
    row.body = body;
    row.cancellation = cancellation;
    row.pendingCancel = pendingCancel;
    return row;
  }
  async function fetchImpl(_url, options) {
    const row = queue.shift();
    assert.ok(row, 'Every synthetic upstream operation requires its own explicit response');
    calls.push(row);
    row.signal = options.signal;
    // Intentionally ignore AbortSignal: the implementation must detach promptly
    // and explicitly dispose a pending reader or a response that arrives late.
    if (row.phase === 'headers') await row.headers.promise;
    let cancelled = false;
    const cancel = async () => {
      row.cancelCalls++;
      cancelled = true;
      row.body.resolve();
      if (row.pendingCancel) await row.cancellation.promise;
    };
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'audio/mpeg' }),
      body: {
        cancel,
        getReader() {
          return {
            cancel,
            async read() {
              row.readCalls++;
              if (cancelled) return { done: true };
              if (row.phase === 'partial' && row.readCalls === 1)
                return { done: false, value: MP3 };
              const first = row.phase === 'partial' ? 2 : 1;
              if (row.readCalls > first) return { done: true };
              if (row.phase === 'body' || row.phase === 'partial') {
                row.waiting = true;
                await row.body.promise;
                row.waiting = false;
              }
              return cancelled ? { done: true } : { done: false, value: row.bytes };
            },
          };
        },
      },
    };
  }
  return {
    plan,
    calls,
    fetchImpl,
    releaseAll() {
      for (const row of [...calls, ...queue]) {
        row.release();
        row.releaseCancellation();
      }
    },
  };
}
function fixture(t) {
  const actors = Object.fromEntries(
    ['a', 'b'].map((id) => [
      id,
      {
        accountId: id,
        organizationId: 'synthetic-shared-org',
        sessionId: 'session-' + id,
        role: id === 'a' ? 'owner' : 'salon_admin',
        expiresAt: Date.now() + 3600000,
      },
    ]),
  );
  const allowed = new Set(['a', 'b']),
    guards = { a: 0, b: 0 };
  const state = {
    revision: 1,
    providers: { tts: { provider: 'timeweb', model: 'test-tts', voice: 'alloy' } },
    credentials: { timeweb: 'synthetic-stream-key' },
    policy: { limits: { maxReplyChars: 600, requestTimeoutMs: 1000 } },
    rates: { ttsInput: 81, ttsOutput: 1620 },
  };
  const reservations = [],
    settlements = [],
    active = new Set();
  const scope = (c, version) => {
    const id = c.current.accountId,
      actor = actors[id];
    if (
      !actor ||
      !allowed.has(id) ||
      actor.sessionId !== c.current.sessionId ||
      actor.organizationId !== c.current.organizationId ||
      actor.role !== c.current.role
    )
      throw Object.assign(Error('Synthetic current membership revoked'), { status: 403 });
    if (version !== state.revision)
      throw Object.assign(Error('Synthetic stale policy'), { status: 409 });
    guards[id]++;
    return { state, member: { membershipId: 'membership-' + id } };
  };
  // This is an observable synthetic ledger, not evidence of actual platform billing.
  // Match the existing stream tests: 132-second reservation, actual rounded seconds,
  // zero reservation for followers/cache hits, conservative settlement after outbound failure.
  const budget = {
    reserve(current, version, kind, amount) {
      scope({ current }, version);
      assert.equal(kind, 'tts');
      const row = { id: reservations.length + 1, accountId: current.accountId, amount };
      reservations.push(row);
      active.add(row);
      return row;
    },
    settle(row, amount) {
      settlements.push({ reservation: row, amount, wasActive: active.has(row) });
      active.delete(row);
    },
  };
  const upstream = provider(),
    tasks = [];
  const api = createSpeechService({
    scope,
    budget,
    fetchImpl: upstream.fetchImpl,
    invoke() {
      throw Error('Streaming tests must not use buffered speech');
    },
  });
  const f = {
    api,
    upstream,
    actors,
    state,
    guards,
    reservations,
    settlements,
    active,
    revoke(id) {
      allowed.delete(id);
    },
    async ticket(id = 'a') {
      const result = await api.speak(http(actors[id]), {
        text: 'На какую дату?',
        policyVersion: state.revision,
        stream: true,
      });
      assert.equal(result.mimeType, 'audio/mpeg');
      const issued = new URL(result.streamUrl, 'http://synthetic.invalid');
      assert.deepEqual(
        [...issued.searchParams.keys()],
        ['ticket', 'accountContext', 'organizationContext'],
      );
      assert.match(issued.searchParams.get('ticket'), /^[A-Za-z0-9_-]{43}$/);
      assert.equal(issued.searchParams.get('accountContext'), actors[id].accountId);
      assert.equal(issued.searchParams.get('organizationContext'), actors[id].organizationId);
      const c = http(actors[id]);
      c.url = new URL(result.streamUrl, 'http://synthetic.invalid');
      return c;
    },
    start(c) {
      const task = { c, done: false, outcome: null };
      task.promise = Promise.resolve()
        .then(() => api.speakAudio(c))
        .then(
          (value) => {
            task.done = true;
            return (task.outcome = { value });
          },
          (error) => {
            task.done = true;
            return (task.outcome = { error });
          },
        );
      task.disconnect = () => c.res.destroy();
      tasks.push(task);
      return task;
    },
  };
  t.after(async () => {
    upstream.releaseAll();
    await Promise.all(tasks.map((task) => task.promise));
  });
  return f;
}
function clean(c, signal) {
  for (const emitter of [c.req, c.res])
    for (const event of emitter.eventNames())
      assert.equal(emitter.listenerCount(event), 0, 'Owned stream HTTP listeners must be removed');
  if (signal)
    assert.equal(
      getEventListeners(signal, 'abort').length,
      0,
      'Completed stream output must release registered abort listeners',
    );
}
function audio(task, expected = COMPLETE) {
  assert.equal(task.outcome.error, undefined);
  assert.equal(task.c.res.status, 200);
  assert.equal(task.c.res.headers['Content-Type'], 'audio/mpeg');
  assert.equal(task.c.res.writableFinished, true);
  assert.deepEqual(Buffer.concat(task.c.res.chunks), expected);
}
function paid(f) {
  return f.reservations.filter((row) => row.amount > 0);
}
function settledOnce(f) {
  assert.equal(f.active.size, 0);
  assert.ok(
    f.settlements.every((row) => row.wasActive),
    'Each synthetic reservation settles once',
  );
  assert.equal(f.settlements.length, f.reservations.length);
}

test('shared generic speech: owner A disconnect does not cancel live B or create another outbound call', async (t) => {
  const f = fixture(t),
    row = f.upstream.plan();
  const a = f.start(await f.ticket('a'));
  await flush();
  const b = f.start(await f.ticket('b'));
  await flush();
  assert.equal(f.upstream.calls.length, 1);
  assert.equal(paid(f).length, 1);
  assert.equal(paid(f)[0].accountId, 'a');
  const bChecks = f.guards.b;
  a.disconnect();
  await flush();
  const keptAlive = !row.signal.aborted && row.cancelCalls === 0;
  const aDetached = a.done;
  row.release();
  await Promise.all([a.promise, b.promise]);
  assert.equal(keptAlive, true, 'The remaining authorized B owns the shared generation');
  assert.equal(aDetached, true);
  assert.equal(a.c.res.writableFinished, false);
  audio(b);
  assert.ok(f.guards.b > bChecks, 'Follower must pass its own fresh guards after the await');
  assert.equal(f.upstream.calls.length, 1);
  const charged = f.settlements.find((item) => item.reservation.amount > 0);
  const actual =
    (Buffer.byteLength(JSON.stringify(speechPayload('На какую дату?'))) * 81 + 1620) / 1000000;
  assert.equal(charged.amount, actual);
  settledOnce(f);
  clean(a.c);
  clean(b.c, row.signal);
});

test('shared generic speech: follower B disconnect leaves owner A alive with one paid reservation', async (t) => {
  const f = fixture(t),
    row = f.upstream.plan();
  const a = f.start(await f.ticket('a'));
  await flush();
  const b = f.start(await f.ticket('b'));
  await flush();
  b.disconnect();
  await flush();
  assert.equal(row.signal.aborted, false);
  assert.equal(row.cancelCalls, 0);
  assert.equal(b.done, true);
  assert.equal(a.done, false);
  row.release();
  await Promise.all([a.promise, b.promise]);
  audio(a);
  assert.equal(b.c.res.chunks.length, 0);
  assert.equal(f.upstream.calls.length, 1);
  assert.equal(paid(f).length, 1);
  settledOnce(f);
  clean(a.c, row.signal);
  clean(b.c);
});

test('all stream waiters leaving cancels reader, conservatively settles one sent generation and removes its cache entry', async (t) => {
  const f = fixture(t),
    row = f.upstream.plan();
  const a = f.start(await f.ticket('a'));
  await flush();
  const b = f.start(await f.ticket('b'));
  await flush();
  a.disconnect();
  b.disconnect();
  await flush();
  const observed = {
    aborted: row.signal.aborted,
    cancelled: row.cancelCalls,
    detached: a.done && b.done,
    active: f.active.size,
  };
  row.release();
  await Promise.all([a.promise, b.promise]);
  assert.equal(observed.aborted, true);
  assert.ok(observed.cancelled > 0);
  assert.equal(observed.detached, true);
  assert.equal(observed.active, 0);
  const sent = f.settlements.filter((item) => item.reservation.amount > 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].amount, null, 'The shared sent failure keeps the conservative reservation');
  const replacement = f.upstream.plan({ phase: 'normal' });
  const retry = f.start(await f.ticket('b'));
  await retry.promise;
  audio(retry);
  assert.equal(
    f.upstream.calls.length,
    2,
    'An interrupted generation must not survive as a cache hit',
  );
  assert.equal(paid(f).length, 2);
  settledOnce(f);
  clean(a.c);
  clean(b.c, row.signal);
  clean(retry.c, replacement.signal);
});

test('owner membership revoked mid-generation cannot deny the separately authorized follower B', async (t) => {
  const f = fixture(t),
    row = f.upstream.plan();
  const a = f.start(await f.ticket('a'));
  await flush();
  const b = f.start(await f.ticket('b'));
  await flush();
  const bChecks = f.guards.b;
  f.revoke('a');
  row.release();
  await Promise.all([a.promise, b.promise]);
  assert.ok(a.outcome.error, 'Revoked A must not receive the generated audio');
  assert.equal(a.c.res.chunks.length, 0);
  audio(b);
  assert.ok(f.guards.b > bChecks);
  assert.equal(f.upstream.calls.length, 1);
  assert.equal(paid(f).length, 1);
  settledOnce(f);
  clean(a.c);
  clean(b.c, row.signal);
});

test('last stream disconnect before stubborn provider headers settles promptly and disposes the late response body', async (t) => {
  const f = fixture(t),
    row = f.upstream.plan({ phase: 'headers' });
  const a = f.start(await f.ticket('a'));
  await flush();
  const b = f.start(await f.ticket('b'));
  await flush();
  a.disconnect();
  b.disconnect();
  await flush();
  const detached = a.done && b.done,
    active = f.active.size;
  assert.equal(row.signal.aborted, true);
  clean(a.c);
  clean(b.c, row.signal);
  row.release();
  await Promise.all([a.promise, b.promise]);
  await flush();
  assert.equal(detached, true);
  assert.equal(active, 0);
  assert.ok(row.cancelCalls > 0, 'A late response must not leave its unread body alive');
  assert.equal(a.c.res.chunks.length + b.c.res.chunks.length, 0);
  settledOnce(f);
});

test('output.wait/dispose removes HTTP and once-abort listeners even while the original promise is still pending', async () => {
  const c = http({ accountId: 'a' }),
    pending = gate();
  const output = createSpeechOutput(c, () => {}, 1000);
  const waiting = output.wait(pending.promise).then(
    () => ({ ok: true }),
    (error) => ({ error }),
  );
  c.req.emit('close');
  assert.equal(output.signal.aborted, false, 'Normal completed request close must preserve output');
  c.res.destroy();
  const result = await waiting;
  output.dispose();
  assert.equal(result.error?.status, 499);
  assert.equal(getEventListeners(output.signal, 'abort').length, 0);
  clean(c, output.signal);
  pending.resolve('late ignored result');
  await flush();
  clean(c, output.signal);
});

test('completed generic speech cache hit uses a fresh one-use ticket, fresh B guards and no second outbound', async (t) => {
  const f = fixture(t),
    row = f.upstream.plan({ phase: 'normal' });
  const a = f.start(await f.ticket('a'));
  await a.promise;
  audio(a);
  const bContext = await f.ticket('b'),
    bChecks = f.guards.b;
  const b = f.start(bContext);
  await b.promise;
  audio(b);
  assert.ok(f.guards.b > bChecks);
  assert.equal(f.upstream.calls.length, 1);
  assert.equal(paid(f).length, 1);
  assert.equal(f.reservations[1].amount, 0);
  await assert.rejects(f.api.speakAudio(bContext), { status: 410 });
  const forbidden = await f.ticket('b');
  f.revoke('b');
  await assert.rejects(f.api.speakAudio(forbidden), { status: 403 });
  assert.equal(f.upstream.calls.length, 1);
  assert.equal(f.reservations.length, 2);
  settledOnce(f);
  clean(a.c, row.signal);
  clean(b.c);
});

test('interrupted partial MP3 is never promoted into the generic-question cache', async (t) => {
  const f = fixture(t),
    row = f.upstream.plan({ phase: 'partial' });
  const a = f.start(await f.ticket('a'));
  await flush();
  assert.ok(
    a.c.res.chunks.length > 0,
    'Fixture must reach real progressive MP3 output before disconnect',
  );
  a.disconnect();
  await flush();
  row.release();
  await a.promise;
  assert.ok(a.outcome.error);
  const next = f.upstream.plan({ phase: 'normal' });
  const b = f.start(await f.ticket('b'));
  await b.promise;
  audio(b);
  assert.equal(f.upstream.calls.length, 2);
  assert.equal(paid(f).length, 2);
  settledOnce(f);
  clean(a.c, row.signal);
  clean(b.c, next.signal);
});

test('a validated frame followed by a truncated MPEG frame fails and cannot poison a later cache hit', async (t) => {
  const f = fixture(t),
    bad = f.upstream.plan({
      phase: 'normal',
      bytes: Buffer.concat([MP3, Buffer.from([255, 251])]),
    });
  const a = f.start(await f.ticket('a'));
  await a.promise;
  assert.equal(a.outcome.error?.status, 502);
  const next = f.upstream.plan({ phase: 'normal' });
  const b = f.start(await f.ticket('b'));
  await b.promise;
  audio(b);
  assert.equal(f.upstream.calls.length, 2);
  assert.equal(paid(f).length, 2);
  settledOnce(f);
  clean(a.c, bad.signal);
  clean(b.c, next.signal);
});

test('a pending reader.cancel promise cannot delay all-waiter teardown, budget settlement or listener disposal', async (t) => {
  const f = fixture(t),
    row = f.upstream.plan({ pendingCancel: true });
  const a = f.start(await f.ticket('a'));
  await flush();
  const b = f.start(await f.ticket('b'));
  await flush();
  a.disconnect();
  b.disconnect();
  await flush();
  const listenerCount = (c) =>
    [c.req, c.res].reduce(
      (total, emitter) =>
        total +
        emitter.eventNames().reduce((count, event) => count + emitter.listenerCount(event), 0),
      0,
    );
  const beforeCleanup = {
    done: a.done && b.done,
    active: f.active.size,
    cancelCalls: row.cancelCalls,
    httpListeners: listenerCount(a.c) + listenerCount(b.c),
    abortListeners: getEventListeners(row.signal, 'abort').length,
  };
  // Release only after taking the observation; keep a failing test finite.
  row.releaseCancellation();
  row.release();
  await Promise.all([a.promise, b.promise]);
  assert.ok(beforeCleanup.cancelCalls > 0, 'Disposal must still invoke reader.cancel');
  assert.equal(
    beforeCleanup.done,
    true,
    'Uncooperative cancellation must not retain abandoned HTTP work',
  );
  assert.equal(beforeCleanup.active, 0);
  assert.equal(beforeCleanup.httpListeners, 0);
  assert.equal(beforeCleanup.abortListeners, 0);
  assert.equal(f.settlements.find((item) => item.reservation.amount > 0)?.amount, null);
  assert.equal(a.c.res.chunks.length + b.c.res.chunks.length, 0);
  settledOnce(f);
  clean(a.c);
  clean(b.c, row.signal);
});
// Inject a write-busy failure before the existing fake ledger commits its row
// and releases its reservation. The production cache is never inspected.
function faultLedger(f, count) {
  const append = f.settlements.push.bind(f.settlements),
    attempts = [],
    errors = [];
  f.settlements.push = (...rows) => {
    for (const row of rows) {
      attempts.push({ reservation: row.reservation, amount: row.amount });
      if (row.reservation.amount > 0 && errors.length < count) {
        const error = Object.assign(Error('Synthetic ledger write busy'), {
          status: 503,
          code: 'SYNTHETIC_LEDGER_WRITE_BUSY',
        });
        errors.push(error);
        throw error;
      }
    }
    return append(...rows);
  };
  return { attempts, errors };
}
function unresolvedPaidReservation(f, ledger, original, expectedAttempts) {
  assert.ok(original.amount > 0);
  assert.equal(
    f.active.has(original),
    true,
    'A failed ledger write must retain the conservative reservation for normal reconciliation',
  );
  assert.equal(
    f.settlements.filter((row) => row.reservation === original).length,
    0,
    'Failed persistence must not be reported as a completed or free charge',
  );
  const attempts = ledger.attempts.filter((row) => row.reservation === original);
  assert.equal(attempts.length, expectedAttempts);
  assert.equal(attempts.at(-1).amount, null, 'Sent uncertainty must use conservative settlement');
  assert.ok(
    attempts.every((row) => row.amount === null || row.amount > 0),
    'An already-sent reservation must never be released as zero after a persistence error',
  );
}
async function freshAfterLedgerFault(f, ledger, original, expectedAttempts) {
  const next = f.upstream.plan({ phase: 'normal' });
  const retry = f.start(await f.ticket('b'));
  await retry.promise;
  audio(retry);
  assert.equal(
    f.upstream.calls.length,
    2,
    'A failed generation must release its pending cache entry even if ledger settlement throws',
  );
  assert.equal(paid(f).length, 2, 'The new generation owns a distinct paid reservation');
  unresolvedPaidReservation(f, ledger, original, expectedAttempts);
  const successful = f.settlements.filter((row) => row.reservation.amount > 0);
  assert.equal(successful.length, 1);
  assert.notEqual(successful[0].reservation, original);
  assert.ok(successful[0].amount > 0);
  assert.equal(successful[0].wasActive, true);
  assert.equal(f.active.size, 1, 'Only the original unresolved ledger reservation remains held');
  clean(retry.c, next.signal);
}

test('a sent provider failure releases pending cache even when conservative ledger settlement throws', async (t) => {
  const f = fixture(t),
    ledger = faultLedger(f, 1);
  const row = f.upstream.plan({ phase: 'normal', bytes: Buffer.from('invalid synthetic MP3') });
  const a = f.start(await f.ticket('a'));
  await a.promise;
  assert.equal(ledger.errors.length, 1, 'The synthetic ledger fault must actually be reached');
  assert.equal(a.outcome.error, ledger.errors[0]);
  const original = paid(f)[0];
  unresolvedPaidReservation(f, ledger, original, 1);
  await freshAfterLedgerFault(f, ledger, original, 1);
  clean(a.c, row.signal);
});

test('all shared listeners leaving releases failed cache despite a write-busy conservative settlement', async (t) => {
  const f = fixture(t),
    ledger = faultLedger(f, 1),
    row = f.upstream.plan();
  const a = f.start(await f.ticket('a'));
  await flush();
  const b = f.start(await f.ticket('b'));
  await flush();
  a.disconnect();
  b.disconnect();
  await flush();
  row.release();
  await Promise.all([a.promise, b.promise]);
  assert.equal(ledger.errors.length, 1);
  assert.equal(row.signal.aborted, true);
  assert.ok(row.cancelCalls > 0);
  const original = paid(f)[0];
  unresolvedPaidReservation(f, ledger, original, 1);
  await freshAfterLedgerFault(f, ledger, original, 1);
  clean(a.c);
  clean(b.c, row.signal);
});

test('success-settlement and conservative fallback write failures cannot strand a generic cache entry or create a free retry', async (t) => {
  const f = fixture(t),
    ledger = faultLedger(f, 2);
  const row = f.upstream.plan({ phase: 'normal' });
  const a = f.start(await f.ticket('a'));
  await a.promise;
  assert.equal(ledger.errors.length, 2);
  assert.ok(ledger.errors.includes(a.outcome.error));
  const original = paid(f)[0];
  unresolvedPaidReservation(f, ledger, original, 2);
  const attempts = ledger.attempts.filter((item) => item.reservation === original);
  assert.ok(attempts[0].amount > 0, 'First write tried the successful actual audio cost');
  await freshAfterLedgerFault(f, ledger, original, 2);
  clean(a.c, row.signal);
});
