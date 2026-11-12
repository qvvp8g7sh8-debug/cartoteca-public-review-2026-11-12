const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  createRequestDispatcher,
  isRequestAdmissionDeferral,
} = require('../src/server/infrastructure/request-dispatcher.cjs');
const { createPushRuntime } = require('../src/server/modules/notifications/push-runtime.cjs');
const flush = () => new Promise(setImmediate);
async function admissionError(kind) {
  let now = 0,
    scheduled;
  const dispatcher = createRequestDispatcher({
    maxPending: 1,
    timeoutMs: 5,
    now: () => now,
    schedule: (cb) => {
      scheduled = cb;
      return 1;
    },
    cancelScheduled() {},
  });
  let result;
  if (kind === 'CAPACITY') {
    const first = dispatcher.run(() => assert.fail('Never admitted')).catch(() => {});
    result = await dispatcher.run(() => assert.fail('Never admitted')).catch((e) => e);
    dispatcher.close();
    await first;
  } else if (kind === 'EXPIRED') {
    const pending = dispatcher.run(() => assert.fail('Never admitted')).catch((e) => e);
    now = 5;
    scheduled();
    result = await pending;
    dispatcher.close();
  } else {
    dispatcher.close();
    result = await dispatcher.run(() => assert.fail('Never admitted')).catch((e) => e);
  }
  assert.equal(result.code, 'REQUEST_ADMISSION_' + kind);
  assert.equal(isRequestAdmissionDeferral(result), true);
  return result;
}
function fixture(t, error, rejectedPhase = '') {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const key = crypto.createECDH('prime256v1');
  key.generateKeys();
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic142',
    keys: {
      p256dh: key.getPublicKey().toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url'),
    },
  };
  const state = {
    now: 1000000,
    live: true,
    reject: true,
    sent: 0,
    finishes: [],
    deferred: [],
    queue: [],
    validError: null,
    send: async () => {},
    prepareGate: null,
  };
  const store = {
    runtimeAvailable: () => true,
    setRuntimeAvailable() {},
    hasEnabledEvents: () => false,
    hasPendingTests: () => true,
    peekManaged: () => state.queue.find((job) => job.next_at <= state.now) || null,
    claimManaged() {
      const index = state.queue.findIndex((job) => job.next_at <= state.now);
      if (index < 0) return null;
      const job = state.queue.splice(index, 1)[0];
      state.claimed = { ...job, status: 'sending' };
      return job;
    },
    valid() {
      if (state.validError) throw state.validError;
      return { decoded: { subscription } };
    },
    keys: () => ({ publicKey: 'synthetic', privateKey: 'synthetic' }),
    finish(job, status, nextAt) {
      state.finishes.push({ id: job.id, status, nextAt });
      return 1;
    },
    deferUnstarted(job, nextAt) {
      state.deferred.push({ ...job });
      if (state.claimed.lease_id !== job.lease_id || state.claimed.lease_until !== job.lease_until)
        return 0;
      state.queue.push({ ...job, next_at: nextAt });
      state.claimed.status = 'pending';
      return 1;
    },
  };
  const runtime = createPushRuntime({
    platform: { staffPush: store },
    tenantStore: () => assert.fail('Test events have no cabinet reads'),
    origin: 'https://synthetic.test',
    enabled: true,
    clock: () => state.now,
    monotonic: () => 0,
    canRun: () => state.live,
    runBackgroundWork(callback, org) {
      if (org && state.prepareGate) return state.prepareGate(callback);
      if (
        state.reject &&
        ((rejectedPhase === 'claim' && !org) || (rejectedPhase === 'prepare' && org))
      ) {
        state.reject = false;
        if (rejectedPhase === 'prepare' && state.rebind) state.claimed.lease_id = 'new-lease';
        return Promise.reject(error);
      }
      return callback();
    },
    send: async () => {
      state.sent++;
      return state.send();
    },
  });
  const put = (id) =>
    state.queue.push({
      id,
      device_id: id,
      organization_id: 'org',
      account_id: 'a',
      event_key: id,
      next_at: state.now,
      expires_at: state.now + 3600000,
      lease_id: 'lease-' + id,
      lease_until: state.now + 60000,
      attempts: 1,
      decoded: { event: 'test', reference: {} },
    });
  t.after(() => {
    state.live = false;
    runtime.stop();
  });
  const advance = async (ms = 0) => {
    state.now += ms;
    t.mock.timers.tick(ms);
    await flush();
  };
  return { state, store, runtime, put, advance };
}

test('dispatcher brands only its actual pre-callback capacity, expiry and closure; lookalikes are not deferrals', async () => {
  for (const kind of ['CAPACITY', 'EXPIRED', 'CLOSED']) await admissionError(kind);
  assert.equal(
    isRequestAdmissionDeferral(
      Object.assign(Error('fake'), { status: 503, code: 'REQUEST_ADMISSION_CAPACITY' }),
    ),
    false,
  );
  assert.equal(isRequestAdmissionDeferral(null), false);
  const unknown = await admissionError('CAPACITY');
  unknown.outcomeUnknown = true;
  assert.equal(isRequestAdmissionDeferral(unknown), false);
});

for (const kind of ['CAPACITY', 'EXPIRED', 'CLOSED'])
  test(`Push discovery ${kind} is deferred without a lease or provider15s cooldown`, async (t) => {
    const f = fixture(t, await admissionError(kind), 'claim');
    f.put('job');
    f.runtime.start();
    await f.advance();
    assert.equal(f.runtime.stats().claims, 0);
    assert.equal(f.runtime.stats().errors, 0);
    assert.equal(f.runtime.stats().admissionDeferrals, 1);
    await f.advance(999);
    assert.equal(f.state.sent, 0);
    await f.advance(1);
    assert.equal(f.state.sent, 1);
    assert.equal(f.runtime.stats().active, 0);
  });

for (const rebound of [false, true])
  test(`known no-send prepare refusal refunds only its exact lease, rebound=${rebound}`, async (t) => {
    const f = fixture(t, await admissionError('CAPACITY'), 'prepare');
    f.state.rebind = rebound;
    f.put('job');
    f.runtime.start();
    await f.advance();
    assert.equal(f.state.sent, 0);
    assert.equal(f.state.deferred.length, 1);
    assert.equal(f.state.deferred[0].lease_id, 'lease-job');
    assert.equal(f.runtime.stats().admissionDeferrals, 1);
    assert.equal(f.runtime.stats().errors, 0);
    assert.equal(f.runtime.stats().active, 0);
    if (rebound) {
      assert.equal(f.state.claimed.lease_id, 'new-lease');
      assert.equal(f.state.claimed.status, 'sending');
    } else {
      await f.advance(1000);
      assert.equal(f.state.sent, 1);
    }
  });

test('an entered callback SQL503 remains a real failure even if it carries a genuine dispatcher error', async (t) => {
  const f = fixture(t);
  f.state.validError = await admissionError('CAPACITY');
  f.put('job');
  f.runtime.start();
  await f.advance();
  assert.equal(f.runtime.stats().errors, 1);
  assert.equal(f.runtime.stats().admissionDeferrals, 0);
  assert.equal(f.state.sent, 0);
  assert.equal(f.state.deferred.length, 1);
  f.state.validError = null;
  await f.advance(14999);
  assert.equal(f.state.sent, 0);
  await f.advance(1);
  assert.equal(f.state.sent, 1);
});

for (const kind of ['429', 'unknown'])
  test(`actual provider ${kind} keeps cooldown and never becomes a local admission retry`, async (t) => {
    const f = fixture(t);
    f.put('first');
    f.state.send = async () => {
      throw kind === '429'
        ? { statusCode: 429, headers: { 'retry-after': '120' } }
        : { outcomeUnknown: true };
    };
    f.runtime.start();
    await f.advance();
    assert.equal(f.state.sent, 1);
    assert.equal(f.runtime.stats().admissionDeferrals, 0);
    assert.equal(f.state.deferred.length, 0);
    if (kind === '429') {
      assert.equal(f.state.finishes[0].status, 'pending');
      assert.equal(f.state.finishes[0].nextAt, 1120000);
    } else {
      assert.equal(f.state.finishes.length, 0);
      assert.equal(f.runtime.stats().errors, 1);
    }
    f.state.send = async () => {};
    f.put('later');
    await f.advance(14999);
    assert.equal(f.state.sent, 1);
    await f.advance(1);
    assert.equal(f.state.sent, 2);
  });

test('stop while prepare is queued retains the slot until actual settlement and refunds without sending', async (t) => {
  const f = fixture(t);
  let settle;
  f.state.prepareGate = (callback) =>
    new Promise((resolve) => {
      settle = () => resolve(callback());
    });
  f.put('job');
  f.runtime.start();
  await f.advance();
  assert.equal(f.runtime.stats().active, 1);
  f.state.live = false;
  f.runtime.stop();
  assert.equal(f.runtime.stats().active, 1);
  settle();
  await flush();
  assert.equal(f.runtime.stats().active, 0);
  assert.equal(f.state.sent, 0);
  assert.equal(f.state.deferred.length, 1);
  assert.equal(f.state.deferred[0].lease_id, 'lease-job');
});

test('separate trusted discovery lanes share the unchanged global and per-organization capacities', async () => {
  const dispatcher = createRequestDispatcher({
    maxPending: 32,
    maxPendingPerScope: 8,
    interactiveReserve: 0,
    scopeInteractiveReserve: 0,
    maxBackgroundPending: 16,
    maxBackgroundPendingPerScope: 8,
    schedule: () => 1,
    cancelScheduled() {},
  });
  const pending = [];
  for (const scopeKey of ['runtime:maintenance', 'runtime:push'])
    for (let n = 0; n < 8; n++)
      pending.push(
        dispatcher
          .run(() => assert.fail('Not drained'), { priority: 'background', scopeKey })
          .catch(() => {}),
      );
  await assert.rejects(
    dispatcher.run(() => {}, { priority: 'background', scopeKey: 'runtime:push' }),
    { code: 'REQUEST_ADMISSION_CAPACITY' },
  );
  assert.equal(dispatcher.stats().pending, 16);
  assert.equal(dispatcher.workStats().maxBackgroundPending, 16);
  assert.equal(dispatcher.workStats().maxBackgroundPendingPerScope, 8);
  dispatcher.close();
  await Promise.all(pending);
});
