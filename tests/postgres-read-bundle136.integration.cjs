const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { queueFixture } = require('./helpers/postgres-queue134-fixture.cjs');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const {
  createPostgresCoordinator,
} = require('../src/server/infrastructure/postgres/coordinator.cjs');
const {
  OPERATION,
  MAX_IDS,
} = require('../src/server/infrastructure/postgres/cabinet-read-bundle136.cjs');
const denied = (error) => /^POSTGRES_/.test(error.code) && !error.outcomeUnknown;
const selection = (patientIds = [], serviceIds = []) => ({
  operation: OPERATION,
  patientIds,
  serviceIds,
});
function patient(id, suffix = '') {
  return {
    id,
    name: 'Synthetic ' + id,
    notes: suffix,
    createdBy: 'owner',
    visits: [0, 1].map((n) => ({
      id: id + '-v' + n,
      date: '2030-01-01',
      procedure: 'Synthetic',
      photos: [],
    })),
    appointments: [
      { id: id + '-a', date: '2030-01-02', time: '10:00', duration: 30, service: 'Synthetic' },
    ],
  };
}
async function storageFixture(t, cabinetVersion) {
  const f = await queueFixture(t, { cabinetVersion });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-read-bundle136-'));
  const stores = [];
  t.after(() => {
    for (const storage of stores) storage.close();
    if (
      path.dirname(root) !== path.resolve(os.tmpdir()) ||
      !path.basename(root).startsWith('cartoteca-read-bundle136-')
    )
      throw Error('Unexpected synthetic asset path.');
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  });
  fs.writeFileSync(path.join(root, 'postgresql-runtime.json'), JSON.stringify(f.identity.lineage), {
    flag: 'wx',
  });
  for (const row of f.identity.lineage.stores.filter((row) => row.kind === 'cabinet')) {
    const directory = path.resolve(root, row.relativeDirectory);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'encryption.key'), randomBytes(32), { flag: 'wx' });
  }
  function open(owner, index = 0) {
    const directory = index ? path.join(root, 'tenants', f.organizations[index]) : root;
    const storage = createStorage(directory, {
      cabinetSchema: cabinetVersion,
      databaseOwner: owner,
      databaseRoot: root,
      photoOrganizationId: f.organizations[index],
    });
    stores.push(storage);
    return storage;
  }
  const storage = open(f.a.owner);
  storage.write({
    revision: 0,
    patients: [patient('p-one'), patient('p-two')],
    services: [{ id: 's-one', name: 'Synthetic', price: 0 }],
  });
  const foreign = open(f.a.owner, 1);
  foreign.write({ revision: 0, patients: [patient('p-foreign')], services: [] });
  return { ...f, root, storage, foreign, openStorage: open };
}
for (const version of [1, 2])
  test(
    'native fixed read bundle preserves schema ' +
      version +
      ' storage semantics and repeatable snapshot',
    { timeout: 120000 },
    async (t) => {
      const f = await storageFixture(t, version),
        storage = f.storage;
      assert.equal(storage.db.catalog.version, version);
      const ids = ['p-two', 'missing', 'p-one', 'p-two'],
        services = ['s-one', 'missing', 's-one'];
      const legacy = storage.transaction(() => storage.readSelected(ids, services), 'DEFERRED');
      assert.deepEqual(storage.readSelected(ids, services), legacy);
      assert.deepEqual(
        legacy.patients.map((p) => p.id),
        ['p-two', 'p-one', 'p-two'],
      );
      assert.deepEqual(
        legacy.services.map((s) => s.id),
        ['s-one', 's-one'],
      );
      const repeated = storage.readSelected(['p-one', 'p-one']);
      repeated.patients[0].visits[0].procedure = 'Local mutation';
      assert.equal(repeated.patients[1].visits[0].procedure, 'Synthetic');
      assert.deepEqual(storage.readSelected(['p-foreign']).patients, []);
      assert.deepEqual(f.foreign.readSelected(['p-one']).patients, []);
      storage.transaction(() => {
        storage.set('revision', null);
        storage.set('initialized', false);
      });
      assert.deepEqual(storage.readSelected([], []), {
        patients: [],
        services: [],
        revision: null,
        initialized: false,
      });
      storage.transaction(() => {
        storage.set('revision', 1);
        storage.set('initialized', true);
      });

      const b = await f.open(),
        other = f.openStorage(b.owner);
      storage.readOnlySnapshot(() => {
        const before = storage.readSelected(['p-one'], ['s-one']);
        const next = other.readSelected(['p-one'], ['s-one']);
        next.patients[0].notes = 'Committed concurrently';
        other.write(next, { changedIds: { patients: ['p-one'], services: ['s-one'] } });
        assert.deepEqual(storage.readSelected(['p-one'], ['s-one']), before);
      });
      assert.equal(storage.readSelected(['p-one']).patients[0].notes, 'Committed concurrently');
      assert.equal(storage.readSelected(['p-one']).revision, 2);
      const before = storage.read();
      const sentinel = Error('Synthetic rollback');
      assert.throws(
        () =>
          storage.transaction(() => {
            const next = storage.readSelected(['p-one']);
            next.patients[0].notes = 'Must roll back';
            storage.write(next, {
              insideTransaction: true,
              changedIds: { patients: ['p-one'], services: [] },
            });
            throw sentinel;
          }),
        (error) => error === sentinel,
      );
      assert.deepEqual(storage.read(), before);

      // A real transport counts data operations, not a mocked storage implementation.
      const raw = await f.raw(),
        operations = [];
      const owner = createPostgresCoordinator({
        allowBlocking: true,
        revisionProfile: 3,
        transport: {
          ready: () => raw.ready(),
          stats: () => raw.stats(),
          closeSync() {},
          async close() {},
          request(command, options) {
            operations.push(command.op);
            return raw.request(command, options);
          },
        },
      });
      t.after(() => owner.closeSync());
      owner.verifyProfile(f.identity);
      const traced = f.openStorage(owner);
      operations.length = 0;
      assert.deepEqual(traced.readSelected(ids, services), storage.readSelected(ids, services));
      assert.deepEqual(operations, ['begin', 'cabinetReadBundle', 'commit']);
      operations.length = 0;
      traced.transaction(() => traced.readSelected(ids, services), 'DEFERRED');
      assert.equal(operations.includes('cabinetReadBundle'), false);
      assert.ok(
        operations.filter((operation) => operation === 'execute').length >= (version === 2 ? 5 : 4),
      );
      // An outer platform writer and inner cabinet snapshot are mixed frames.
      // Keep the fixed bundle closed while preserving normal selected-read/save semantics.
      const platform = owner.open(f.platform);
      platform.exec('BEGIN IMMEDIATE');
      try {
        operations.length = 0;
        const selected = traced.readSelected(ids, services);
        assert.deepEqual(selected, storage.readSelected(ids, services));
        assert.equal(operations.includes('cabinetReadBundle'), false);
        assert.ok(operations.includes('execute'));
        const next = traced.readSelected(['p-two']);
        next.patients[0].notes = 'Written through mixed transaction';
        traced.write(next, {
          changedIds: { patients: ['p-two'], services: [] },
        });
        assert.equal(
          traced.readSelected(['p-two']).patients[0].notes,
          'Written through mixed transaction',
        );
      } finally {
        platform.exec('ROLLBACK');
      }
      assert.equal(traced.readSelected(['p-two']).patients[0].notes, '');
      operations.length = 0;
      assert.equal(
        traced.readSelected(Array(MAX_IDS + 1).fill('p-one')).patients.length,
        MAX_IDS + 1,
      );
      assert.equal(operations.includes('cabinetReadBundle'), false);
    },
  );
test(
  'native worker independently rejects forged selection, scope, SQL and transaction modes',
  { timeout: 120000 },
  async (t) => {
    const f = await queueFixture(t),
      cabinet = f.a.c[0],
      scope = f.cabinets[0];
    assert.equal(f.cabinetCatalog.version, 2, 'Existing fixture default remains schema2');
    const native = await f.raw();
    const command = (extra = {}) => ({
      op: 'cabinetReadBundle',
      mutating: false,
      scope,
      selection: selection(),
      ...extra,
    });
    assert.throws(() => cabinet.readSelectedBundle([], []), denied);
    assert.throws(() => native.request(command()), denied);
    for (const mode of ['DEFERRED', 'IMMEDIATE']) {
      cabinet.exec('BEGIN ' + mode);
      try {
        assert.throws(() => cabinet.readSelectedBundle([], []), denied);
      } finally {
        cabinet.exec('ROLLBACK');
      }
      native.request({ op: 'begin', scope, mode });
      try {
        assert.throws(() => native.request(command()), denied);
      } finally {
        native.request({ op: 'rollback', scope });
      }
    }
    native.request({ op: 'begin', scope, mode: 'READONLY' });
    try {
      const forged = { ...f.cabinets[1], organizationId: f.organizations[0] };
      for (const malformed of [
        command({ mutating: true }),
        command({ sql: 'SELECT 1' }),
        command({ scope: f.platform }),
        command({ scope: f.cabinets[1] }),
        command({ scope: forged }),
        command({ selection: { ...selection(), operation: 'arbitrary' } }),
        command({ selection: { ...selection(), sql: 'DELETE FROM patients' } }),
        command({ selection: selection(Array(MAX_IDS + 1).fill('p')) }),
        command({ selection: selection([null]) }),
      ])
        assert.throws(() => native.request(malformed), denied);
      assert.deepEqual(native.request(command()).rows, []);
    } finally {
      native.request({ op: 'rollback', scope });
    }
    for (const mode of ['COMPOUND', 'QUEUEORG']) {
      native.request({
        op: 'begin',
        scope: f.platform,
        mode,
        ...(mode === 'COMPOUND'
          ? {
              compound: {
                operation: 'cabinet',
                organizationId: f.organizations[0],
                cabinetStoreId: scope.storeId,
              },
            }
          : { scopedQueue: { queueDomain: 'schedule', organizationId: f.organizations[0] } }),
      });
      native.request({ op: 'savepoint', scope, name: 'ct_sp_136', mode: 'READONLY' });
      try {
        assert.throws(() => native.request(command()), denied);
      } finally {
        native.request({ op: 'release', scope, name: 'ct_sp_136' });
        native.request({ op: 'rollback', scope: f.platform });
      }
    }
    assert.equal(native.stats().poisoned, false);
  },
);
