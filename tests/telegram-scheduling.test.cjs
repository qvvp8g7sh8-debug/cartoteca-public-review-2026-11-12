const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createTelegramRuntime,
} = require('../src/server/modules/notifications/telegram-runtime.cjs');

const turn = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(t, { scan, deliver } = {}) {
  let now = 100000,
    allowed = true,
    leaseThrows = false,
    deliveries = 0;
  const scans = [];
  const runtime = createTelegramRuntime({
    platform: {
      telegram: {
        acquirePollLease() {
          if (leaseThrows) throw Error('Synthetic lease failure');
          return true;
        },
        releasePollLease() {},
      },
    },
    tenantStore: () => assert.fail('This fixture exercises coordinator composition only'),
    clock: () => now,
    canRun: () => allowed,
    coordinator: {
      scheduleBatched(options) {
        const pending = deferred();
        scans.push({ ...pending, options });
        return scan ? scan(pending, scans.length) : pending.promise;
      },
      async tick(signal, canRun) {
        if (!signal?.aborted && canRun()) {
          deliveries++;
          if (deliver) await deliver();
        }
      },
    },
  });
  t.after(async () => {
    runtime.stop();
    for (const pending of scans) pending.resolve(false);
    await turn();
  });
  return {
    runtime,
    scans,
    deliveries: () => deliveries,
    advance: (ms) => {
      now += ms;
    },
    allow: (value) => {
      allowed = value;
    },
    failLease: () => {
      leaseThrows = true;
    },
  };
}

async function expectReadyTick(runtime) {
  const pending = runtime.tick();
  let finished = false;
  pending.then(() => {
    finished = true;
  });
  await turn();
  assert.equal(finished, true, 'ready deliveries must not wait for the full organization scan');
  await pending;
}

test('managed delivery progresses during a paused scan without overlapping scans or early rescheduling', async (t) => {
  const f = fixture(t);
  f.runtime.start();
  await expectReadyTick(f.runtime);
  assert.equal(f.scans.length, 1);
  assert.equal(f.deliveries(), 1);
  await expectReadyTick(f.runtime);
  assert.equal(f.scans.length, 1);
  assert.equal(f.deliveries(), 2);
  f.scans[0].resolve(true);
  await turn();
  f.advance(29999);
  await expectReadyTick(f.runtime);
  assert.equal(f.scans.length, 1);
  f.advance(1);
  await expectReadyTick(f.runtime);
  assert.equal(f.scans.length, 2);
  assert.equal(f.deliveries(), 4);
});

test('stopped scan cannot delay or overwrite a new generation and retains scan mutex until settled', async (t) => {
  for (const finish of ['resolve', 'reject']) {
    const f = fixture(t);
    f.runtime.start();
    await expectReadyTick(f.runtime);
    const old = f.scans[0];
    f.runtime.stop();
    assert.equal(old.options.canRun(), false);
    f.runtime.start();
    await expectReadyTick(f.runtime);
    assert.equal(f.scans.length, 1, 'old pass retains its mutex until it settles');
    assert.equal(f.deliveries(), 2, 'new generation may drain existing safe jobs');
    old[finish](finish === 'resolve' ? true : Error('Old synthetic scan'));
    await turn();
    assert.equal(f.runtime.status().error, '');
    await expectReadyTick(f.runtime);
    assert.equal(f.scans.length, 2, 'old completion cannot postpone the new scan');
    f.runtime.stop();
  }
});

test('background ownership loss blocks fresh work and aborted preparation does not impose a retry delay', async (t) => {
  const f = fixture(t);
  f.runtime.start();
  await expectReadyTick(f.runtime);
  f.allow(false);
  assert.equal(f.scans[0].options.canRun(), false);
  await f.runtime.tick();
  assert.equal(f.deliveries(), 1);
  f.scans[0].resolve(false);
  await turn();
  f.allow(true);
  await expectReadyTick(f.runtime);
  assert.equal(f.scans.length, 2);
  assert.equal(f.deliveries(), 2);
});

test('scan rejections and synchronous preparation errors are visible, bounded and do not block queued delivery', async (t) => {
  for (const synchronous of [false, true]) {
    const f = fixture(t, {
      scan(pending) {
        if (synchronous) throw Error('Synthetic scan failure');
        return pending.promise;
      },
    });
    f.runtime.start();
    await expectReadyTick(f.runtime);
    if (!synchronous) f.scans[0].reject(Error('Synthetic scan failure'));
    await turn();
    assert.equal(f.runtime.status().error, 'Не удалось подготовить очередь напоминаний.');
    await expectReadyTick(f.runtime);
    assert.equal(f.scans.length, 1, 'failing global scans cannot spin every delivery tick');
    assert.equal(f.deliveries(), 2);
    f.advance(30000);
    await expectReadyTick(f.runtime);
    assert.equal(f.scans.length, 2);
    f.runtime.stop();
  }
});

test('a lease exception at detached scan completion is handled without leaking rejection', async (t) => {
  const f = fixture(t);
  f.runtime.start();
  await expectReadyTick(f.runtime);
  f.advance(10001);
  f.failLease();
  f.scans[0].resolve(true);
  await turn();
  assert.equal(f.runtime.status().error, 'Не удалось подготовить очередь напоминаний.');
});

test('explicit unmanaged tick keeps the await-preparation then delivery contract', async (t) => {
  const f = fixture(t);
  let finished = false;
  const pending = f.runtime.tick().then(() => {
    finished = true;
  });
  await turn();
  assert.equal(finished, false);
  assert.equal(f.deliveries(), 0);
  f.scans[0].resolve(true);
  await pending;
  assert.equal(f.deliveries(), 1);
});

test('explicit unmanaged preparation failure still rejects its caller', async (t) => {
  const f = fixture(t, {
    scan: () => {
      throw Error('Synthetic one-shot failure');
    },
  });
  await assert.rejects(f.runtime.tick(), /Synthetic one-shot failure/);
  assert.equal(f.deliveries(), 0);
});

test('managed delivery ticks remain serialized while a provider is waiting', async (t) => {
  const sending = deferred();
  const f = fixture(t, { deliver: () => sending.promise });
  f.runtime.start();
  const first = f.runtime.tick();
  await turn();
  await f.runtime.tick();
  assert.equal(f.deliveries(), 1);
  assert.equal(f.scans.length, 1);
  sending.resolve();
  await first;
  await expectReadyTick(f.runtime);
  assert.equal(f.deliveries(), 2);
});
