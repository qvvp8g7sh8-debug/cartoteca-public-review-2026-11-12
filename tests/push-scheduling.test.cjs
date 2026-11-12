const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createPushRuntime } = require('../src/server/modules/notifications/push-runtime.cjs');
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
    endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-scheduling',
    keys: {
      p256dh: key.getPublicKey().toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url'),
    },
  };
  const state = {
    now: Date.now(),
    active: true,
    pages: [],
    scans: 0,
    claims: 0,
    probes: 0,
    queue: [],
    sent: [],
    finished: [],
    scanError: null,
  };
  const gate = deferred();
  state.yield = () => gate.promise;
  state.send = async () => {};
  const store = {
    organizationPage(cursor) {
      if (state.scanError) throw state.scanError;
      if (!cursor) state.scans++;
      state.pages.push(cursor);
      return { organizations: ['synthetic-org'], cursor: cursor ? '' : 'next' };
    },
    allowed: () => false,
    claim() {
      state.claims++;
      return state.queue.shift() || null;
    },
    peekManaged(_now, blocked) {
      state.probes++;
      return (
        state.queue.find(
          (job) =>
            !blocked.excludeDevices.includes(job.device_id) &&
            !blocked.excludeOrganizations.includes(job.organization_id),
        ) || null
      );
    },
    claimManaged(_now, blocked) {
      state.claims++;
      const index = state.queue.findIndex(
        (job) =>
          !blocked.excludeDevices.includes(job.device_id) &&
          !blocked.excludeOrganizations.includes(job.organization_id),
      );
      return index < 0 ? null : state.queue.splice(index, 1)[0];
    },
    valid: () => ({ decoded: { subscription: sub } }),
    finish(job, status) {
      state.finished.push([job.id, status]);
    },
    keys: () => ({ publicKey: 'synthetic', privateKey: 'synthetic' }),
  };
  const runtime = createPushRuntime({
    platform: { staffPush: store },
    tenantStore: () => assert.fail('Test jobs do not read clinical data'),
    origin: 'https://synthetic.test',
    enabled: true,
    clock: () => state.now,
    monotonic: () => 0,
    canRun: () => state.active,
    yieldTurn: () => state.yield(),
    send: async (_, payload) => {
      state.sent.push(JSON.parse(payload));
      await state.send();
    },
  });
  const queue = (n) => {
    for (let i = 0; i < n; i++) {
      const serial = state.queue.length;
      state.queue.push({
        id: 'job-' + state.queue.length + '-' + state.now,
        organization_id: 'synthetic-org-' + Math.floor(serial / 2),
        device_id: 'synthetic-device-' + serial,
        next_at: state.now,
        event_key: 'synthetic-' + i,
        expires_at: state.now + 3600000,
        decoded: { event: 'test', reference: {} },
        attempts: 1,
      });
    }
  };
  const advance = async () => {
    state.now += 15000;
    t.mock.timers.tick(15000);
    await flush();
  };
  t.after(() => {
    runtime.stop();
    gate.resolve();
  });
  return { runtime, state, gate, queue, advance, store };
}

test('managed Push delivers ready jobs before a paused full scan, without overlapping batches', async (t) => {
  const f = fixture(t);
  f.queue(25);
  f.runtime.start();
  await f.advance();
  assert.equal(f.state.sent.length, 4);
  assert.equal(f.state.scans, 1);
  assert.deepEqual(f.state.pages, ['']);
  await f.advance();
  assert.equal(f.state.sent.length, 8);
  assert.equal(f.state.scans, 1);
  f.gate.resolve();
  await flush();
  assert.deepEqual(f.state.pages, ['', 'next']);
  await f.advance();
  assert.equal(f.state.sent.length, 12);
  assert.equal(f.state.scans, 2);
});

test('ready Push uses bounded cooperative turns and empty managed queues use cheap1second probes', async (t) => {
  const f = fixture(t);
  f.queue(25);
  f.runtime.start();
  await f.advance();
  assert.equal(f.state.sent.length, 4);
  const advance = async (ms) => {
    f.state.now += ms;
    t.mock.timers.tick(ms);
    await flush();
  };
  await advance(1);
  assert.equal(f.state.sent.length, 8);
  for (let i = 0; i < 5; i++) await advance(1);
  assert.equal(f.state.sent.length, 25);
  await advance(1); // Observe the now-empty queue once after the last settlement.
  const claims = f.state.claims;
  const probes = f.state.probes;
  await advance(999);
  assert.equal(f.state.claims, claims);
  await advance(1);
  assert.equal(f.state.claims, claims, 'idle must not invoke broad legacy claim cleanup');
  assert.equal(f.state.probes, probes + 1);
});

test('Push429 preserves queued retry deadline and suppresses accelerated draining', async (t) => {
  const f = fixture(t);
  f.queue(10);
  f.runtime.start();
  f.state.send = async () => {
    throw { statusCode: 429, headers: { 'retry-after': '120' } };
  };
  const pending = [];
  f.store.finish = (job, status, nextAt) => {
    f.state.finished.push([job.id, status]);
    if (status === 'pending') pending.push({ job, nextAt });
  };
  await f.advance();
  assert.equal(f.state.sent.length, 4);
  assert.ok(pending.every((row) => row.nextAt === f.state.now + 120000));
  const claims = f.state.claims;
  f.state.now += 1000;
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(f.state.claims, claims, 'throttled batch must not use1second drain');
  await f.advance();
  assert.equal(
    f.state.sent.length,
    8,
    'fresh due jobs may proceed after cooldown while future retries stay deferred',
  );
  assert.equal(pending.length, 8);
});

test('stop cancels the fast drain and a lost process lease prevents its next claim', async (t) => {
  const f = fixture(t);
  f.queue(30);
  f.runtime.start();
  await f.advance();
  f.state.active = false;
  const claims = f.state.claims;
  f.state.now += 1000;
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(f.state.claims, claims);
  f.runtime.stop();
  f.state.active = true;
  await f.advance();
  assert.equal(f.state.claims, claims);
  f.runtime.start();
  await f.advance();
  assert.equal(f.state.sent.length, 8);
});

test('explicit Push tick retains preparation-before-delivery and rejects scan errors', async (t) => {
  const f = fixture(t);
  f.queue(1);
  f.runtime.start();
  const tick = f.runtime.tick();
  await flush();
  assert.equal(f.state.claims, 0);
  f.gate.resolve();
  await tick;
  assert.equal(f.state.sent.length, 1);
  f.state.scanError = Error('synthetic schedule failure');
  await assert.rejects(f.runtime.tick(), /synthetic schedule failure/);
  assert.match(f.runtime.status().error, /подготовить/);
});

test('stop/restart fences an old scan and stale rejection without blocking new delivery', async (t) => {
  const f = fixture(t);
  f.runtime.start();
  await f.advance();
  f.runtime.stop();
  f.runtime.start();
  f.queue(1);
  await f.advance();
  assert.equal(f.state.sent.length, 1);
  assert.equal(f.state.scans, 1);
  f.gate.reject(Error('old epoch'));
  await flush();
  assert.equal(f.runtime.status().error, '');
  f.state.yield = async () => {};
  await f.advance();
  assert.equal(f.state.scans, 2);
  assert.deepEqual(f.state.pages, ['', '', 'next']);
});

test('lease loss stops the resumed scan and next delivery claim', async (t) => {
  const f = fixture(t);
  f.runtime.start();
  await f.advance();
  const claims = f.state.claims;
  f.state.active = false;
  f.queue(1);
  f.gate.resolve();
  await flush();
  await f.advance();
  assert.deepEqual(f.state.pages, ['']);
  assert.equal(f.state.claims, claims);
  assert.equal(f.state.sent.length, 0);
});

test('managed scan error remains observable while ready jobs deliver, and scan retry waits15seconds', async (t) => {
  const f = fixture(t);
  f.state.scanError = Error('synthetic failure');
  f.queue(1);
  f.runtime.start();
  await f.advance();
  assert.equal(f.state.sent.length, 1);
  assert.match(f.runtime.status().error, /подготовить/);
  f.state.scanError = null;
  f.state.yield = async () => {};
  await f.advance();
  assert.equal(f.state.scans, 1);
  assert.equal(f.runtime.status().error, '');
});

test('stop/start retains actual send slots and records a known lease ACK without overlapping delivery', async (t) => {
  const f = fixture(t),
    provider = deferred();
  f.queue(2);
  f.state.queue[1].device_id = f.state.queue[0].device_id;
  f.state.send = () => provider.promise;
  f.runtime.start();
  await f.advance();
  assert.equal(f.state.sent.length, 1);
  f.runtime.stop();
  f.runtime.start();
  await f.advance();
  assert.equal(f.state.sent.length, 1);
  provider.resolve();
  await flush();
  assert.equal(f.state.finished.length, 1);
  await f.advance();
  assert.equal(f.state.sent.length, 2);
  assert.equal(f.state.finished.length, 2);
});
