const test = require('node:test');
const assert = require('node:assert/strict');
const { queueFixture } = require('./helpers/postgres-queue134-fixture.cjs');
test(
  '155 one native batch keeps order, source scope, clock invalidation and rollback of a late failed prefix',
  { timeout: 120000 },
  async (t) => {
    const f = await queueFixture(t),
      db = f.a.c[0];
    const insert = (id, value) => ({
      sql: 'INSERT INTO patients(id,value) VALUES(?,?)',
      args: [id, Buffer.from(value)],
    });
    assert.throws(() => db.executeWriteBatch([insert('p', 'x')]), {
      code: 'POSTGRES_WRITE_BATCH_CONTEXT',
    });
    db.transaction(() => {
      assert.throws(
        () =>
          db.executeWriteBatch([
            {
              sql: 'INSERT INTO patients(id,value) VALUES(?,?) RETURNING id',
              args: ['returning-denied', Buffer.from('x')],
            },
          ]),
        { code: 'POSTGRES_WRITE_BATCH_INVALID' },
      );
      const calls = f.a.owner.stats().calls,
        clock = db.localMutationClock;
      db.executeWriteBatch([
        insert('p', 'before'),
        { sql: 'UPDATE patients SET value=? WHERE id=?', args: [Buffer.from('after'), 'p'] },
        insert('other', 'two'),
      ]);
      assert.equal(
        f.a.owner.stats().calls - calls,
        1,
        'one physical RPC, no client-side step loop',
      );
      assert.ok(db.localMutationClock > clock);
      assert.equal(
        db.prepare('SELECT value FROM patients WHERE id=?').get('p').value.toString(),
        'after',
      );
      assert.throws(
        () => db.executeWriteBatch([insert('rolled-back', 'x'), insert('p', 'duplicate')]),
        (error) => error.code === '23505',
      );
      assert.equal(
        db.prepare('SELECT value FROM patients WHERE id=?').get('rolled-back'),
        undefined,
        'whole failed batch rolled back, earlier transaction work retained',
      );
      assert.equal(
        db.prepare('SELECT value FROM patients WHERE id=?').get('p').value.toString(),
        'after',
      );
      db.executeWriteBatch([
        insert('survives', 'one'),
        { sql: 'UPDATE patients SET value=? WHERE id=?', args: [Buffer.from('two'), 'survives'] },
      ]);
      assert.throws(
        () =>
          db.executeWriteBatch([
            insert('not-issued', 'x'),
            { sql: 'SELECT value FROM patients', args: [] },
          ]),
        { code: 'POSTGRES_WRITE_BATCH_INVALID' },
      );
      assert.equal(
        db.prepare('SELECT value FROM patients WHERE id=?').get('not-issued'),
        undefined,
      );
    });
    assert.equal(
      f.a.c[1].prepare('SELECT count(*) n FROM patients').get().n,
      0,
      'batch cannot select another physical store',
    );
    assert.equal(
      db.prepare('SELECT value FROM patients WHERE id=?').get('survives').value.toString(),
      'two',
    );
    db.transaction(() => {
      assert.throws(() => db.executeWriteBatch([insert('readonly', 'x')]));
    }, 'READONLY');
    assert.equal(db.prepare('SELECT value FROM patients WHERE id=?').get('readonly'), undefined);
  },
);
