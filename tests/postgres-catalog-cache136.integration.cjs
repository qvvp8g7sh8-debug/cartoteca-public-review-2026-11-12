const test = require('node:test');
const assert = require('node:assert/strict');
const { queueFixture } = require('./helpers/postgres-queue134-fixture.cjs');
const { digest } = require('../src/server/infrastructure/postgres/catalog-sqlite.cjs');

test(
  'native catalog reuse retains fresh revisions, corruption rejection and tenant scope',
  { timeout: 120000 },
  async (t) => {
    const f = await queueFixture(t),
      raw = await f.raw(),
      scope = f.cabinets[0];
    const inspect = (value = scope) =>
      raw.request({ op: 'inspect', scope: value, revisionProfile: 3, version: 2 });
    const original = inspect();
    assert.deepEqual(inspect().metadata, original.metadata);
    const reference = { catalogHash: original.catalog_hash, version: '2' };
    const compactInspect = () =>
      raw.request({
        op: 'inspect',
        scope,
        revisionProfile: 3,
        version: 2,
        catalogReference: reference,
      });
    const compact = compactInspect();
    assert.equal(Object.hasOwn(compact, 'metadata'), false);
    assert.deepEqual(compact.catalogReference, reference);
    const fallback = raw.request({
      op: 'inspect',
      scope,
      revisionProfile: 3,
      version: 2,
      catalogReference: { ...reference, catalogHash: 'f'.repeat(64) },
    });
    assert.deepEqual(fallback.metadata, original.metadata);
    assert.throws(
      () =>
        raw.request({
          op: 'inspect',
          scope,
          revisionProfile: 3,
          catalogReference: { ...reference, extra: true },
        }),
      { code: 'POSTGRES_CATALOG_INVALID' },
    );
    f.a.c[0]
      .prepare('INSERT INTO meta(key,value) VALUES(?,?)')
      .run('fresh-revision', Buffer.from('synthetic'));
    // PG3 intentionally avoids the legacy hot revision counter on every write.
    // Change this synthetic catalog counter explicitly to verify fresh inspection.
    await f.admin.query(
      'UPDATE cartoteca_catalog.stores SET revision=revision+1 WHERE kind=$1 AND store_id=$2',
      [scope.kind, scope.storeId],
    );
    assert.equal(BigInt(inspect().revision), BigInt(original.revision) + 1n);
    assert.equal(BigInt(compactInspect().revision), BigInt(original.revision) + 1n);
    assert.throws(() => inspect({ ...scope, organizationId: f.organizations[1] }));
    const restore = () =>
      f.admin.query(
        'UPDATE cartoteca_catalog.stores SET metadata=$1::jsonb,catalog_hash=$2 WHERE kind=$3 AND store_id=$4',
        [JSON.stringify(original.metadata), original.catalog_hash, scope.kind, scope.storeId],
      );
    try {
      await f.admin.query(
        "UPDATE cartoteca_catalog.stores SET metadata=jsonb_set(metadata,'{unexpected}', 'true'::jsonb) WHERE kind=$1 AND store_id=$2",
        [scope.kind, scope.storeId],
      );
      assert.throws(inspect, { code: 'POSTGRES_CATALOG_INVALID' });
      assert.throws(compactInspect, { code: 'POSTGRES_CATALOG_INVALID' });
      await restore();
      assert.deepEqual(inspect().metadata, original.metadata);
      const changed = { ...original.metadata, synthetic136: true };
      await f.admin.query(
        'UPDATE cartoteca_catalog.stores SET metadata=$1::jsonb,catalog_hash=$2 WHERE kind=$3 AND store_id=$4',
        [JSON.stringify(changed), digest(changed), scope.kind, scope.storeId],
      );
      assert.equal(inspect().metadata.synthetic136, true);
      assert.equal(inspect().metadata.synthetic136, true);
    } finally {
      await restore();
    }
    assert.deepEqual(inspect().metadata, original.metadata);
    assert.equal(raw.stats().poisoned, false);
  },
);
