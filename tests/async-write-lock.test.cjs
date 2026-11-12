const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { setTimeout: sleep, setImmediate: immediate } = require('node:timers/promises');
const { performance } = require('node:perf_hooks');
const { createAsyncWriteLock } = require('../src/server/infrastructure/async-write-lock.cjs');

function fixture(t, options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-async-writer-'));
  const db = new DatabaseSync(path.join(directory, 'synthetic.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE records(value TEXT)');
  const other = new DatabaseSync(path.join(directory, 'synthetic.sqlite'));
  const writer = createAsyncWriteLock(db, options);
  t.after(() => { writer.close(); if (other.isTransaction) other.exec('ROLLBACK'); other.close(); db.close(); fs.rmSync(directory, { recursive: true }); });
  return { db, other, writer };
}
test('busy acquisition yields event loop, preserves FIFO and executes each callback once without await under lock', async (t) => {
  const f = fixture(t);
  f.other.exec('BEGIN IMMEDIATE');
  const order = [];
  let timerRan = false;
  const tasks = [1, 2, 3].map(n => f.writer.transaction(() => {
    assert.equal(timerRan, true);
    assert.equal(f.db.isTransaction, true);
    order.push(n);
    f.db.prepare('INSERT INTO records VALUES(?)').run(String(n));
    return n;
  }));
  await sleep(40);
  assert.deepEqual(order, []);
  assert.equal(f.db.isTransaction, false);
  assert.equal(f.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  timerRan = true;
  f.other.exec('COMMIT');
  assert.deepEqual(await Promise.all(tasks), [1, 2, 3]);
  assert.deepEqual(order, [1, 2, 3]);
  assert.ok(f.writer.stats().busyAttempts > 0);
  assert.equal(f.db.prepare('PRAGMA synchronous').get().synchronous, 2);
});
test('queue bounds bytes and requests; cancellation and deadline never call the writer', async (t) => {
  const f = fixture(t, { maxPending: 2, maxBytes: 8, timeoutMs: 75 });
  f.other.exec('BEGIN IMMEDIATE');
  let calls = 0, cancelled = false;
  const first = f.writer.transaction(() => calls++, { bytes: 5, cancelled: () => cancelled });
  const firstRejected = assert.rejects(first, e => e.status === 499);
  await assert.rejects(f.writer.transaction(() => calls++, { bytes: 4 }), e => e.status === 503);
  const second = f.writer.transaction(() => calls++, { bytes: 3 });
  const secondRejected = assert.rejects(second, e => e.status === 503 && e.retryAfter === 1);
  await assert.rejects(f.writer.transaction(() => calls++), e => e.status === 503);
  cancelled = true;
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(calls, 0);
  assert.equal(f.db.isTransaction, false);
  assert.equal(f.writer.stats().bytes, 0);
});
test('callback and commit failures are not retried; async callback rejected; telemetry cannot change success', async (t) => {
  const f = fixture(t);
  let calls = 0;
  await assert.rejects(f.writer.transaction(() => {
    calls++; f.db.exec("INSERT INTO records VALUES('rollback')"); throw Error('synthetic callback');
  }), /synthetic callback/);
  assert.equal(calls, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM records').get().n, 0);
  await assert.rejects(f.writer.transaction(() => Promise.resolve()), /Asynchronous/);
  assert.equal(await f.writer.transaction(() => 7, { committed() { throw Error('diagnostic'); } }), 7);
  assert.equal(f.db.isTransaction, false);
  f.writer.close();
  await assert.rejects(f.writer.transaction(() => calls++), e => e.status === 503);
});

test('free writer yields between commits without losing FIFO or byte accounting', async (t) => {
  const f = fixture(t), order = [], commitStates = [];
  let observed;
  const io = immediate().then(() => {
    assert.equal(f.db.isTransaction, false);
    observed = order.length;
  });
  const writes = Array.from({ length: 24 }, (_, index) => f.writer.transaction(() => {
    order.push(index);
    f.db.prepare('INSERT INTO records VALUES(?)').run(String(index));
    return index;
  }, { bytes: 1, committed() { commitStates.push(f.db.isTransaction); } }));
  assert.deepEqual(await Promise.all(writes), Array.from({ length: 24 }, (_, index) => index));
  await io;
  assert.ok(observed >= 1 && observed <= 8, 'I/O ran before the synchronous FIFO could drain');
  assert.deepEqual(order, Array.from({ length: 24 }, (_, index) => index));
  assert.equal(f.writer.stats().pending, 0);
  assert.equal(f.writer.stats().bytes, 0);
  assert.ok(f.writer.stats().yields >= 3);
  assert.deepEqual(commitStates, Array(24).fill(false));
});

test('a single Promise producer cannot reset the yield budget between pump calls', async (t) => {
  const f = fixture(t);
  let completed = 0, observed;
  const io = immediate().then(() => {
    assert.equal(f.db.isTransaction, false);
    observed = completed;
  });
  for (let index = 0; index < 24; index++) await f.writer.transaction(() => ++completed);
  await io;
  assert.ok(observed >= 1 && observed <= 8);
  assert.equal(completed, 24);
});

test('elapsed slice yields only after commit and updates the committed hook before next admission', async (t) => {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  const f = fixture(t), events = [];
  const io = immediate().then(() => {
    assert.equal(f.db.isTransaction, false);
    events.push('io');
  });
  const first = f.writer.transaction(() => {
    clock = 9;
    return 'first';
  }, { committed() { events.push('committed'); } });
  const second = f.writer.transaction(() => { events.push('second'); });
  await Promise.all([first, second, io]);
  assert.deepEqual(events, ['committed', 'io', 'second']);
});

test('cancellation during a yield skips pending callbacks and releases their bytes', async (t) => {
  const f = fixture(t);
  let cancelled = false, calls = 0;
  const io = immediate().then(() => { cancelled = true; });
  const pending = Array.from({ length: 24 }, () => f.writer.transaction(() => ++calls, {
    bytes: 1, cancelled: () => cancelled,
  }));
  const results = await Promise.allSettled(pending);
  await io;
  assert.ok(calls >= 1 && calls <= 8);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, calls);
  assert.ok(results.filter(row => row.status === 'rejected').every(row => row.reason.status === 499));
  assert.equal(f.writer.stats().cancelled, 24 - calls);
  assert.equal(f.writer.stats().bytes, 0);
  assert.equal(f.db.isTransaction, false);
});

test('deadline and closure are rechecked after the event-loop yield before BEGIN', async (t) => {
  for (const closed of [false, true]) {
    let clock = 0, calls = 0;
    const now = t.mock.method(performance, 'now', () => clock);
    const f = fixture(t, { timeoutMs: 50 });
    const io = immediate().then(() => {
      assert.equal(f.db.isTransaction, false);
      if (closed) f.writer.close();
      else clock = 100;
    });
    const first = f.writer.transaction(() => { clock = 9; return ++calls; });
    const second = assert.rejects(f.writer.transaction(() => ++calls, { bytes: 3 }), error => error.status === 503);
    await Promise.all([first, second, io]);
    assert.equal(calls, 1);
    assert.equal(f.writer.stats().timedOut, Number(!closed));
    assert.equal(f.writer.stats().bytes, 0);
    now.mock.restore();
  }
});
