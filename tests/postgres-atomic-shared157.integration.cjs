const test = require('node:test');
const assert = require('node:assert/strict');
const { queueFixture } = require('./helpers/postgres-queue134-fixture.cjs');
test(
  '157 explicit shared mutation aborts after a caught SQL failure while ordinary shared compatibility still recovers',
  { timeout: 120000 },
  async (t) => {
    const f = await queueFixture(t),
      p = f.a.p,
      c = f.a.c[0];
    const put = (id) =>
      c.prepare('INSERT INTO patients(id,value) VALUES(?,?)').run(id, Buffer.from('synthetic'));
    p.beginAtomicShared();
    c.transaction(() => {
      put('atomic-one');
      put('atomic-two');
    });
    p.exec('COMMIT');
    assert.equal(c.prepare('SELECT count(*) n FROM patients').get().n, 2);
    p.beginAtomicShared();
    assert.throws(
      () =>
        c.transaction(() => {
          put('must-rollback');
          assert.throws(
            () => put('atomic-one'),
            (error) => error.code === '23505',
          );
          assert.throws(() => c.prepare('SELECT count(*) n FROM patients').get(), {
            code: 'POSTGRES_ATOMIC_STATEMENT_FAILED',
          });
        }),
      (error) => error.code === '25P02' || error.code === 'POSTGRES_ATOMIC_STATEMENT_FAILED',
    );
    assert.throws(() => p.exec('COMMIT'), { code: 'POSTGRES_ATOMIC_STATEMENT_FAILED' });
    assert.equal(p.isTransaction, false);
    assert.equal(c.isTransaction, false);
    assert.equal(
      c.prepare('SELECT value FROM patients WHERE id=?').get('must-rollback'),
      undefined,
    );
    assert.equal(c.prepare('SELECT count(*) n FROM patients').get().n, 2);
    p.sharedCommit(() =>
      c.transaction(() => {
        put('ordinary-one');
        assert.throws(
          () => put('atomic-one'),
          (error) => error.code === '23505',
        );
        put('ordinary-two');
      }),
    );
    assert.equal(
      c.prepare('SELECT count(*) n FROM patients').get().n,
      4,
      'existing shared API retains per-statement recovery',
    );
    assert.equal(f.a.c[1].prepare('SELECT count(*) n FROM patients').get().n, 0);
  },
);
