const test = require('node:test');
const assert = require('node:assert/strict');
const { queueFixture } = require('./helpers/postgres-queue134-fixture.cjs');
const {
  createProjectionSnapshot,
} = require('../src/server/infrastructure/native-projection-snapshot140.cjs');
test(
  'physical PostgreSQL query snapshot keeps canonical reads together and expires its opaque proof',
  { timeout: 120000 },
  async (t) => {
    const f = await queueFixture(t);
    const p = f.a.p;
    const b = await f.open();
    const key = 'projection140';
    const read = p.prepare('SELECT value FROM telegram_runtime WHERE key=?');
    const write = b.p.prepare('INSERT OR REPLACE INTO telegram_runtime(key,value) VALUES(?,?)');
    write.run(key, Buffer.from('first'));
    const database = {
      db: p,
      readOnlySnapshot(work) {
        p.exec('BEGIN READONLY');
        try {
          const value = work();
          p.exec('COMMIT');
          return value;
        } catch (error) {
          if (p.isTransaction) p.exec('ROLLBACK');
          throw error;
        }
      },
    };
    const snapshot = createProjectionSnapshot(database, true);
    let proof;
    snapshot.run(f.organizations[0], () => {
      proof = snapshot.proof();
      assert.equal(Buffer.from(read.get(key).value).toString(), 'first');
      write.run(key, Buffer.from('second'));
      assert.equal(snapshot.contains(proof, f.organizations[0]), true);
      assert.equal(snapshot.contains(proof, f.organizations[1]), false);
      f.a.c[0].exec('BEGIN READONLY');
      try {
        assert.equal(snapshot.contains(proof, f.organizations[0]), true);
        assert.equal(
          snapshot.read(() => Buffer.from(read.get(key).value).toString()),
          'first',
        );
      } finally {
        f.a.c[0].exec('COMMIT');
      }
      assert.equal(Buffer.from(read.get(key).value).toString(), 'first');
    });
    assert.equal(snapshot.contains(proof, f.organizations[0]), false);
    assert.equal(Buffer.from(read.get(key).value).toString(), 'second');
    snapshot.run(f.organizations[0], () => {
      assert.notEqual(snapshot.proof(), proof);
      assert.equal(Buffer.from(read.get(key).value).toString(), 'second');
    });
    assert.equal(p.isTransaction, false);
    let changedProof;
    assert.throws(
      () =>
        snapshot.run(f.organizations[0], () => {
          changedProof = snapshot.proof();
          const originalIdentity = p.readSnapshotIdentity();
          p.exec('COMMIT');
          p.exec('BEGIN READONLY');
          assert.notEqual(p.readSnapshotIdentity(), originalIdentity);
          return snapshot.contains(changedProof, f.organizations[0]);
        }),
      { code: 'POSTGRES_QUERY_SNAPSHOT_INVALID' },
    );
    assert.equal(snapshot.contains(changedProof, f.organizations[0]), false);
    assert.equal(p.isTransaction, false);
    let failedProof;
    assert.throws(
      () =>
        snapshot.run(f.organizations[0], () => {
          failedProof = snapshot.proof();
          assert.throws(() => p.prepare('SELECT 1/0 AS bad').get(), { code: '22012' });
          return snapshot.contains(failedProof, f.organizations[0]);
        }),
      { code: '25P02' },
    );
    assert.equal(snapshot.contains(failedProof, f.organizations[0]), false);
    assert.equal(p.isTransaction, false);
    assert.equal(Buffer.from(read.get(key).value).toString(), 'second');
  },
);
