const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { postgresRevisionFixture } = require('./helpers/postgres-revision133-fixture.cjs');
const { createReadVersion } = require('../src/server/infrastructure/read-version.cjs');
const { TABLE } = require('../src/server/infrastructure/postgres/revision-sql132.cjs');
test(
  'native profile 3 snapshots invalidate delayed commits, own writes and rollback without shared revision writes',
  { timeout: 180000 },
  async (t) => {
    const f = await postgresRevisionFixture(t);
    await f.change();
    const executor = await f.owner(),
      { db } = executor;
    const read = createReadVersion(db),
      value = db.prepare('SELECT value FROM telegram_runtime WHERE key=?');
    const insert =
      "INSERT INTO cartoteca_platform.telegram_runtime(key,value) VALUES($1,decode($2,'hex'))";
    const stateBefore = (
      await f.admin.query('SELECT * FROM ' + TABLE + ' ORDER BY kind,store_id,domain')
    ).rows;
    const catalogBefore = (
      await f.admin.query(
        'SELECT kind,store_id,revision FROM cartoteca_catalog.stores ORDER BY kind,store_id',
      )
    ).rows;
    await t.test(
      'a writer allocated before the cache read becomes visible when xip removes its committed xid',
      async () => {
        await f.app.query('BEGIN');
        await f.app.query(insert, ['mvcc133-delayed', '01']);
        const before = read();
        assert.equal(value.get('mvcc133-delayed'), undefined);
        await f.app.query('COMMIT');
        assert.notDeepEqual(read(), before);
        assert.deepEqual(value.get('mvcc133-delayed').value, Buffer.from([1]));
      },
    );
    await t.test('a complete transaction between cache reads advances the snapshot', async () => {
      const before = read();
      await f.app.query(insert, ['mvcc133-between', '02']);
      assert.notDeepEqual(read(), before);
      assert.deepEqual(value.get('mvcc133-between').value, Buffer.from([2]));
    });
    await t.test(
      'abort cannot expose uncommitted rows and permits conservative invalidation',
      async () => {
        await f.app.query('BEGIN');
        await f.app.query(insert, ['mvcc133-abort', '03']);
        const before = read();
        await f.app.query('ROLLBACK');
        assert.notDeepEqual(read(), before);
        assert.equal(value.get('mvcc133-abort'), undefined);
      },
    );
    await t.test(
      'repeatable read retains the old visible rows and token until the read transaction ends',
      async () => {
        db.exec('BEGIN READONLY');
        try {
          const before = read();
          assert.equal(value.get('mvcc133-rr'), undefined);
          await f.app.query(insert, ['mvcc133-rr', '04']);
          assert.deepEqual(read(), before);
          assert.equal(value.get('mvcc133-rr'), undefined);
        } finally {
          db.exec('ROLLBACK');
        }
        assert.deepEqual(value.get('mvcc133-rr').value, Buffer.from([4]));
      },
    );
    await t.test('a pinned xmin does not hide another transaction commit', async () => {
      const pinned = new Client(f.runtime.application);
      await pinned.connect();
      try {
        await f.setScope(pinned);
        await pinned.query('BEGIN');
        await pinned.query(insert, ['mvcc133-pinned', '05']);
        const before = read();
        await f.app.query(insert, ['mvcc133-while-pinned', '06']);
        assert.notDeepEqual(read(), before);
        assert.deepEqual(value.get('mvcc133-while-pinned').value, Buffer.from([6]));
      } finally {
        await pinned.query('ROLLBACK');
        await pinned.end();
      }
    });
    await t.test(
      'own writes through two handles and cabinet savepoint/outer rollback never cause clock ABA',
      () => {
        const alias = executor.owner.open(f.scope);
        const cabinetScope = f.profile.stores.find((s) => s.kind === 'cabinet');
        const cabinet = executor.owner.open(cabinetScope);
        const cabinetRead = createReadVersion(cabinet);
        db.exec('BEGIN IMMEDIATE');
        const before = read();
        db.prepare('INSERT INTO telegram_runtime VALUES(?,?)').run('mvcc133-own', Buffer.from([7]));
        const first = read();
        assert.ok(first[2] > before[2]);
        alias
          .prepare('UPDATE telegram_runtime SET value=? WHERE key=?')
          .run(Buffer.from([8]), 'mvcc133-own');
        const second = read();
        assert.ok(second[2] > first[2]);
        assert.equal(alias.localMutationClock, db.localMutationClock);
        const cabinetBefore = cabinetRead();
        assert.throws(
          () =>
            cabinet.transaction(() => {
              cabinet
                .prepare('INSERT INTO meta(key,value) VALUES(?,?)')
                .run('mvcc133-savepoint', Buffer.from([9]));
              assert.ok(cabinetRead()[2] > cabinetBefore[2]);
              throw Error('synthetic rollback');
            }),
          /synthetic rollback/,
        );
        assert.ok(cabinetRead()[2] > cabinetBefore[2]);
        assert.ok(read()[2] > second[2], 'savepoint rollback advances all visited scopes');
        const released = read()[2];
        cabinet.transaction(() =>
          cabinet
            .prepare('INSERT INTO meta(key,value) VALUES(?,?)')
            .run('mvcc133-released', Buffer.from([10])),
        );
        const cabinetWritten = cabinetRead()[2];
        db.exec('ROLLBACK');
        assert.ok(read()[2] > released);
        assert.ok(
          cabinetRead()[2] > cabinetWritten,
          'outer rollback invalidates a released cabinet savepoint',
        );
        assert.equal(value.get('mvcc133-own'), undefined);
        assert.equal(
          cabinet.prepare('SELECT value FROM meta WHERE key=?').get('mvcc133-released'),
          undefined,
        );
        alias.close();
        cabinet.close();
      },
    );
    assert.deepEqual(
      (await f.admin.query('SELECT * FROM ' + TABLE + ' ORDER BY kind,store_id,domain')).rows,
      stateBefore,
      'business writes must not move contention into revision state',
    );
    assert.deepEqual(
      (
        await f.admin.query(
          'SELECT kind,store_id,revision FROM cartoteca_catalog.stores ORDER BY kind,store_id',
        )
      ).rows,
      catalogBefore,
      'business writes must not touch the common store revision',
    );
    await executor.close();
  },
);
