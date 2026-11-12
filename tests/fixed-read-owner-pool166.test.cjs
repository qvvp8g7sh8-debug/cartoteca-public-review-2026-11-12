// Proposed166: not applied to the project and not executed.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createFixedReadOwnerPool166,
} = require('../src/server/infrastructure/postgres/fixed-read-owner-pool166.cjs');

function owner(id, closeError = null) {
  return {
    id,
    healthy: true,
    closes: 0,
    available166() {
      return this.healthy;
    },
    authority: async () => ({ id }),
    run: async () => ({ id }),
    sqlCalls: () => 0,
    async close() {
      this.closes++;
      this.healthy = false;
      if (closeError) throw closeError;
    },
  };
}

test('166 fixed owners are exclusive, round-robin and never queue a third borrower', async () => {
  const a = owner('a'),
    b = owner('b'),
    supplied = [a, b];
  const pool = createFixedReadOwnerPool166({ owners: supplied });
  supplied[0] = owner('not-in-pool');
  assert.equal(pool.capacity166, 2);
  const first = pool.borrow166(),
    second = pool.borrow166();
  assert.equal(first.owner, a, 'snapshot the fixed owners instead of lending caller array state');
  assert.equal(second.owner, b);
  assert.equal(pool.borrow166(), null, 'fixed pool has no hidden admission queue');
  assert.equal(pool.stats().borrowed, 2);
  assert.equal(pool.stats().available, 0);
  first.release();
  first.release();
  const third = pool.borrow166();
  assert.equal(third.owner, a);
  third.release();
  second.release();
  const fourth = pool.borrow166();
  assert.equal(fourth.owner, b, 'next available owner rotates after a release');
  fourth.release();
  assert.deepEqual(
    {
      borrowed: pool.stats().borrowed,
      borrows: pool.stats().borrows,
      rejected: pool.stats().rejected,
      released: pool.stats().released,
    },
    { borrowed: 0, borrows: 4, rejected: 1, released: 4 },
  );
  await pool.close();
});

test('166 poisoned owners are skipped without replacement or replay', async () => {
  const a = owner('a'),
    b = owner('b');
  const pool = createFixedReadOwnerPool166({ owners: [a, b] });
  const lease = pool.borrow166();
  a.healthy = false;
  lease.release();
  const healthy = pool.borrow166();
  assert.equal(healthy.owner, b);
  assert.equal(pool.borrow166(), null);
  assert.equal(pool.stats().unhealthy, 1);
  assert.equal(a.closes, 0, 'poison handling does not create/reinitialize another owner');
  healthy.release();
  b.healthy = false;
  assert.equal(pool.borrow166(), null);
  assert.equal(pool.stats().available, 0);
  assert.equal(pool.stats().unhealthy, 2);
  await pool.close();
  assert.equal(a.closes, 1);
  assert.equal(b.closes, 1);
});

test('166 close stops admission and waits for every lease release before closing clients', async () => {
  const a = owner('a'),
    b = owner('b');
  const pool = createFixedReadOwnerPool166({ owners: [a, b] });
  const first = pool.borrow166(),
    second = pool.borrow166();
  let finished = false;
  const closing = pool.close().then(() => {
    finished = true;
  });
  assert.equal(pool.stats().closing, true);
  assert.equal(pool.borrow166(), null);
  first.release();
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(a.closes + b.closes, 0, 'one remaining job still owns its client');
  second.release();
  await closing;
  await pool.close();
  assert.equal(finished, true);
  assert.equal(a.closes, 1);
  assert.equal(b.closes, 1);
  assert.equal(pool.stats().closed, true);
  assert.equal(pool.stats().borrowed, 0);
  assert.equal(pool.stats().available, 0);
});

test('166 close drains every client even when the first close rejects', async () => {
  const failure = Object.assign(Error('synthetic close failure'), { code: 'SYNTHETIC166' });
  for (const synchronous of [false, true]) {
    const a = owner('a', failure),
      b = owner('b');
    if (synchronous)
      a.close = () => {
        a.closes++;
        a.healthy = false;
        throw failure;
      };
    const pool = createFixedReadOwnerPool166({ owners: [a, b] });
    await assert.rejects(pool.close(), (error) => error === failure);
    assert.equal(a.closes, 1);
    assert.equal(b.closes, 1);
    assert.equal(pool.borrow166(), null);
    await assert.rejects(pool.close(), (error) => error === failure);
    assert.equal(a.closes + b.closes, 2, 'idempotent failure cannot start a second close');
  }
});

test('166 cancellation releases in finally and the next job can use the drained owner', async () => {
  const a = owner('a');
  a.run = async () => {
    throw Object.assign(Error('synthetic cancelled'), { status: 499 });
  };
  const pool = createFixedReadOwnerPool166({ owners: [a] });
  const lease = pool.borrow166();
  try {
    await assert.rejects(lease.owner.run(), { status: 499 });
  } finally {
    lease.release();
  }
  const next = pool.borrow166();
  assert.equal(next.owner, a);
  next.release();
  await pool.close();
});

test('166 owner configuration is fixed at one or two complete client capabilities', () => {
  const same = owner('same');
  for (const owners of [[], [owner('a'), owner('b'), owner('c')], [{}], [same, same], null])
    assert.throws(() => createFixedReadOwnerPool166({ owners }));
});
