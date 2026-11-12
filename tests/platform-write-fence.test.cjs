const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  createPlatformWriteFence,
} = require('../src/server/infrastructure/platform-write-fence.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-write-fence-'));
  const stores = [];
  function open() {
    const raw = new DatabaseSync(path.join(directory, 'platform.sqlite'));
    raw.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0');
    const fence = createPlatformWriteFence(raw, directory);
    stores.push(fence.db);
    return fence;
  }
  t.after(() => {
    for (const db of stores) if (db.isOpen) db.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^cartoteca-write-fence-/);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  const first = open();
  first.db.exec(
    'CREATE TABLE permissions(id INTEGER PRIMARY KEY, allowed INTEGER NOT NULL); INSERT INTO permissions VALUES(1,1)',
  );
  return { directory, first, second: open(), open };
}
const busy = (error) => error.code === 'ERR_SQLITE_ERROR' && (error.errcode & 255) === 5;

test('independent shared commits overlap; cached and RETURNING permission writes cannot pass', async (t) => {
  const { first, second } = fixture(t);
  const cached = second.db.prepare('UPDATE permissions SET allowed=0 WHERE id=1');
  const returning = second.db.prepare('UPDATE permissions SET allowed=0 WHERE id=1 RETURNING id');
  let overlapped = false,
    secondCommit;
  await first.readCommit(() => {
    assert.equal(first.db.prepare('SELECT allowed FROM permissions').get().allowed, 1);
    assert.throws(() => cached.run(), busy);
    assert.throws(() => returning.get(), busy);
    assert.throws(() => second.db.exec('BEGIN IMMEDIATE'), busy);
    secondCommit = second.readCommit(() => {
      overlapped = true;
      assert.equal(second.db.prepare('SELECT allowed FROM permissions').get().allowed, 1);
    });
    assert.equal(overlapped, true);
  });
  await secondCommit;
  cached.run();
  assert.equal(first.db.prepare('SELECT allowed FROM permissions').get().allowed, 0);
});

test('write fence lasts to COMMIT/ROLLBACK, not only until statement completes', async (t) => {
  const { first, second } = fixture(t);
  first.db.exec('BEGIN IMMEDIATE');
  first.db.prepare('UPDATE permissions SET allowed=0').run();
  let entered = false;
  const waiting = second.readCommit(() => {
    entered = true;
    assert.equal(second.db.prepare('SELECT allowed FROM permissions').get().allowed, 0);
  });
  assert.equal(entered, false);
  first.db.exec('COMMIT');
  await waiting;
  assert.equal(entered, true);
  first.db.exec('BEGIN DEFERRED');
  first.db.prepare('UPDATE permissions SET allowed=1').run();
  assert.throws(() => second.db.prepare('UPDATE permissions SET allowed=1').run(), busy);
  first.db.exec('ROLLBACK');
  second.db.prepare('UPDATE permissions SET allowed=1').run();
});

test('shared scope rejects platform side effects and async callbacks and releases locks on failure', async (t) => {
  const { first, second } = fixture(t);
  const cached = first.db.prepare('UPDATE permissions SET allowed=0');
  await assert.rejects(
    first.readCommit(() => cached.run()),
    /Platform write attempted/,
  );
  await assert.rejects(
    first.readCommit(() => first.db.exec('DELETE FROM permissions')),
    /Platform write attempted/,
  );
  await assert.rejects(
    first.readCommit(() => Promise.resolve()),
    /Async shared/,
  );
  assert.throws(() => first.db.prepare('PRAGMA query_only=OFF'), /authorized/);
  second.db.prepare('UPDATE permissions SET allowed=0').run();
  assert.equal(first.db.prepare('PRAGMA query_only').get().query_only, 0);
  assert.equal(first.db.isTransaction, false);
});

test('write iterators and script transactions retain exclusive fence until they finish', async (t) => {
  const { first, second } = fixture(t);
  first.db.exec('BEGIN; UPDATE permissions SET allowed=0;');
  assert.throws(() => second.db.prepare('UPDATE permissions SET allowed=1').run(), busy);
  first.db.exec('ROLLBACK');
  const rows = first.db.prepare('UPDATE permissions SET allowed=0 RETURNING id').iterate();
  assert.equal(rows.next().value.id, 1);
  first.db.prepare('SELECT allowed FROM permissions').get();
  assert.throws(() => second.db.prepare('UPDATE permissions SET allowed=1').run(), busy);
  rows.return();
  second.db.prepare('UPDATE permissions SET allowed=1').run();
});

test(
  'another process can share the fence, and killing a holder cannot leave a stale lease',
  { timeout: 10000 },
  async (t) => {
    const { directory, first } = fixture(t);
    const { fork } = require('node:child_process');
    const { once } = require('node:events');
    const source = `
    const { DatabaseSync } = require('node:sqlite');
    const { createPlatformWriteFence } = require(${JSON.stringify(require.resolve('../src/server/infrastructure/platform-write-fence.cjs'))});
    const raw = new DatabaseSync(${JSON.stringify(path.join(directory, 'platform.sqlite'))});
    const fence = createPlatformWriteFence(raw, ${JSON.stringify(directory)});
    fence.readCommit(() => {
      process.send({ held: true });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000);
    }).then(() => { fence.db.close(); process.exit(0); });`;
    const child = fork('-e', [source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const exit = once(child, 'exit');
    try {
      const [message] = await once(child, 'message');
      assert.equal(message.held, true);
      await first.readCommit(() =>
        assert.equal(first.db.prepare('SELECT allowed FROM permissions').get().allowed, 1),
      );
      assert.throws(() => first.db.prepare('UPDATE permissions SET allowed=0').run(), busy);
    } finally {
      child.kill('SIGKILL');
      await exit;
    }
    first.db.prepare('UPDATE permissions SET allowed=0').run();
    assert.equal(first.db.prepare('SELECT allowed FROM permissions').get().allowed, 0);
  },
);
