const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createPushRuntime } = require('../src/server/modules/notifications/push-runtime.cjs');
const {
  createManagedPushDelivery,
} = require('../src/server/modules/notifications/push-managed-delivery.cjs');
const flush = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const key = crypto.createECDH('prime256v1');
  key.generateKeys();
  const sub = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic104',
    keys: {
      p256dh: key.getPublicKey().toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url'),
    },
  };
  const s = {
    now: 1000000,
    mono: 0,
    queue: [],
    sent: [],
    finished: [],
    expired: [],
    available: true,
    owner: true,
    valid: true,
    closed: false,
    claims: 0,
    probes: 0,
    send: async () => {},
    validHook: () => {},
    peekHook: () => {},
    claimCost: 0,
  };
  function eligible(blocked = {}) {
    return s.queue.findIndex(
      (job) =>
        job.next_at <= s.now &&
        !(blocked.excludeDevices || []).includes(job.device_id) &&
        !(blocked.excludeOrganizations || []).includes(job.organization_id),
    );
  }
  const store = {
    runtimeAvailable: () => s.available,
    setRuntimeAvailable: (value) => {
      s.available = value;
    },
    hasEnabledEvents: () => false,
    hasPendingTests: () => true,
    claim() {
      s.claims++;
      const index = eligible();
      return index < 0 ? null : s.queue.splice(index, 1)[0];
    },
    claimManaged(_now, blocked) {
      assert.equal(s.closed, false);
      s.claims++;
      s.mono += s.claimCost;
      const index = eligible(blocked);
      return index < 0 ? null : s.queue.splice(index, 1)[0];
    },
    peekManaged(_now, blocked) {
      assert.equal(s.closed, false);
      s.probes++;
      s.peekHook();
      return s.queue[eligible(blocked)] || null;
    },
    valid(job) {
      assert.equal(s.closed, false);
      s.validHook(job);
      return s.valid
        ? { id: job.device_id, decoded: { subscription: sub, bindingId: 'binding' } }
        : null;
    },
    finish(job, status, nextAt) {
      assert.equal(s.closed, false);
      s.finished.push({ id: job.id, status, nextAt });
      return 1;
    },
    expire: (...args) => s.expired.push(args),
    keys: () => ({ publicKey: 'synthetic-public', privateKey: 'synthetic-private' }),
  };
  const runtime = createPushRuntime({
    platform: { staffPush: store },
    tenantStore: () => assert.fail('test messages never read a cabinet'),
    origin: 'https://synthetic.test',
    enabled: true,
    clock: () => s.now,
    monotonic: () => s.mono,
    canRun: () => s.owner,
    send: (subscription, payload, options) => {
      s.sent.push({ subscription, payload: JSON.parse(payload), options, sentAt: s.now });
      return s.send();
    },
  });
  t.after(() => runtime.stop());
  const put = (id, org = id, device = id, nextAt = s.now) =>
    s.queue.push({
      id,
      device_id: device,
      organization_id: org,
      account_id: 'account-' + id,
      event_key: 'event-' + id,
      next_at: nextAt,
      expires_at: s.now + 3600000,
      attempts: 1,
      decoded: { event: 'test', reference: {} },
    });
  async function advance(ms = 0) {
    s.now += ms;
    s.mono += ms;
    t.mock.timers.tick(ms);
    await flush();
  }
  return { s, store, runtime, put, advance };
}
test('managed Push starts immediately, bounds4/2/1 and drains other devices while one provider is paused', async (t) => {
  const f = fixture(t),
    gates = [];
  for (const [id, org, device] of [
    ['a1', 'a', 'a1'],
    ['a2', 'a', 'a2'],
    ['a3', 'a', 'a3'],
    ['same', 'a', 'a1'],
    ['b1', 'b', 'b1'],
    ['c1', 'c', 'c1'],
    ['d1', 'd', 'd1'],
  ])
    f.put(id, org, device);
  const expiresAt = f.s.queue[0].expires_at;
  f.s.send = () => {
    const gate = deferred();
    gates.push(gate);
    return gate.promise;
  };
  f.runtime.start();
  await f.advance();
  assert.equal(f.s.sent.length, 4);
  assert.deepEqual(
    f.s.sent.map((row) => row.payload.data.accountId),
    ['account-a1', 'account-a2', 'account-b1', 'account-c1'],
  );
  assert.equal(f.runtime.stats().active, 4);
  gates[2].resolve();
  await flush();
  await f.advance(1);
  assert.equal(
    f.s.sent.length,
    5,
    'a completed slot may send without awaiting the slow first device',
  );
  assert.equal(f.s.sent[4].payload.data.accountId, 'account-d1');
  gates[1].resolve();
  await flush();
  await f.advance(1);
  assert.equal(f.s.sent[5].payload.data.accountId, 'account-a3');
  assert.ok(!f.s.sent.some((row) => row.payload.data.accountId === 'account-same'));
  gates[0].resolve();
  await flush();
  await f.advance(1);
  assert.equal(f.s.sent[6].payload.data.accountId, 'account-same');
  f.runtime.stop();
  gates.forEach((gate) => gate.resolve());
  await flush();
  assert.equal(f.runtime.stats().active, 0);
  for (const row of f.s.sent) {
    assert.equal(row.options.timeout, 10000);
    assert.equal(
      row.options.TTL,
      Math.max(1, Math.min(3600, Math.floor((expiresAt - row.sentAt) / 1000))),
    );
    assert.equal(row.options.urgency, 'normal');
    assert.ok(!/patientName|phone|PRIVATE/.test(JSON.stringify(row.payload)));
  }
});
test('stop/restart retains actual unresolved slots; a closed-store ACK commit fails without fabricating a retry', async (t) => {
  const f = fixture(t),
    gate = deferred();
  for (let n = 0; n < 6; n++) f.put('job' + n);
  f.s.send = () => gate.promise;
  f.runtime.start();
  await f.advance();
  f.runtime.stop();
  f.s.closed = true;
  assert.doesNotThrow(() => f.runtime.stats());
  await f.advance(60001);
  assert.equal(f.s.sent.length, 4);
  f.s.closed = false;
  f.runtime.start();
  await f.advance();
  await f.runtime.tick();
  assert.equal(
    f.s.sent.length,
    4,
    'restart/manual tick cannot evade old live slots even beyond durable lease',
  );
  f.s.closed = true;
  gate.resolve();
  await flush();
  assert.equal(f.s.finished.length, 0);
  assert.equal(f.runtime.stats().stale, 0);
  assert.equal(
    f.runtime.stats().errors,
    4,
    'closed-store commit errors do not become provider retries',
  );
  f.s.closed = false;
  f.s.send = async () => {};
  await f.advance(1);
  assert.equal(f.s.sent.length, 6);
  assert.equal(f.s.finished.length, 2);
});
test('fresh ACL and process ownership still fence managed send after selection, and payload preparation revalidates binding', async (t) => {
  const f = fixture(t);
  f.put('revoked');
  let checks = 0;
  f.s.validHook = () => {
    if (++checks === 2) f.s.valid = false;
  };
  f.runtime.start();
  await f.advance();
  assert.equal(f.s.sent.length, 0);
  assert.deepEqual(
    f.s.finished.map((r) => [r.id, r.status]),
    [['revoked', 'cancelled']],
  );
  f.put('lost-lease');
  f.s.valid = true;
  f.s.peekHook = () => {
    f.s.owner = false;
  };
  const claims = f.s.claims;
  await f.advance(1);
  assert.equal(f.s.claims, claims, 'lease is checked again after a synchronous head probe');
});
test('managed429 applies individual RetryAfter plus15s channel cooldown, without altering TTL or fifth-attempt failure', async (t) => {
  const f = fixture(t);
  for (let n = 0; n < 7; n++) f.put('retry' + n);
  f.s.queue[0].attempts = 5;
  f.s.send = async () => {
    throw { statusCode: 429, headers: { 'retry-after': '120' } };
  };
  f.runtime.start();
  await f.advance();
  assert.equal(
    f.s.sent.length,
    4,
    'already admitted requests may precede the first asynchronous429',
  );
  assert.equal(f.s.finished[0].status, 'failed');
  assert.equal(
    f.s.finished[0].nextAt,
    1960000,
    'fifth attempt retains exponential delay even when terminal',
  );
  for (const row of f.s.finished.slice(1)) {
    assert.equal(row.status, 'pending');
    assert.equal(row.nextAt, 1120000);
  }
  await f.advance(14999);
  assert.equal(f.s.sent.length, 4);
  await f.advance(1);
  assert.equal(f.s.sent.length, 7);
  assert.equal(f.runtime.stats().retried, 6);
  assert.equal(f.runtime.stats().failed, 1);
});
test('managed410 expires the exact binding; CPU debt yields instead of repeatedly scanning legacy claims', async (t) => {
  const f = fixture(t);
  f.put('gone');
  f.put('later');
  f.s.claimCost = 20;
  f.s.send = async () => {
    throw { statusCode: 410 };
  };
  f.runtime.start();
  await f.advance();
  assert.equal(f.s.claims, 1);
  assert.deepEqual(f.s.expired, [['gone', 'binding']]);
  await f.advance(28);
  assert.equal(f.s.claims, 1);
  await f.advance(1);
  assert.equal(f.s.claims, 2);
  assert.ok(f.runtime.stats().budgetYields >= 1);
});
test('managed stats have a fixed privacy-safe shape and cached-head age; idle probes avoid claim/cleanup', async (t) => {
  const f = fixture(t);
  assert.deepEqual(f.runtime.stats(), {
    active: 0,
    peakActive: 0,
    activeOrganizations: 0,
    syncWorkMs: 0,
    budgetYields: 0,
    turns: 0,
    probes: 0,
    claims: 0,
    started: 0,
    sent: 0,
    cancelled: 0,
    retried: 0,
    failed: 0,
    stale: 0,
    errors: 0,
    admissionDeferrals: 0,
    claimedNextAtLag: { count: 0, totalMs: 0, maxMs: 0 },
    observedHeadDueLagMs: null,
    observedHeadObservationAgeMs: null,
  });
  f.runtime.start();
  await f.advance();
  assert.equal(f.s.claims, 0);
  assert.equal(f.s.probes, 1);
  await f.advance(999);
  assert.equal(f.s.probes, 1);
  await f.advance(1);
  assert.equal(f.s.probes, 2);
  assert.equal(f.s.claims, 0);
  f.put('private-org/device');
  f.s.queue[0].next_at -= 50;
  await f.advance(1000);
  assert.deepEqual(f.runtime.stats().claimedNextAtLag, { count: 1, totalMs: 1050, maxMs: 1050 });
  assert.ok(!JSON.stringify(f.runtime.stats()).includes('private-org'));
  assert.deepEqual(f.runtime.status(), { running: true, preparing: false, error: '' });
});
test('a synchronously throwing delivery callback releases its exact held slot and applies error cooldown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 1000000,
    claims = 0,
    stopped = false;
  const managed = createManagedPushDelivery({
    store: {
      peekManaged: (_now, blocked) =>
        blocked.excludeOrganizations.includes('org') ? null : { next_at: now },
      claimManaged: () => ({ next_at: now, device_id: 'd' + ++claims, organization_id: 'org' }),
    },
    clock: () => now,
    monotonic: () => 0,
    current: () => !stopped,
    active: () => !stopped,
    available: () => true,
    manualRunning: () => false,
    plan: () => {},
    deliver: () => {
      throw Error('synchronous adapter');
    },
    onError: () => {},
  });
  t.after(() => {
    stopped = true;
    managed.stop();
  });
  managed.start(1);
  t.mock.timers.tick(0);
  await flush();
  assert.equal(managed.active, 0);
  assert.equal(managed.stats().errors, 2);
  now += 14999;
  t.mock.timers.tick(14999);
  await flush();
  assert.equal(claims, 2);
});
test('a costly due probe cannot starve the fresh claim by forcing an endless re-probe/recovery cycle', async (t) => {
  const f = fixture(t);
  f.put('large-queue-head');
  f.s.peekHook = () => {
    f.s.mono += 40;
  };
  f.runtime.start();
  await f.advance();
  assert.equal(f.s.claims, 1);
  assert.equal(f.s.sent.length, 1);
  assert.ok(f.runtime.stats().syncWorkMs >= 40);
  assert.ok(f.runtime.stats().budgetYields >= 1);
});
test('existing resource snapshots expose exact managed aggregates with diagnostics on or off, without starting web-role senders', async (t) => {
  const { staffMaxFixture } = require('./helpers/staff-max-fixture.cjs');
  const { createMultiServer } = require('../multi-server.cjs');
  const f = await staffMaxFixture(t, { schema: 17 });
  for (const enabled of [false, true]) {
    const server = createMultiServer({
      dataDir: f.source,
      notificationSchema: 17,
      production: false,
      processRole: 'web',
      origin: '',
      sendMail: null,
      telegramBot: null,
      supportDelivery: {},
      metricsEnabled: enabled,
      metricsIntervalMs: 0,
      metricsEmit() {},
    });
    try {
      const resources = server.requestMetrics.snapshot().resources;
      assert.deepEqual(resources.pushDelivery, server.staffPushRuntime.stats());
      assert.deepEqual(resources.pushDelivery.claimedNextAtLag, { count: 0, totalMs: 0, maxMs: 0 });
      assert.equal(resources.pushDelivery.active, 0);
      assert.deepEqual(server.staffPushRuntime.status(), {
        running: false,
        preparing: false,
        error: '',
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    assert.doesNotThrow(
      () => server.staffPushRuntime.stats(),
      'stats must never touch closed storage',
    );
  }
});

test('a known Push ACK after stop commits its existing lease without starting another delivery', async (t) => {
  const f = fixture(t),
    gate = deferred();
  f.put('known-ack');
  f.put('not-started');
  f.s.send = () => gate.promise;
  f.s.claimCost = 20; // First real unit repays its budget before another starts.
  f.runtime.start();
  await f.advance();
  assert.equal(f.s.sent.length, 1);
  f.runtime.stop();
  gate.resolve();
  await flush();
  assert.deepEqual(
    f.s.finished.map((entry) => [entry.id, entry.status]),
    [['known-ack', 'sent']],
  );
  assert.equal(f.runtime.stats().active, 0);
  assert.equal(f.runtime.stats().stale, 0);
  await f.advance(60000);
  assert.equal(f.s.sent.length, 1);
});
