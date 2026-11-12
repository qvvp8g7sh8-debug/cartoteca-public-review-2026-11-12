const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { queueFixture } = require('./helpers/postgres-queue134-fixture.cjs');
const {
  prepareReadScopes163,
} = require('../src/server/infrastructure/postgres/read-scope-prepare163.cjs');
const {
  verifyReadScopes163,
} = require('../src/server/infrastructure/postgres/read-scope-schema163.cjs');
const { TABLE } = require('../src/server/infrastructure/postgres/read-scope-sql163.cjs');

test(
  '163 scoped clocks follow direct DML, transaction rollback and current-data inverse without a global tenant clock',
  { timeout: 120000 },
  async (t) => {
    const f = await queueFixture(t, { cabinetVersion: 1 });
    const role = f.runtime.application.user;
    assert.equal(await verifyReadScopes163(f.admin, role), null);
    await f.admin.query('BEGIN');
    const prepared = await prepareReadScopes163(f.admin, role);
    await f.admin.query('COMMIT');
    assert.equal(prepared.prepared, true);
    assert.equal(prepared.clinicalRowsChanged, 0);
    assert.ok(await verifyReadScopes163(f.admin, role));
    const stamps = async () =>
      (
        await f.admin.query(
          `SELECT kind,store_id,scope_id,epoch::text,revision::text FROM ${TABLE} ORDER BY kind,store_id,scope_id`,
        )
      ).rows;
    const find = (rows, org) => rows.find((r) => r.kind === 'platform' && r.scope_id === org);
    const before = await stamps();
    const app = new Client(f.runtime.application);
    app.on('error', () => {});
    await app.connect();
    t.after(() => app.end());
    await app.query(
      "SELECT set_config('cartoteca.kind','platform',false),set_config('cartoteca.store_id',$1,false)",
      [f.platform.storeId],
    );
    const visible = (await app.query(`SELECT kind,store_id FROM ${TABLE}`)).rows;
    assert.ok(visible.length);
    assert.ok(visible.every((r) => r.kind === 'platform' && r.store_id === f.platform.storeId));
    await assert.rejects(
      app.query(`UPDATE ${TABLE} SET revision=revision+1`),
      (e) => e.code === '42501',
    );
    await app.query('BEGIN');
    for (let i = 0; i < 2; i++)
      await app.query(
        'UPDATE cartoteca_platform.organizations SET slug=slug WHERE _store_id=$1 AND id=$2',
        [f.platform.storeId, f.organizations[0]],
      );
    await app.query('COMMIT');
    const changed = await stamps();
    assert.equal(
      BigInt(find(changed, f.organizations[0]).revision),
      BigInt(find(before, f.organizations[0]).revision) + 1n,
    );
    assert.deepEqual(find(changed, f.organizations[1]), find(before, f.organizations[1]));
    assert.deepEqual(
      changed.find((r) => r.kind === 'platform' && r.scope_id === '*'),
      before.find((r) => r.kind === 'platform' && r.scope_id === '*'),
    );
    await app.query('BEGIN');
    await app.query(
      'UPDATE cartoteca_platform.organizations SET slug=slug WHERE _store_id=$1 AND id=$2',
      [f.platform.storeId, f.organizations[0]],
    );
    await app.query('ROLLBACK');
    assert.deepEqual(await stamps(), changed);
    await f.admin.query('BEGIN');
    await f.admin.query(
      'ALTER TABLE cartoteca_platform.organizations DISABLE TRIGGER ct_read_scope163',
    );
    await assert.rejects(
      verifyReadScopes163(f.admin, role),
      (e) => e.code === 'POSTGRES_READ_SCOPE_COMPONENT_INVALID',
    );
    await f.admin.query('ROLLBACK');
    await app.query(
      'UPDATE cartoteca_platform.organizations SET slug=$3 WHERE _store_id=$1 AND id=$2',
      [f.platform.storeId, f.organizations[0], 'current-data-163'],
    );
    await f.admin.query('BEGIN');
    const inverse = await prepareReadScopes163(f.admin, role, { rollback: true });
    await f.admin.query('COMMIT');
    assert.equal(inverse.prepared, false);
    assert.equal(await verifyReadScopes163(f.admin, role), null);
    assert.equal(
      (
        await app.query(
          'SELECT slug FROM cartoteca_platform.organizations WHERE _store_id=$1 AND id=$2',
          [f.platform.storeId, f.organizations[0]],
        )
      ).rows[0].slug,
      'current-data-163',
    );
  },
);
