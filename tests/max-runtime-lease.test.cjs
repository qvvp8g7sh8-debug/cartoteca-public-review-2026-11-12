const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createMaxRuntimeLease,
} = require('../src/server/modules/notifications/max-runtime-lease.cjs');
const { createMaxRuntime } = require('../src/server/modules/notifications/max-runtime.cjs');

const turn = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}
function fixture() {
  let wall = 1000000,
    monotonic = 1000,
    current = null,
    open = true;
  let acquisition = null,
    renewal = null,
    reading = null;
  const calls = { acquire: [], renew: [], read: [], release: [] };
  const inbox = {
    durationMs: 30000,
    isOpen: () => open,
    acquire(bot, owner, now) {
      calls.acquire.push({ bot, owner, now });
      if (acquisition) return acquisition(bot, owner, now);
      if (current && current.owner !== owner && current.until > now) return false;
      current = { bot, owner, until: now + 30000 };
      return true;
    },
    renew(bot, owner, until, now) {
      calls.renew.push({ bot, owner, until, now });
      if (renewal) return renewal(bot, owner, until, now);
      if (
        !current ||
        current.bot !== bot ||
        current.owner !== owner ||
        current.until !== until ||
        until <= now
      )
        return false;
      current = { bot, owner, until: now + 30000 };
      return true;
    },
    isCurrent(bot, owner, until, now) {
      calls.read.push({ bot, owner, until, now });
      if (reading) return reading(bot, owner, until, now);
      return Boolean(
        open &&
        current &&
        current.bot === bot &&
        current.owner === owner &&
        current.until === until &&
        until > now,
      );
    },
    release(bot, owner) {
      calls.release.push({ bot, owner });
      if (current?.bot === bot && current.owner === owner) current = null;
    },
  };
  const clock = () => wall,
    monotonicClock = () => monotonic;
  return {
    inbox,
    calls,
    clock,
    monotonicClock,
    lease: (owner = 'synthetic-owner') =>
      createMaxRuntimeLease({ inbox, botId: '123', owner, clock, monotonicClock }),
    advance(ms) {
      wall += ms;
      monotonic += ms;
    },
    setWall(value) {
      wall = value;
    },
    setMonotonic(value) {
      monotonic = value;
    },
    close() {
      open = false;
    },
    onAcquire(value) {
      acquisition = value;
    },
    onRenew(value) {
      renewal = value;
    },
    onRead(value) {
      reading = value;
    },
    row: () => current,
  };
}
const busy = () =>
  Object.assign(Error('Synthetic admission busy'), {
    code: 'ERR_SQLITE_ERROR',
    errcode: 5,
    postgres: true,
    postgresCode: 'POSTGRES_BUSY',
    retryableBeforeBegin: true,
    transactionOpen: false,
    channelPoisoned: false,
    outcomeUnknown: false,
  });

test('MAX cancellation predicates are pure and successful proof renews once per ten seconds', () => {
  const f = fixture(),
    lease = f.lease(),
    guard = lease.ensure();
  assert.equal(typeof guard, 'function');
  for (let i = 0; i < 1000; i++) assert.equal(guard(), true);
  assert.equal(f.calls.acquire.length, 1);
  assert.equal(f.calls.renew.length, 0);
  assert.equal(f.calls.read.length, 0, 'Pure cancellation must not enter SQL');
  f.advance(9999);
  assert.equal(typeof lease.ensure(), 'function');
  assert.equal(f.calls.renew.length, 0);
  f.advance(1);
  const renewed = lease.ensure();
  assert.equal(typeof renewed, 'function');
  assert.deepEqual(f.calls.renew, [
    { bot: '123', owner: 'synthetic-owner', until: 1030000, now: 1010000 },
  ]);
  assert.equal(f.row().until, 1040000);
  assert.equal(renewed.verify(), true);
  assert.equal(f.calls.read.length, 1);
  assert.equal(f.calls.acquire.length, 1, 'Renewal must not reacquire or resurrect its owner');
  f.advance(20000);
  assert.equal(
    guard(),
    true,
    'An earlier continuation may use a successfully renewed proof in the same authority epoch',
  );
});

test('a pure MAX guard expires at the confirmed deadline without requiring another tick', () => {
  const f = fixture(),
    guard = f.lease().ensure();
  f.advance(29999);
  assert.equal(guard(), true);
  f.advance(1);
  assert.equal(guard(), false);
  assert.equal(guard.verify(), false);
  assert.equal(f.calls.acquire.length, 1);
  assert.equal(f.calls.renew.length, 0);
  assert.equal(f.calls.read.length, 0);
});

for (const axis of ['wall', 'monotonic']) {
  for (const value of ['rollback', NaN, Infinity]) {
    test(`MAX ${axis} ${String(value)} invalidates cached ownership without SQL`, () => {
      const f = fixture(),
        lease = f.lease(),
        guard = lease.ensure();
      if (axis === 'wall') f.setWall(value === 'rollback' ? f.clock() - 1 : value);
      else f.setMonotonic(value === 'rollback' ? f.monotonicClock() - 1 : value);
      assert.equal(guard(), false);
      assert.equal(guard.verify(), false);
      assert.equal(f.calls.acquire.length, 1);
      assert.equal(f.calls.renew.length, 0);
      assert.equal(f.calls.read.length, 0);
      f.setWall(1000000);
      f.setMonotonic(1000);
      assert.equal(lease.ensure(), null, 'Resetting clocks cannot resurrect a poisoned proof');
      assert.equal(f.calls.acquire.length, 1);
    });
  }
}

test('slow successful acquisition cannot start a new local thirty-second lifetime on return', () => {
  const f = fixture();
  f.onAcquire(() => {
    f.advance(30000);
    return true;
  });
  assert.equal(f.lease().ensure(), null);
  assert.equal(f.calls.acquire.length, 1);
  assert.equal(f.calls.read.length, 0);
});

test('strict clean pre-BEGIN busy retains the original proof and retries only after one second', () => {
  const f = fixture(),
    lease = f.lease(),
    guard = lease.ensure();
  f.onRenew(() => {
    throw busy();
  });
  f.advance(10000);
  assert.equal(typeof lease.ensure(), 'function');
  assert.equal(guard(), true);
  for (let i = 0; i < 100; i++) lease.ensure();
  assert.equal(f.calls.renew.length, 1);
  f.advance(999);
  lease.ensure();
  assert.equal(f.calls.renew.length, 1);
  f.advance(1);
  lease.ensure();
  assert.equal(f.calls.renew.length, 2);
  assert.equal(f.row().until, 1030000, 'A failed renewal cannot extend durable expiry');
  f.advance(19000);
  assert.equal(guard(), false);
  assert.equal(f.calls.acquire.length, 1);
});

for (const flags of [
  { outcomeUnknown: true },
  { channelPoisoned: true },
  { transactionOpen: true },
  { retryableBeforeBegin: false },
  { code: 'POSTGRES_ROLE_AUTHORITY_BUSY' },
]) {
  test(`ambiguous MAX renewal fails closed: ${Object.keys(flags)[0]}=${Object.values(flags)[0]}`, () => {
    const f = fixture(),
      lease = f.lease(),
      guard = lease.ensure();
    f.onRenew(() => {
      throw Object.assign(busy(), flags);
    });
    f.advance(10000);
    assert.throws(() => lease.ensure(), /Synthetic admission busy/u);
    assert.equal(guard(), false);
    f.onRenew(null);
    f.advance(1000);
    assert.equal(lease.ensure(), null);
    assert.equal(f.calls.acquire.length, 1);
    assert.equal(
      f.calls.renew.length,
      1,
      'A poisoned authority cannot silently recover in the same lifecycle',
    );
  });
}

test('release invalidates captured MAX guards before SQL and a new epoch cannot authorize them', () => {
  const f = fixture(),
    lease = f.lease(),
    oldGuard = lease.ensure();
  const release = f.inbox.release;
  f.inbox.release = (...args) => {
    assert.equal(oldGuard(), false);
    release(...args);
  };
  lease.release();
  lease.release();
  assert.equal(f.calls.release.length, 1);
  const fresh = lease.ensure();
  assert.equal(typeof fresh, 'function');
  assert.equal(fresh(), true);
  assert.equal(oldGuard(), false);
});

test('two MAX owners exclude one another and a stale read or renewal never resurrects the previous owner', () => {
  const f = fixture(),
    first = f.lease('first'),
    second = f.lease('second');
  const oldGuard = first.ensure();
  assert.equal(second.ensure(), null);
  f.advance(30001);
  assert.equal(typeof second.ensure(), 'function');
  assert.equal(oldGuard(), false);
  assert.equal(oldGuard.verify(), false);
  assert.equal(f.inbox.renew('123', 'first', 1030000, f.clock()), false);
  assert.equal(f.row().owner, 'second');
});

test('the final MAX ownership read rejects replacement and a closed or unknown database', () => {
  for (const failure of ['takeover', 'closed', 'unknown']) {
    const f = fixture(),
      guard = f.lease().ensure();
    if (failure === 'takeover') f.onRead(() => false);
    if (failure === 'closed') f.close();
    if (failure === 'unknown')
      f.onRead(() => {
        throw Object.assign(Error('Synthetic read uncertainty'), { outcomeUnknown: true });
      });
    if (failure === 'unknown') assert.throws(() => guard.verify(), /Synthetic read uncertainty/u);
    else assert.equal(guard.verify(), false, failure);
    assert.equal(guard(), false, failure);
    assert.equal(f.calls.acquire.length, 1);
    assert.equal(f.calls.renew.length, 0);
  }
});

function runtimeFixture(t, { count = 0, pacing, answer, staffDelivery } = {}) {
  const f = fixture(),
    rows = [],
    finished = [],
    claims = [];
  for (let i = 0; i < count; i++)
    rows.push({
      id: 'synthetic-' + i,
      lease_id: 'synthetic-lease-' + i,
      status: 'pending',
      decoded: {
        result: { callbackId: 'synthetic-callback-' + i },
        event: { callback: { user: { user_id: '456' } } },
      },
    });
  Object.assign(f.inbox, {
    claim() {
      const row = rows.find((value) => value.status === 'pending');
      claims.push(row?.id || 'empty');
      if (row) row.status = 'processing';
      return row;
    },
    finish(row, status) {
      if (row.status !== 'processing') return false;
      row.status = status;
      finished.push({ id: row.id, status });
      return true;
    },
    defer(row) {
      if (row.status !== 'processing') return false;
      row.status = 'pending';
      return true;
    },
  });
  const runtime = createMaxRuntime({
    inbox: f.inbox,
    events: {},
    identity: { botId: '123' },
    bot: { answer: answer || (async () => {}) },
    clock: f.clock,
    monotonicClock: f.monotonicClock,
    pacing: pacing || { acquire: async () => true, pause() {} },
    staffDelivery,
  });
  t.after(() => runtime.stop());
  return { ...f, runtime, rows, finished, claims };
}

test('managed MAX idle cycles and dense staff guards reuse one confirmed lease instead of repeatedly writing', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const guards = [];
  let staffTicks = 0;
  const f = runtimeFixture(t, {
    count: 12,
    staffDelivery: {
      async tick(_signal, canSend) {
        staffTicks++;
        guards.push(canSend);
        for (let i = 0; i < 1000; i++) assert.equal(canSend(), true);
      },
    },
  });
  f.runtime.start();
  await turn();
  assert.equal(f.finished.length, 12);
  for (let i = 0; i < 19; i++) {
    f.advance(500);
    t.mock.timers.tick(500);
    await turn();
  }
  assert.equal(
    staffTicks,
    20,
    'Empty polling and ready batches continue at their original cadence',
  );
  assert.equal(f.calls.acquire.length, 1);
  assert.equal(f.calls.renew.length, 0);
  const writes = f.calls.acquire.length + f.calls.renew.length;
  for (const canSend of guards) for (let i = 0; i < 50; i++) assert.equal(canSend(), true);
  assert.equal(f.calls.acquire.length + f.calls.renew.length, writes);
  f.runtime.stop();
  assert.ok(guards.every((canSend) => !canSend()));
});

test('a MAX pacing continuation cannot start a callback after expiry and takeover', async (t) => {
  const waiting = deferred(),
    entered = deferred();
  t.after(() => waiting.resolve(true));
  let answers = 0;
  const f = runtimeFixture(t, {
    count: 1,
    pacing: {
      acquire: async () => {
        entered.resolve();
        return waiting.promise;
      },
      pause() {},
    },
    answer: async () => answers++,
  });
  const running = f.runtime.tick();
  await entered.promise;
  f.advance(30001);
  assert.equal(f.inbox.acquire('123', 'synthetic-rival', f.clock()), true);
  waiting.resolve(true);
  await running;
  assert.equal(answers, 0);
  assert.equal(f.finished.length, 0);
  assert.equal(f.row().owner, 'synthetic-rival');
});

test('a known MAX callback ACK settles its original attempt after stop without claiming another event', async (t) => {
  const pending = deferred(),
    entered = deferred();
  t.after(() => pending.resolve());
  let answers = 0;
  const f = runtimeFixture(t, {
    count: 2,
    answer: async () => {
      answers++;
      entered.resolve();
      await pending.promise;
    },
  });
  const running = f.runtime.tick();
  await entered.promise;
  f.runtime.stop();
  pending.resolve();
  await running;
  assert.equal(answers, 1);
  assert.deepEqual(f.finished, [{ id: 'synthetic-0', status: 'done' }]);
  assert.equal(f.rows[1].status, 'pending');
  assert.equal(f.claims.length, 1);
  assert.equal(f.calls.release.length, 1);
});

test('a MAX proof that expires during its final ownership read cannot authorize provider start', () => {
  const f = fixture(),
    guard = f.lease().ensure();
  f.onRead(() => {
    f.advance(30000);
    return true;
  });
  assert.equal(guard.verify(), false);
  assert.equal(guard(), false);
  assert.equal(f.calls.read.length, 1);
  assert.equal(f.calls.acquire.length, 1);
  assert.equal(f.calls.renew.length, 0);
});

test('a lost MAX renewal invalidates earlier guards and cannot fall back to acquire in that turn', () => {
  const f = fixture(),
    lease = f.lease(),
    guard = lease.ensure();
  f.onRenew(() => false);
  f.advance(10000);
  assert.equal(lease.ensure(), null);
  assert.equal(guard(), false);
  assert.equal(guard.verify(), false);
  assert.equal(f.calls.acquire.length, 1);
  assert.equal(f.calls.renew.length, 1);
});

test('unknown MAX acquisition remains denied after release instead of repeating an uncertain write', () => {
  const f = fixture(),
    lease = f.lease();
  f.onAcquire(() => {
    throw Object.assign(Error('Synthetic unknown commit'), { outcomeUnknown: true });
  });
  assert.throws(() => lease.ensure(), /Synthetic unknown commit/u);
  f.onAcquire(null);
  lease.release();
  assert.equal(lease.ensure(), null);
  assert.equal(f.calls.acquire.length, 1);
});
