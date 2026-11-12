const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStorage } = require('../storage.cjs');
const { routes } = require('../src/server/modules/cabinet/queries.cjs');

const bootstrap = routes.find((route) => route.path === '/api/cabinet/bootstrap');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-bootstrap-cache-'));
  const storage = createStorage(dir);
  t.after(() => {
    if (storage.db.isOpen) storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const patients = Array.from({ length: 100 }, (_, i) => ({
    id: 'p' + String(i).padStart(3, '0'),
    name: 'Synthetic ' + String(i).padStart(3, '0'),
    phone: '',
    createdBy: i % 2 ? 'staff-a' : 'staff-b',
    visits: [],
    appointments: [],
  }));
  storage.write({
    revision: 0,
    patients,
    services: [{ id: 'service', name: 'Synthetic service', price: 100 }],
  });
  let decodes = 0;
  let summaryReads = 0;
  const summaryRows = storage.indexes.summaryRows;
  storage.indexes.summaryRows = (...args) => {
    summaryReads++;
    return summaryRows(...args);
  };
  const tracked = {
    ...storage,
    decode(value) {
      decodes++;
      return storage.decode(value);
    },
  };
  const owner = { organizationId: 'synthetic-org', accountId: 'owner', role: 'owner' };
  const context = (current = owner, query = 'paged=1&limit=20&today=2030-01-01') => ({
    current,
    url: new URL('http://test/?' + query),
    tenantStore: () => tracked,
    platform: {
      organizationTimeZone: () => 'Europe/Moscow',
      personalEvents: { view: () => ({ personalEvents: [], personalRevision: 0 }) },
      serviceGroups: () => [],
      serviceCatalog: () => [],
    },
    json(_res, status, value) {
      assert.equal(status, 200);
      return value;
    },
  });
  return { storage, tracked, patients, owner, context, counts: () => ({ decodes, summaryReads }) };
}

test('paged bootstrap reuses the bounded directory cache inside the overview snapshot', async (t) => {
  const f = fixture(t);
  const original = f.tracked.overview;
  let snapshots = 0;
  f.tracked.overview = (current, project) => {
    assert.equal(typeof project, 'function');
    return original(current, (metadata) => {
      assert.equal(f.storage.db.isTransaction, true);
      assert.equal(Object.hasOwn(metadata, 'directory'), false);
      snapshots++;
      return project(metadata);
    });
  };
  f.storage.indexes.summaries = () => {
    throw Error('Paged bootstrap must not decode the unpaged directory');
  };
  const first = await bootstrap.handle(f.context());
  assert.equal(first.directory.length, 20);
  assert.equal(first.total, 100);
  assert.equal(first.pagedReads, true);
  assert.equal(first.services[0].name, 'Synthetic service');
  assert.deepEqual(first.patients, []);
  assert.deepEqual(f.counts(), { decodes: 100, summaryReads: 1 });
  const next = await bootstrap.handle(f.context());
  assert.deepEqual({ ...next, nextCursor: null }, { ...first, nextCursor: null });
  assert.deepEqual(
    f.storage.decode(Buffer.from(next.nextCursor, 'base64url')),
    f.storage.decode(Buffer.from(first.nextCursor, 'base64url')),
  );
  assert.deepEqual(f.counts(), { decodes: 100, summaryReads: 1 });
  assert.equal(snapshots, 2);
  const otherOwner = await bootstrap.handle(f.context({ ...f.owner, accountId: 'other-owner' }));
  assert.deepEqual(otherOwner.directory, first.directory);
  assert.deepEqual(f.counts(), { decodes: 100, summaryReads: 1 });
});

test('paged bootstrap observes changed rows, rejects stale cursors and separates staff and tenant scopes', async (t) => {
  const f = fixture(t);
  const first = await bootstrap.handle(f.context());
  const changed = { ...f.patients[12], name: 'Changed synthetic name' };
  f.storage.write(
    { revision: 1, patients: [changed], services: [] },
    { changedIds: { patients: [changed.id], services: [] } },
  );
  const next = await bootstrap.handle(f.context());
  assert.equal(next.revision, 2);
  assert.deepEqual(f.counts(), { decodes: 101, summaryReads: 2 });
  assert.ok(next.directory.some((row) => row.name === changed.name));
  await assert.rejects(
    async () => bootstrap.handle(
      f.context(f.owner, 'paged=1&limit=20&today=2030-01-01&cursor=' + first.nextCursor),
    ),
    { status: 409 },
  );
  for (const staffId of ['staff-a', 'staff-b']) {
    const page = await bootstrap.handle(
      f.context({ ...f.owner, role: 'cosmetologist', accountId: staffId }),
    );
    assert.equal(page.total, 50);
    assert.ok(
      page.directory.every(
        (row) => Number(row.id.slice(1)) % 2 === (staffId === 'staff-a' ? 1 : 0),
      ),
    );
  }
  const warm = f.counts();
  await bootstrap.handle(f.context({ ...f.owner, role: 'cosmetologist', accountId: 'staff-a' }));
  assert.deepEqual(f.counts(), warm);
  await bootstrap.handle(f.context({ ...f.owner, organizationId: 'different-scope' }));
  assert.equal(f.counts().summaryReads, warm.summaryReads + 1);
});

test('overview services stay fresh and isolated from returned drafts; unpaged bootstrap retains its response', async (t) => {
  const f = fixture(t);
  const first = await bootstrap.handle(f.context());
  first.services[0].name = 'Changed only in a returned draft';
  const warm = await bootstrap.handle(f.context());
  assert.equal(warm.services[0].name, 'Synthetic service');
  f.storage.write(
    {
      revision: 1,
      patients: [],
      services: [{ id: 'service', name: 'Updated service', price: 200 }],
    },
    { changedIds: { patients: [], services: ['service'] } },
  );
  const updated = await bootstrap.handle(f.context());
  assert.equal(updated.services[0].name, 'Updated service');
  assert.equal(updated.revision, 2);
  const unpaged = await bootstrap.handle(f.context(f.owner, ''));
  assert.equal(unpaged.directory.length, 100);
  assert.equal(unpaged.pagedReads, undefined);
  assert.deepEqual(unpaged.services, updated.services);
  assert.deepEqual(unpaged.patients, []);
  assert.equal(f.storage.db.isTransaction, false);
  assert.throws(
    () =>
      f.storage.overview(f.owner, () => {
        throw Error('Synthetic projection failure');
      }),
    /projection failure/,
  );
  assert.equal(f.storage.db.isTransaction, false);
});
