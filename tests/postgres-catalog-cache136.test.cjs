'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createCatalogMetadataCache136,
} = require('../src/server/infrastructure/postgres/catalog-metadata-cache136.cjs');
const scope = { kind: 'cabinet', storeId: 'synthetic-a' };
const record = (hash = 'a', version = 2, extra = {}) => ({
  metadata: { version, tables: { patients: { columns: [{ name: 'id' }] } } },
  catalog_hash: hash.repeat(64),
  version: BigInt(version),
  revision: 1n,
  ...extra,
});
const matcher = (row, calls) => async (sql, values) => {
  calls.push({ sql, values });
  return { rows: row ? [row] : [] };
};

test('a verified catalog hit compares fresh SQL metadata and keeps the fresh revision', async () => {
  const cache = createCatalogMetadataCache136(),
    original = record(),
    calls = [];
  const metadata = cache.rememberValidated(scope, original);
  const result = await cache.read(
    matcher(
      { catalog_matches: true, catalog_hash: original.catalog_hash, version: 2n, revision: 42n },
      calls,
    ),
    scope,
    2,
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /metadata=\$3::jsonb/);
  assert.deepEqual(JSON.parse(calls[0].values[2]), original.metadata);
  assert.deepEqual(calls[0].values.slice(0, 2), ['cabinet', 'synthetic-a']);
  assert.equal(result.metadataVerified, true);
  assert.equal(result.result.rows[0].metadata, metadata);
  assert.equal(result.result.rows[0].revision, 42n);
  assert.equal('catalog_matches' in result.result.rows[0], false);
  assert.throws(() => metadata.tables.patients.columns.push({ name: 'untrusted' }), TypeError);
});

for (const [label, changed] of [
  ['metadata differs despite the same hash', { catalog_matches: false }],
  ['hash changed despite JSON equality', { catalog_hash: 'b'.repeat(64) }],
  ['version changed despite JSON equality', { version: 3n }],
])
  test(label + ' requires the full existing validation path', async () => {
    const cache = createCatalogMetadataCache136(),
      original = record(),
      calls = [];
    cache.rememberValidated(scope, original);
    const full = record('b', 3);
    const result = await cache.read(
      async (sql, values) => {
        calls.push({ sql, values });
        return {
          rows:
            calls.length === 1
              ? [
                  {
                    catalog_matches: true,
                    catalog_hash: original.catalog_hash,
                    version: 2n,
                    revision: 10n,
                    ...changed,
                  },
                ]
              : [full],
        };
      },
      scope,
      2,
    );
    assert.equal(calls.length, 2);
    assert.match(calls[1].sql, /^SELECT metadata,catalog_hash,revision,version/);
    assert.equal(result.metadataVerified, false);
    assert.equal(result.result.rows[0], full);
  });

test('first lookup and another kind or explicit version never borrow an unrelated schema', async () => {
  const cache = createCatalogMetadataCache136(),
    calls = [],
    original = record();
  assert.equal((await cache.read(matcher(original, calls), scope, 2)).metadataVerified, false);
  cache.rememberValidated(scope, original);
  await cache.read(matcher(original, calls), { kind: 'platform', storeId: 'synthetic-a' }, 2);
  await cache.read(matcher(original, calls), scope, 3);
  assert.ok(calls.every(({ sql }) => !sql.includes('catalog_matches')));
});

test('an absent store stays absent and is never synthesized by a schema hit', async () => {
  const cache = createCatalogMetadataCache136(),
    calls = [];
  cache.rememberValidated(scope, record());
  const result = await cache.read(matcher(null, calls), { ...scope, storeId: 'absent' }, 2);
  assert.equal(result.metadataVerified, false);
  assert.deepEqual(result.result.rows, []);
  assert.equal(calls.length, 1);
});

test('schema interning is limited to sixteen validated descriptions and evicts oldest first', async () => {
  const cache = createCatalogMetadataCache136();
  for (let i = 1; i <= 17; i++) cache.rememberValidated(scope, record(String(i), i));
  const calls = [];
  await cache.read(matcher(record('1', 1), calls), scope, 1);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].sql.includes('catalog_matches'));
  const current = record('17', 17),
    hits = [];
  await cache.read(matcher({ ...current, catalog_matches: true }, hits), scope, 17);
  assert.match(hits[0].sql, /catalog_matches/);
});

test('the byte budget refuses an oversized schema instead of retaining it', async () => {
  const cache = createCatalogMetadataCache136();
  cache.rememberValidated(
    scope,
    record('a', 2, { metadata: { version: 2, large: 'x'.repeat(8 * 1024 * 1024) } }),
  );
  const calls = [];
  await cache.read(matcher(record(), calls), scope, 2);
  assert.ok(!calls[0].sql.includes('catalog_matches'));
});
