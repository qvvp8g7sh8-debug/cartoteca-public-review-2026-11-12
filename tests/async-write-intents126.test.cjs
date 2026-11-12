const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { setTimeout: sleep } = require('node:timers/promises');
const { createAsyncWriteLock } = require('../src/server/infrastructure/async-write-lock.cjs');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-intents126-'));
  const db = new DatabaseSync(path.join(root, 'synthetic.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0; CREATE TABLE events(value TEXT)');
  const blocker = new DatabaseSync(path.join(root, 'synthetic.sqlite'));
  const admitted = [];
  const writer = createAsyncWriteLock(db, {
    timeoutMs: 2000,
    maxPending: 2,
    acquire: (options) => {
      db.exec('BEGIN IMMEDIATE');
      admitted.push(options.intent);
    },
    ...options,
  });
  t.after(() => {
    writer.close();
    if (blocker.isTransaction) blocker.exec('ROLLBACK');
    blocker.close();
    db.close();
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('cartoteca-intents126-'));
    fs.rmSync(root, { recursive: true });
  });
  return { db, blocker, writer, admitted };
}

test('critical and queue intents share one bounded FIFO, preserve callback-once and rollback isolation', async (t) => {
  const f = fixture(t);
  f.blocker.exec('BEGIN IMMEDIATE');
  const calls = [];
  const first = f.writer.transaction(
    () => {
      calls.push('critical');
      f.db.prepare('INSERT INTO events VALUES(?)').run('first');
      return 'first';
    },
    { intent: 'critical' },
  );
  const second = f.writer.transaction(
    () => {
      calls.push('queue');
      f.db.prepare('INSERT INTO events VALUES(?)').run('must-rollback');
      throw Error('synthetic queue rollback');
    },
    { intent: 'queue' },
  );
  const observed = second.catch((error) => error.message);
  await assert.rejects(
    f.writer.transaction(() => calls.push('overflow'), { intent: 'queue' }),
    { status: 503 },
  );
  await sleep(30);
  assert.deepEqual(calls, []);
  assert.equal(f.writer.stats().pending, 2);
  f.blocker.exec('COMMIT');
  assert.equal(await first, 'first');
  assert.equal(await observed, 'synthetic queue rollback');
  assert.deepEqual(calls, ['critical', 'queue']);
  assert.deepEqual(f.admitted, ['critical', 'queue']);
  assert.deepEqual(
    f.db
      .prepare('SELECT value FROM events')
      .all()
      .map((row) => row.value),
    ['first'],
  );
  assert.equal(f.writer.stats().peakPending, 2);
  assert.equal(f.writer.stats().refused, 1);
});

test('cancelled waiting queue intent is never executed or replayed after a critical commit', async (t) => {
  const f = fixture(t);
  f.blocker.exec('BEGIN IMMEDIATE');
  let cancelled = false,
    invoked = false;
  const critical = f.writer.transaction(() => 1, { intent: 'critical' });
  const queued = f.writer.transaction(
    () => {
      invoked = true;
    },
    { intent: 'queue', cancelled: () => cancelled },
  );
  const rejected = assert.rejects(queued, { status: 499 });
  cancelled = true;
  f.blocker.exec('COMMIT');
  assert.equal(await critical, 1);
  await rejected;
  assert.equal(invoked, false);
  assert.deepEqual(f.admitted, ['critical']);
});
