const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const {
  createOperationCryptoCache,
} = require('../src/server/infrastructure/postgres/read-operation-crypto145.cjs');
const {
  operationScope,
} = require('../src/server/infrastructure/postgres/read-operation-context145.cjs');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cartoteca-read-key145-'));
  const platformStoreId = randomUUID(),
    rootCabinetStoreId = randomUUID(),
    org = randomUUID();
  const marker = {
    version: 1,
    backend: 'postgres',
    migrationId: randomUUID(),
    platformStoreId,
    rootCabinetStoreId,
    budgetStoreId: null,
    notificationSchema: 19,
    cabinetSchema: 1,
    cabinetTemplates: { 1: 'a'.repeat(64), 2: 'b'.repeat(64) },
    stores: [
      {
        kind: 'platform',
        storeId: platformStoreId,
        organizationId: null,
        relativeDirectory: 'platform',
        schemaVersion: 19,
      },
      {
        kind: 'cabinet',
        storeId: rootCabinetStoreId,
        organizationId: org,
        relativeDirectory: '.',
        schemaVersion: 1,
      },
    ],
  };
  await fs.mkdir(path.join(root, 'platform'));
  await fs.writeFile(path.join(root, 'postgresql-runtime.json'), JSON.stringify(marker));
  await fs.writeFile(path.join(root, 'platform/platform.key'), randomBytes(32));
  await fs.writeFile(path.join(root, 'encryption.key'), randomBytes(32));
  let cache;
  t.after(async () => {
    cache?.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('cartoteca-read-key145-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  cache = await createOperationCryptoCache(root, marker, { maximumEntries: 2 });
  return { root, marker, cache, org };
}
test('async key cache copies operation keys and stays bounded without runtime writes', async (t) => {
  const f = await fixture(t);
  let active = true;
  const check = () => {
    if (!active) throw Object.assign(Error('cancelled'), { status: 499 });
  };
  const one = await f.cache.forOperation(f.root, check),
    two = await f.cache.forOperation(f.root, check);
  assert.equal(one.cabinet.keyGeneration196, two.cabinet.keyGeneration196);
  assert.equal(Object.keys(one.cabinet.keyGeneration196).length, 0);
  assert.ok(Object.isFrozen(one.cabinet.keyGeneration196));
  assert.notEqual(one.platform.keyGeneration196, one.cabinet.keyGeneration196);
  assert.deepEqual(two.cabinet.decode(one.cabinet.encode({ notes: 'synthetic' })), {
    notes: 'synthetic',
  });
  assert.equal(f.cache.stats().reads, 2);
  const other = path.join(f.root, 'tenant');
  await fs.mkdir(other);
  await fs.writeFile(path.join(other, 'encryption.key'), randomBytes(32));
  await f.cache.forOperation(other, check);
  assert.equal(f.cache.stats().entries, 2);
  const reloaded = await f.cache.forOperation(f.root, check);
  assert.notEqual(reloaded.cabinet.keyGeneration196, one.cabinet.keyGeneration196);
  assert.deepEqual(
    one.cabinet.decode(two.cabinet.encode({ value: 1 })),
    { value: 1 },
    'LRU eviction cannot zero a live operation key',
  );
  active = false;
  assert.throws(() => one.cabinet.encode({}), { status: 499 });
});
test('cached missing, hardlinked and replaced key assets fail closed', async (t) => {
  const f = await fixture(t);
  await f.cache.forOperation(f.root, () => {});
  const file = path.join(f.root, 'encryption.key'),
    link = path.join(f.root, 'key-link');
  await fs.link(file, link);
  await assert.rejects(
    f.cache.forOperation(f.root, () => {}),
    { code: 'POSTGRES_READ_ASSETS_CHANGED' },
  );
  await fs.unlink(link);
  await fs.writeFile(file, randomBytes(32));
  await assert.rejects(
    f.cache.forOperation(f.root, () => {}),
    { code: 'POSTGRES_READ_ASSETS_CHANGED' },
  );
  await fs.unlink(file);
  await assert.rejects(
    f.cache.forOperation(f.root, () => {}),
    { code: 'POSTGRES_READ_ASSETS_CHANGED' },
  );
});
test('runtime marker changes invalidate the cache; ambiguous cabinet lineage cannot select a different store', async (t) => {
  const f = await fixture(t);
  assert.equal(operationScope(f.marker, f.org).scope.storeId, f.marker.rootCabinetStoreId);
  f.marker.stores.push({
    kind: 'cabinet',
    storeId: randomUUID(),
    organizationId: f.org,
    relativeDirectory: 'tenants/' + f.org,
    schemaVersion: 1,
  });
  assert.equal(operationScope(f.marker, f.org).unsupported, 'ambiguous-cabinet-lineage');
  await fs.appendFile(path.join(f.root, 'postgresql-runtime.json'), '\n');
  await assert.rejects(
    f.cache.forOperation(f.root, () => {}),
    { code: 'POSTGRES_READ_ASSETS_CHANGED' },
  );
});
