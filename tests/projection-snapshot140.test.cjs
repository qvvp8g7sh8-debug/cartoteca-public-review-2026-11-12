const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createProjectionSnapshot,
} = require('../src/server/infrastructure/native-projection-snapshot140.cjs');
function fixture(postgres = true) {
  const db = {
    readIdentity: Object.freeze({}),
    readSnapshotIdentity() {
      this.snapshotVersion();
      return this.readIdentity;
    },
    isOpen: true,
    isTransaction: false,
    transactionIntent: null,
    snapshotVersion() {
      if (this.aborted) throw Object.assign(Error('aborted'), { code: '25P02' });
      return 'snapshot';
    },
  };
  let begins = 0,
    closed = 0;
  const snapshot = createProjectionSnapshot(
    {
      db,
      readOnlySnapshot(work) {
        begins++;
        db.isTransaction = true;
        db.transactionIntent = 'READONLY';
        try {
          return work();
        } finally {
          closed++;
          db.isTransaction = false;
          db.transactionIntent = null;
        }
      },
    },
    postgres,
  );
  return { db, snapshot, counts: () => ({ begins, closed }) };
}
test('one owning RR includes nested response reads and closes before the result leaves', () => {
  const f = fixture();
  let proof;
  assert.equal(
    f.snapshot.run('org', () => {
      proof = f.snapshot.proof();
      assert.equal(f.snapshot.contains(proof, 'org'), true);
      return f.snapshot.read(() => {
        assert.equal(f.snapshot.proof(), proof);
        assert.equal(f.snapshot.contains(proof, 'org'), true);
        return 17;
      });
    }),
    17,
  );
  assert.deepEqual(f.counts(), { begins: 1, closed: 1 });
  assert.equal(f.snapshot.proof(), null);
  assert.equal(f.snapshot.contains(proof, 'org'), false);
});
test('a forged identity, other organization and prior response never acquire a read proof', () => {
  const f = fixture();
  let first;
  f.snapshot.run('one', () => {
    first = f.snapshot.proof();
    assert.equal(f.snapshot.contains({ organizationId: 'one' }, 'one'), false);
    assert.equal(f.snapshot.contains(first, 'two'), false);
    assert.equal(f.snapshot.contains(null, 'one'), false);
  });
  f.snapshot.run('one', () => {
    assert.notEqual(f.snapshot.proof(), first);
    assert.equal(f.snapshot.contains(first, 'one'), false);
  });
});
test('failed projection clears identity before rollback and propagates the original failure', () => {
  const f = fixture();
  const failure = Error('synthetic');
  let proof;
  assert.throws(
    () =>
      f.snapshot.run('org', () => {
        proof = f.snapshot.proof();
        throw failure;
      }),
    (error) => error === failure,
  );
  assert.equal(f.snapshot.contains(proof, 'org'), false);
  assert.equal(f.db.isTransaction, false);
  assert.deepEqual(f.counts(), { begins: 1, closed: 1 });
});
test('poisoned, ended and upgraded snapshots fail closed before reusing source rows', () => {
  for (const mutate of [
    (db) => (db.isOpen = false),
    (db) => (db.isTransaction = false),
    (db) => (db.transactionIntent = 'IMMEDIATE'),
  ]) {
    const f = fixture();
    f.snapshot.run('org', () => {
      const proof = f.snapshot.proof();
      mutate(f.db);
      for (const observe of [
        () => f.snapshot.proof(),
        () => f.snapshot.contains(proof, 'org'),
        () => f.snapshot.read(() => 1),
      ])
        assert.throws(observe, { code: 'POSTGRES_QUERY_SNAPSHOT_INVALID', status: 503 });
    });
  }
});
test('asynchronous projection and nested projection cannot leave an open snapshot', () => {
  for (const work of [(f) => f.snapshot.run('org', () => 1), () => Promise.resolve(1)]) {
    const f = fixture();
    assert.throws(() => f.snapshot.run('org', () => work(f)), /query projection/);
    assert.equal(f.snapshot.proof(), null);
    assert.equal(f.db.isTransaction, false);
    assert.deepEqual(f.counts(), { begins: 1, closed: 1 });
  }
});
test('ordinary and SQLite response readers retain their existing snapshot path without proof', () => {
  const f = fixture(false);
  assert.equal(
    f.snapshot.run('org', () => {
      assert.equal(f.snapshot.proof(), null);
      return 3;
    }),
    3,
  );
  assert.deepEqual(f.counts(), { begins: 0, closed: 0 });
  assert.equal(
    f.snapshot.read(() => 4),
    4,
  );
  assert.deepEqual(f.counts(), { begins: 1, closed: 1 });
});

test('caught SQL failure cannot reuse canonical source rows through a stale proof', () => {
  const f = fixture();
  let proof;
  assert.throws(
    () =>
      f.snapshot.run('org', () => {
        proof = f.snapshot.proof();
        f.db.aborted = true;
        return f.snapshot.contains(proof, 'org');
      }),
    { code: '25P02' },
  );
  assert.equal(f.snapshot.contains(proof, 'org'), false);
  assert.equal(f.db.isTransaction, false);
});

test('a replaced physical root cannot reuse source rows even with equal flags and SQL snapshot text', () => {
  const f = fixture();
  f.snapshot.run('org', () => {
    const proof = f.snapshot.proof();
    f.db.readIdentity = Object.freeze({});
    assert.throws(() => f.snapshot.contains(proof, 'org'), {
      code: 'POSTGRES_QUERY_SNAPSHOT_INVALID',
    });
  });
  assert.equal(f.db.isTransaction, false);
});
