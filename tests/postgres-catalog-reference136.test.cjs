const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPostgresCoordinator,
} = require('../src/server/infrastructure/postgres/coordinator.cjs');
const {
  createCatalogMetadataCache136,
  validReference,
} = require('../src/server/infrastructure/postgres/catalog-metadata-cache136.cjs');
const scope = { kind: 'cabinet', storeId: 'synthetic' };
const reference = { catalogHash: 'a'.repeat(64), version: '2' };
const original = () => ({
  metadata: { version: 2, tables: {} },
  catalog_hash: reference.catalogHash,
  version: 2n,
  revision: 1n,
  exists: true,
});
function owner(handler) {
  const calls = [];
  const transport = {
    request(command) {
      calls.push(command);
      return handler(command, calls.length);
    },
    ready: async () => {},
    close: async () => {},
    closeSync() {},
    stats: () => ({}),
  };
  return { owner: createPostgresCoordinator({ allowBlocking: true, transport }), calls };
}

test('compact schema references retain independently attested metadata and fresh revision', () => {
  const f = owner((command, index) =>
    index === 1
      ? original()
      : {
          catalog_hash: reference.catalogHash,
          version: 2n,
          revision: 30n,
          exists: true,
          catalogReference: command.catalogReference,
        },
  );
  const first = f.owner.inspect(scope),
    second = f.owner.inspect(scope);
  assert.equal(f.calls[0].catalogReference, undefined);
  assert.deepEqual(f.calls[1].catalogReference, reference);
  assert.equal(second.metadata, first.metadata);
  assert.equal(second.revision, 30n);
  assert.equal(Object.isFrozen(second.metadata), true);
});
for (const [label, change] of [
  ['unknown hash', { catalogReference: { ...reference, catalogHash: 'b'.repeat(64) } }],
  ['wrong version', { catalogReference: { ...reference, version: '3' } }],
  ['simultaneous untrusted payload', { metadata: { version: 2, tables: { foreign: {} } } }],
  ['mismatched summary hash', { catalog_hash: 'b'.repeat(64) }],
  ['mismatched summary version', { version: 3n }],
])
  test('coordinator refuses a compact reply with ' + label, () => {
    const f = owner((command, index) =>
      index === 1
        ? original()
        : {
            catalog_hash: reference.catalogHash,
            version: 2n,
            revision: 30n,
            exists: true,
            catalogReference: command.catalogReference,
            ...change,
          },
    );
    f.owner.inspect(scope);
    assert.throws(() => f.owner.inspect(scope), { code: 'POSTGRES_CATALOG_INVALID' });
  });

test('an unsolicited reference cannot initialize a coordinator or cross schema kinds', () => {
  const f = owner(() => ({
    catalog_hash: reference.catalogHash,
    version: 2n,
    catalogReference: reference,
  }));
  assert.throws(() => f.owner.inspect(scope), { code: 'POSTGRES_CATALOG_INVALID' });
  const cache = createCatalogMetadataCache136();
  cache.rememberValidated(scope, original());
  assert.equal(cache.resolve('platform', reference), null);
  assert.equal(cache.resolve('cabinet', reference).version, 2);
});

test('references are closed, bounded, immutable schema identities only', () => {
  assert.equal(validReference(reference), true);
  for (const invalid of [
    null,
    [],
    'a',
    { ...reference, storeId: 'foreign' },
    { ...reference, version: 2 },
    { ...reference, version: '02' },
    { ...reference, version: '9'.repeat(10) },
    { ...reference, catalogHash: 'x'.repeat(64) },
  ])
    assert.equal(validReference(invalid), false);
});
