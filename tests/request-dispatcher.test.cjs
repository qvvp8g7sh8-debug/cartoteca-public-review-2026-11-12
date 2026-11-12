const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { performance } = require('node:perf_hooks');
const { setImmediate: immediate } = require('node:timers/promises');
const { createRequestDispatcher } = require('../src/server/infrastructure/request-dispatcher.cjs');
const { createAsyncWriteLock } = require('../src/server/infrastructure/async-write-lock.cjs');

function fixture(options = {}) {
  let clock = 0,
    sequence = 0;
  const scheduled = new Map();
  const dispatcher = createRequestDispatcher({
    now: () => clock,
    schedule: (callback) => {
      const id = ++sequence;
      scheduled.set(id, callback);
      return id;
    },
    cancelScheduled: (id) => scheduled.delete(id),
    ...options,
  });
  return {
    dispatcher,
    scheduled,
    advance: (ms) => {
      clock += ms;
    },
    step() {
      const next = scheduled.entries().next().value;
      assert.ok(next, 'one queued dispatcher turn exists');
      scheduled.delete(next[0]);
      next[1]();
    },
  };
}

test('request starts use one deferred FIFO and at most eight starts per turn', async () => {
  const f = fixture(),
    order = [];
  const jobs = Array.from({ length: 20 }, (_, index) =>
    f.dispatcher.run(() => {
      order.push(index);
      return index;
    }),
  );
  assert.deepEqual(order, []);
  assert.equal(f.scheduled.size, 1);
  f.step();
  assert.equal(order.length, 8);
  f.step();
  assert.equal(order.length, 16);
  f.step();
  assert.deepEqual(
    await Promise.all(jobs),
    Array.from({ length: 20 }, (_, i) => i),
  );
  assert.deepEqual(
    order,
    Array.from({ length: 20 }, (_, i) => i),
  );
  assert.equal(f.scheduled.size, 0);
  assert.equal(f.dispatcher.stats().yields, 2);
});

test('synchronous start time bounds a slice without counting preceding idle time', async () => {
  const f = fixture(),
    order = [];
  f.advance(10000);
  const jobs = Array.from({ length: 6 }, (_, index) =>
    f.dispatcher.run(() => {
      order.push(index);
      f.advance(3);
    }),
  );
  f.step();
  assert.deepEqual(order, [0, 1, 2]);
  f.advance(100);
  f.step();
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5]);
  await Promise.all(jobs);
});

test('an unresolved asynchronous request does not retain admission or block another request', async () => {
  const f = fixture({ maxPending: 1 });
  let finish,
    secondStarted = false;
  const first = f.dispatcher.run(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.step();
  assert.equal(f.dispatcher.stats().pending, 0);
  const second = f.dispatcher.run(() => {
    secondStarted = true;
    return 2;
  });
  f.step();
  assert.equal(await second, 2);
  assert.equal(secondStarted, true);
  finish(1);
  assert.equal(await first, 1);
});

test('queue bound, cancellation and elapsed deadline reject before callbacks', async () => {
  const f = fixture({ maxPending: 2, timeoutMs: 50 });
  let calls = 0,
    cancelled = false;
  const first = assert.rejects(
    f.dispatcher.run(() => calls++, { cancelled: () => cancelled }),
    (e) => e.status === 499,
  );
  const second = assert.rejects(
    f.dispatcher.run(() => calls++),
    (e) => e.status === 503 && e.retryAfter === 1,
  );
  await assert.rejects(
    f.dispatcher.run(() => calls++),
    (e) => e.status === 503,
  );
  cancelled = true;
  f.advance(50);
  f.step();
  await Promise.all([first, second]);
  assert.equal(calls, 0);
  assert.deepEqual(f.dispatcher.stats(), {
    admitted: 2,
    started: 0,
    refused: 1,
    cancelled: 1,
    timedOut: 1,
    peakPending: 2,
    yields: 0,
    pending: 0,
    closed: false,
  });
});

test('close rejects pending requests and cancels scheduled work but not started requests', async () => {
  const f = fixture();
  let finish,
    calls = 0;
  const active = f.dispatcher.run(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.step();
  const pending = assert.rejects(
    f.dispatcher.run(() => calls++),
    (e) => e.status === 503,
  );
  f.dispatcher.close();
  f.dispatcher.close();
  await pending;
  assert.equal(f.scheduled.size, 0);
  await assert.rejects(
    f.dispatcher.run(() => calls++),
    (e) => e.status === 503,
  );
  finish(7);
  assert.equal(await active, 7);
  assert.equal(calls, 0);
});

test('callback exceptions and rejected promises do not stall the FIFO', async () => {
  const f = fixture();
  const first = assert.rejects(
    f.dispatcher.run(() => {
      throw Error('sync synthetic');
    }),
    /sync synthetic/,
  );
  const second = assert.rejects(
    f.dispatcher.run(() => Promise.reject(Error('async synthetic'))),
    /async synthetic/,
  );
  const third = f.dispatcher.run(() => 3);
  f.step();
  await Promise.all([first, second]);
  assert.equal(await third, 3);
  assert.equal(f.dispatcher.stats().pending, 0);
});

test('HTTP-style synchronous callback bursts no longer starve an existing real writer FIFO', async (t) => {
  for (const bounded of [false, true]) {
    let clock = 0,
      starts = 0,
      saved = false;
    const mocked = t.mock.method(performance, 'now', () => clock);
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE records(value INTEGER)');
    const writer = createAsyncWriteLock(db, { timeoutMs: 50 });
    const dispatcher = createRequestDispatcher();
    try {
      const first = writer.transaction(() => {
        clock += 9;
      });
      const second = writer.transaction(() => {
        saved = true;
        db.exec('INSERT INTO records VALUES(1)');
      });
      const writerResult = Promise.allSettled([first, second]);
      // All callbacks of a simulated ready-socket burst precede the writer's
      // already-needed next immediate. The workload cost is a fake clock, not
      // a machine-speed-dependent spin or an external network request.
      const requests = Array.from({ length: 100 }, () =>
        immediate().then(() => {
          const start = () => {
            assert.equal(db.isTransaction, false);
            starts++;
            clock++;
          };
          return bounded ? dispatcher.run(start) : start();
        }),
      );
      await Promise.all(requests);
      const result = await writerResult;
      assert.equal(starts, 100);
      assert.equal(saved, bounded);
      assert.equal(result[1].status, bounded ? 'fulfilled' : 'rejected');
      if (!bounded) assert.equal(result[1].reason.status, 503);
      assert.equal(writer.stats().timedOut, Number(!bounded));
      assert.equal(writer.stats().busyAttempts, 0);
      assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, Number(bounded));
      assert.equal(db.isTransaction, false);
    } finally {
      dispatcher.close();
      writer.close();
      db.close();
      mocked.mock.restore();
    }
  }
});
