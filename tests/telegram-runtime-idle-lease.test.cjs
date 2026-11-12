const test = require('node:test');
const assert = require('node:assert/strict');
const { createTelegramRuntime } = require('../src/server/modules/notifications/telegram-runtime.cjs');

const turn = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(t) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let now = 100000, allowed = true, lease = null, throwNext = false;
  const runtimes = [], acquisitions = [], releases = [];
  const registry = {
    acquire(owner, at) {
      acquisitions.push({ owner, at });
      if (throwNext) { throwNext = false; throw Error('Synthetic lease failure'); }
      if (lease && lease.owner !== owner && lease.until > at) return false;
      lease = { owner, until: at + 120000 };
      return true;
    },
    release(owner) {
      releases.push(owner);
      if (lease?.owner === owner) lease = null;
    },
  };
  function create({ ready = true, scan, drain, bot = false, coordinator = true } = {}) {
    const record = { checks: 0, commits: 0, scans: [], guards: [], polls: [], offsets: [], initializes: 0, tenantReads: 0 };
    let offset = 0;
    const telegram = {
      acquirePollLease: registry.acquire,
      releasePollLease: registry.release,
      offset(value) { if (value !== undefined) { offset = value; record.offsets.push(value); } return offset; },
    };
    const transport = bot ? {
      async initialize() { record.initializes++; return { username: 'Synthetic_bot', botId: 'synthetic' }; },
      updates(_offset, signal) {
        const pending = deferred(); record.polls.push({ ...pending, signal });
        signal.addEventListener('abort', () => pending.resolve([]), { once: true });
        return pending.promise;
      },
    } : null;
    const runtime = createTelegramRuntime({
      platform: { telegram }, bot: transport, clock: () => now, canRun: () => allowed,
      tenantStore() { record.tenantReads++; assert.fail('Lease-only fixture must never open clinical storage'); },
      coordinator: coordinator ? {
        scheduleBatched(options) {
          record.scans.push(options);
          return scan ? scan(options) : Promise.resolve(true);
        },
        async tick(signal, active) {
          record.guards.push(active);
          if (signal?.aborted || !active()) return;
          record.checks++;
          if (drain) await drain(signal, active);
          if (!signal?.aborted && active() && ready) record.commits++;
        },
      } : null,
    });
    const value = { runtime, record }; runtimes.push(value); return value;
  }
  t.after(async () => {
    for (const value of runtimes) value.runtime.stop();
    for (const value of runtimes) for (const pending of value.record.polls) pending.resolve([]);
    await turn();
    assert.ok(runtimes.every(value => value.record.tenantReads === 0));
  });
  return {
    create, acquisitions, releases,
    now: () => now, setClock(value) { now = value; }, allow(value) { allowed = value; },
    failNextLease() { throwNext = true; },
    async advance(ms, quantum = 250) {
      let remaining = ms;
      while (remaining > 0) {
        const step = Math.min(quantum, remaining); now += step; remaining -= step;
        t.mock.timers.tick(step); await turn();
      }
    },
  };
}

test('managed idle and ready250ms delivery ticks reuse bounded successful poll-lease proof without skipping checks', async t => {
  for (const ready of [false, true]) await t.test(ready ? 'ready work continues' : 'empty coordinator remains cheap', async sub => {
    const f = fixture(sub), value = f.create({ ready }); value.runtime.start();
    await f.advance(9750);
    assert.equal(value.record.checks, 39);
    assert.equal(value.record.commits, ready ? 39 : 0);
    assert.ok(f.acquisitions.length <= 2, 'Start coordination and39ticks must not perform40 durable renewals');
    await f.advance(20250);
    assert.equal(value.record.checks, 120);
    assert.equal(value.record.commits, ready ? 120 : 0);
    assert.ok(f.acquisitions.length <= 7, 'A30second interval allows bounded10second renewal, not one write per250ms tick');
  });
});

test('lease proof is renewed by its10second deadline and after a forward clock jump', async t => {
  const f = fixture(t), value = f.create(); value.runtime.start();
  await value.runtime.tick();
  const before = f.acquisitions.length;
  f.setClock(f.now() + 9999); await value.runtime.tick();
  assert.equal(f.acquisitions.length, before, 'Fresh successful proof should survive another tick');
  f.setClock(f.now() + 1); await value.runtime.tick();
  assert.equal(f.acquisitions.length, before + 1, 'At10seconds a successful fresh acquisition is required');
  f.setClock(f.now() + 60000); await value.runtime.tick();
  assert.equal(f.acquisitions.length, before + 2);
  assert.equal(value.record.commits, 4);
});

test('clock rollback invalidates the previously successful lease-age proof', async t => {
  const f = fixture(t), value = f.create(); value.runtime.start(); await value.runtime.tick();
  const before = f.acquisitions.length;
  f.setClock(f.now() - 1); await value.runtime.tick();
  assert.equal(f.acquisitions.length, before + 1, 'A future cached deadline cannot extend proof age across rollback');
  assert.equal(value.record.commits, 2);
});

test('current background permission is checked before each tick and again after an awaited provider boundary', async t => {
  const pending = deferred(), f = fixture(t), value = f.create({ drain: () => pending.promise });
  value.runtime.start(); const running = value.runtime.tick(); await turn();
  const before = f.acquisitions.length;
  f.allow(false); assert.equal(value.record.guards[0](), false);
  pending.resolve(); await running; await value.runtime.tick();
  assert.equal(value.record.commits, 0); assert.equal(f.acquisitions.length, before);
  assert.equal(value.record.checks, 1);
});

test('stop and restart require new ownership proof and old epoch continuations stay fenced', async t => {
  const pending = deferred(), f = fixture(t), value = f.create({ drain: () => pending.promise });
  value.runtime.start(); const running = value.runtime.tick(); await turn();
  const oldGuard = value.record.guards[0], before = f.acquisitions.length;
  value.runtime.stop(); assert.equal(oldGuard(), false);
  value.runtime.start(); assert.ok(f.acquisitions.length > before);
  assert.equal(oldGuard(), false, 'A new running epoch must not authorize old callbacks');
  pending.resolve(); await running;
  assert.equal(value.record.commits, 0);
  await value.runtime.tick(); assert.equal(value.record.commits, 1);
});

test('two runtime owners remain exclusive and an expired leader cannot continue after takeover', async t => {
  const f = fixture(t), first = f.create(), second = f.create();
  first.runtime.start(); second.runtime.start(); await first.runtime.tick(); await second.runtime.tick();
  assert.equal(first.record.commits, 1); assert.equal(second.record.commits, 0);
  const oldGuard = first.record.guards[0];
  f.setClock(f.now() + 120001); second.runtime.stop(); second.runtime.start();
  await second.runtime.tick(); assert.equal(second.record.commits, 1);
  assert.equal(oldGuard(), false, 'Expired proof must recheck the actual shared owner');
  await first.runtime.tick(); assert.equal(first.record.commits, 1);
});

test('a paused asynchronous schedule completion reproves expired lease freshness', async t => {
  const pending = deferred(), f = fixture(t), value = f.create({ scan: () => pending.promise });
  value.runtime.start(); await value.runtime.tick(); await turn();
  assert.equal(value.record.scans.length, 1);
  const before = f.acquisitions.length;
  f.setClock(f.now() + 10001); pending.resolve(true); await turn();
  assert.equal(f.acquisitions.length, before + 1, 'The detached completion may not reuse older-than10second proof');
  assert.equal(value.record.scans[0].canRun(), true);
});

test('lease acquisition failure blocks work until a new successful ownership check', async t => {
  const f = fixture(t), value = f.create(); value.runtime.start(); await value.runtime.tick();
  const commits = value.record.commits;
  f.setClock(f.now() + 10001); f.failNextLease();
  await assert.rejects(value.runtime.tick(), /Synthetic lease failure/u);
  assert.equal(value.record.commits, commits);
  await value.runtime.tick();
  assert.ok(value.record.commits >= commits, 'Recovery may remain stopped or resume only after another ownership check');
  if (value.record.commits > commits) assert.equal(f.acquisitions.at(-1).at, f.now());
});

test('long-poll response always checks actual shared ownership before applying an update', async t => {
  const f = fixture(t), first = f.create({ bot: true }), second = f.create({ bot: true });
  first.runtime.start(); await turn(); assert.equal(first.record.polls.length, 1);
  f.setClock(f.now() + 120001); second.runtime.start(); await turn();
  assert.equal(second.record.polls.length, 1);
  first.record.polls[0].resolve([{ update_id: 7 }]); await turn();
  assert.deepEqual(first.record.offsets, [], 'An old response cannot be committed after another runtime takes ownership');
  assert.equal(first.record.polls.length, 1);
});

test('poll failure and background revocation cannot use a cached lease to restart network polling', async t => {
  const f = fixture(t), value = f.create({ bot: true }); value.runtime.start(); await turn();
  assert.equal(value.record.polls.length, 1);
  value.record.polls[0].reject(Error('Synthetic poll failure')); await turn();
  assert.equal(value.runtime.status().connected, false);
  const initializes = value.record.initializes, checks = value.record.checks;
  f.allow(false); await f.advance(5000);
  assert.equal(value.record.initializes, initializes); assert.equal(value.record.polls.length, 1);
  assert.equal(value.record.checks, checks); assert.equal(value.record.commits, 0);
});

test('an explicit unmanaged one-shot tick keeps its await-scan contract without claiming the polling lease', async t => {
  const pending = deferred(), f = fixture(t), value = f.create({ scan: () => pending.promise });
  let finished = false; const running = value.runtime.tick().then(() => { finished = true; }); await turn();
  assert.equal(finished, false); assert.equal(value.record.commits, 0); assert.equal(f.acquisitions.length, 0);
  pending.resolve(true); await running;
  assert.equal(value.record.commits, 1); assert.equal(f.acquisitions.length, 0);
});

test('no bot and no coordinator creates no polling lease or clinical work', async t => {
  const f = fixture(t), value = f.create({ coordinator: false }); value.runtime.start();
  await f.advance(30000); await value.runtime.tick();
  assert.equal(f.acquisitions.length, 0); assert.equal(value.record.checks, 0); assert.equal(value.record.tenantReads, 0);
});

// Synthetic polling lifecycle coverage; no database, fetch, socket, or real timer is used.
function pollingRestartFixture(t, { ignoreAbort = false, initializeGate = null } = {}) {
  const { getEventListeners } = require('node:events');
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const originals = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  const timeouts = new Map(), intervals = new Set(), polls = [], identities = [], releases = [];
  let now = 100000, allowed = true, identity = 'Synthetic_before', offset = 0, tenantReads = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    let handle;
    handle = originals.setTimeout(() => { timeouts.delete(handle); callback(...args); }, ms);
    timeouts.set(handle, ms);
    return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', handle => {
    timeouts.delete(handle);
    return originals.clearTimeout(handle);
  });
  t.mock.method(globalThis, 'setInterval', (callback, ms, ...args) => {
    const handle = originals.setInterval(callback, ms, ...args);
    intervals.add(handle);
    return handle;
  });
  t.mock.method(globalThis, 'clearInterval', handle => {
    intervals.delete(handle);
    return originals.clearInterval(handle);
  });
  const bot = {
    async initialize(signal) {
      identities.push({ name: identity, signal });
      if (identities.length === 1 && initializeGate) return initializeGate.promise;
      return { username: identity, botId: identity };
    },
    updates(_offset, signal) {
      const pending = deferred(), value = { ...pending, signal };
      polls.push(value);
      const abort = () => pending.resolve([]);
      if (!ignoreAbort) signal.addEventListener('abort', abort, { once: true });
      const remove = () => signal.removeEventListener('abort', abort);
      return pending.promise.then(
        result => { remove(); return result; },
        failure => { remove(); throw failure; },
      );
    },
  };
  const runtime = createTelegramRuntime({
    platform: { telegram: {
      acquirePollLease: () => allowed,
      releasePollLease(owner) { releases.push(owner); },
      offset(value) { if (value !== undefined) offset = value; return offset; },
    } },
    tenantStore() { tenantReads++; assert.fail('Polling lifecycle must not read clinical storage'); },
    bot, clock: () => now, canRun: () => allowed,
    coordinator: { async scheduleBatched() { return true; }, async tick() {} },
  });
  const advance = async ms => {
    now += ms;
    t.mock.timers.tick(ms);
    await turn();
  };
  t.after(async () => {
    runtime.stop();
    initializeGate?.resolve({ username: 'Synthetic_cleanup', botId: 'Synthetic_cleanup' });
    for (const pending of polls) pending.resolve([]);
    await turn();
    assert.equal(tenantReads, 0);
    assert.equal(timeouts.size, 0, 'Stopped polling must release retry timers');
    assert.equal(intervals.size, 0, 'Stopped polling must release owned delivery/lease intervals');
    for (const pending of polls)
      assert.equal(getEventListeners(pending.signal, 'abort').length, 0, 'Settled polls must release abort listeners');
  });
  return {
    runtime, polls, identities, releases, timeouts, intervals, advance,
    allow(value) { allowed = value; },
    configure(value) { identity = value; },
    listeners(signal) { return getEventListeners(signal, 'abort').length; },
  };
}

test('poll network failure keeps the existing five-second retry delay and stop leaves no timer', async t => {
  const f = pollingRestartFixture(t);
  f.runtime.start(); await turn();
  assert.equal(f.polls.length, 1);
  f.polls[0].reject(Error('Synthetic network pause')); await turn();
  assert.deepEqual([...f.timeouts.values()], [5000]);
  await f.advance(4999);
  assert.equal(f.polls.length, 1, 'A transient network error must retain the five-second pacing');
  await f.advance(1);
  assert.equal(f.polls.length, 2, 'A current allowed leader retries when the existing delay expires');
  f.runtime.stop(); await turn();
  assert.equal(f.timeouts.size, 0); assert.equal(f.intervals.size, 0);
});

test('stop during poll backoff releases the waiting continuation and never retries while stopped', async t => {
  const f = pollingRestartFixture(t);
  f.runtime.start(); await turn();
  f.polls[0].reject(Error('Synthetic network pause')); await turn();
  assert.equal(f.timeouts.size, 1);
  const signal = f.polls[0].signal;
  f.runtime.stop(); await turn();
  assert.equal(signal.aborted, true);
  assert.equal(f.timeouts.size, 0);
  assert.equal(f.intervals.size, 0);
  assert.equal(f.listeners(signal), 0, 'The cancelled retry continuation must remove its abort listener');
  const before = { polls: f.polls.length, initialize: f.identities.length };
  await f.advance(30000);
  assert.deepEqual({ polls: f.polls.length, initialize: f.identities.length }, before);
});

test('immediate restart during backoff polls with the newly configured bot identity without waiting five seconds', async t => {
  const f = pollingRestartFixture(t);
  f.runtime.start(); await turn();
  f.polls[0].reject(Error('Synthetic network pause')); await turn();
  const old = f.polls[0].signal;
  f.runtime.stop();
  f.configure('Synthetic_after');
  f.runtime.start(); await turn();
  assert.equal(f.polls.length, 2, 'Same-instance restart must not remain latched behind a cancelled retry');
  assert.notEqual(f.polls[1].signal, old);
  assert.equal(old.aborted, true);
  assert.equal(f.polls[1].signal.aborted, false);
  assert.equal(f.runtime.status().username, 'Synthetic_after');
  assert.equal(f.timeouts.size, 0, 'Restart may not retain the cancelled five-second timer');
  assert.equal(f.intervals.size, 2, 'Exactly the existing lease and delivery intervals are owned');
  await f.advance(10000);
  assert.equal(f.polls.length, 2, 'Late completion of the cancelled backoff must not permit a duplicate current poll');
});

test('late old long-poll settlement cannot clear a newer polling owner or apply its updates', async t => {
  const f = pollingRestartFixture(t, { ignoreAbort: true });
  f.runtime.start(); await turn();
  const old = f.polls[0];
  f.runtime.stop(); f.runtime.start(); await turn();
  assert.equal(f.polls.length, 2, 'An aborted provider which settles late must not prevent a fresh lifecycle');
  const current = f.polls[1];
  old.resolve([{ update_id: 77 }]); await turn();
  assert.equal(current.signal.aborted, false);
  await f.advance(10000);
  assert.equal(f.polls.length, 2, 'Old finally must not reset the current polling flag');
  f.runtime.stop(); current.resolve([]); await turn();
  await f.advance(30000);
  assert.equal(f.polls.length, 2, 'A final stop must leave neither old nor current provider retry active');
});

test('current permission denial after a network pause remains authoritative across stop and restart', async t => {
  const f = pollingRestartFixture(t);
  f.runtime.start(); await turn();
  f.polls[0].reject(Error('Synthetic network pause')); await turn();
  f.allow(false); f.runtime.stop(); f.runtime.start(); await turn();
  await f.advance(30000);
  assert.equal(f.polls.length, 1, 'A restarted but unauthorized worker must not contact the polling provider');
  f.runtime.stop(); f.allow(true); f.runtime.start(); await turn();
  assert.equal(f.polls.length, 2, 'Restored permission still requires a fresh owned poll');
  assert.equal(f.polls[0].signal.aborted, true);
});

test('repeated network-pause stop/start cycles keep one poll per lifecycle and no stopped callbacks', async t => {
  const f = pollingRestartFixture(t);
  for (let cycle = 0; cycle < 3; cycle++) {
    f.configure('Synthetic_cycle_' + cycle);
    f.runtime.start(); await turn();
    assert.equal(f.polls.length, cycle + 1);
    assert.equal(f.runtime.status().username, 'Synthetic_cycle_' + cycle);
    f.polls[cycle].reject(Error('Synthetic network pause')); await turn();
    assert.equal(f.timeouts.size, 1);
    f.runtime.stop(); await turn();
    assert.equal(f.timeouts.size, 0);
    assert.equal(f.intervals.size, 0);
    await f.advance(10000);
    assert.equal(f.polls.length, cycle + 1);
  }
});

test('aborted old initialization cannot replace the restarted bot identity or connection status', async t => {
  for (const outcome of ['success', 'failure']) await t.test(outcome, async sub => {
    const old = deferred(), f = pollingRestartFixture(sub, { initializeGate: old });
    f.runtime.start(); await turn();
    assert.equal(f.identities.length, 1);
    assert.equal(f.polls.length, 0);
    const oldSignal = f.identities[0].signal;
    f.runtime.stop(); f.configure('Synthetic_after_restart'); f.runtime.start(); await turn();
    assert.equal(oldSignal.aborted, true);
    assert.equal(f.polls.length, 1, 'The new lifecycle must not wait for an old initialization');
    assert.equal(f.runtime.status().username, 'Synthetic_after_restart');
    if (outcome === 'success') old.resolve({ username: 'Synthetic_stale', botId: 'Synthetic_stale' });
    else old.reject(Object.assign(Error('Synthetic late failure'), { status: 503 }));
    await turn();
    assert.equal(f.runtime.status().username, 'Synthetic_after_restart');
    assert.equal(f.runtime.status().botId, 'Synthetic_after_restart');
    assert.equal(f.runtime.status().connected, true);
    assert.equal(f.runtime.status().error, '');
    await f.advance(10000);
    assert.equal(f.polls.length, 1, 'Old initialization completion must not clear the new polling owner');
  });
});

function followerInitializationFixture(t) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const gate = deferred(), identities = [], polls = [];
  let mayLead = false, identity = 'Synthetic_follower_before', tenantReads = 0;
  const runtime = createTelegramRuntime({
    platform: { telegram: {
      acquirePollLease: () => mayLead,
      releasePollLease() {},
      offset: () => 0,
    } },
    tenantStore() { tenantReads++; assert.fail('Follower initialization must not read clinical data'); },
    clock: () => 100000,
    canRun: () => true,
    coordinator: { async scheduleBatched() { return true; }, async tick() {} },
    bot: {
      async initialize(signal) {
        identities.push({ signal, name: identity });
        if (identities.length === 1) return gate.promise;
        return { username: identity, botId: identity };
      },
      updates(_offset, signal) {
        const pending = deferred();
        const abort = () => pending.resolve([]);
        signal.addEventListener('abort', abort, { once: true });
        polls.push({ ...pending, signal });
        return pending.promise.then(
          value => { signal.removeEventListener('abort', abort); return value; },
          failure => { signal.removeEventListener('abort', abort); throw failure; },
        );
      },
    },
  });
  t.after(async () => {
    runtime.stop();
    gate.resolve({ username: 'Synthetic_cleanup', botId: 'Synthetic_cleanup' });
    for (const poll of polls) poll.resolve([]);
    await turn();
    assert.equal(tenantReads, 0);
  });
  return {
    runtime, gate, identities, polls,
    becomeLeader(name) { mayLead = true; identity = name; },
    async advance(ms) { t.mock.timers.tick(ms); await turn(); },
  };
}

test('signal-less follower initialization cannot overwrite the identity of a restarted leader', async t => {
  for (const outcome of ['success', 'failure']) await t.test(outcome, async sub => {
    const f = followerInitializationFixture(sub);
    f.runtime.start(); await turn();
    assert.equal(f.identities.length, 1);
    assert.equal(f.identities[0].signal, undefined, 'Lease-denied follower identity uses the existing signal-less path');
    assert.equal(f.polls.length, 0);
    f.runtime.stop();
    f.becomeLeader('Synthetic_new_leader'); f.runtime.start(); await turn();
    assert.equal(f.polls.length, 1);
    assert.equal(f.runtime.status().username, 'Synthetic_new_leader');
    if (outcome === 'success') f.gate.resolve({ username: 'Synthetic_stale_follower', botId: 'Synthetic_stale_follower' });
    else f.gate.reject(Object.assign(Error('Synthetic stale follower failure'), { status: 503 }));
    await turn();
    assert.equal(f.runtime.status().username, 'Synthetic_new_leader');
    assert.equal(f.runtime.status().botId, 'Synthetic_new_leader');
    assert.equal(f.runtime.status().connected, true);
    assert.equal(f.runtime.status().error, '');
    await f.advance(10000);
    assert.equal(f.polls.length, 1);
    f.runtime.stop(); await turn();
    await f.advance(30000);
    assert.equal(f.polls.length, 1, 'Stopped generations may not create another provider poll');
    assert.equal(f.identities.length, 2, 'A stopped follower may not schedule another initialization');
  });
});
