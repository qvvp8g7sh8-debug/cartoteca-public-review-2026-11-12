const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createStorage } = require('../storage.cjs');
const { migrateCabinetRecords } = require('../src/server/migrations/002-cabinet-records.cjs');
const {
  createOperationCabinet,
} = require('../src/server/infrastructure/postgres/read-operation-cabinet145.cjs');
const {
  prepareCabinetRead,
} = require('../src/server/infrastructure/postgres/read-operation-route145.cjs');
const { directoryPage } = require('../src/server/modules/cabinet/directory.cjs');
const { cabinetForUser } = require('../src/server/modules/access/cabinet-policy.cjs');

// Real SQLite executes the unchanged projection SQL as a parity oracle. The
// operation adapter intentionally rejects every unprepared synchronous read.
// Physical PG/RLS/concurrent-snapshot coverage belongs to the PG integration set.
async function fixture(t, version) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-op145-'));
  let source = createStorage(directory);
  let operation;
  t.after(() => {
    operation?.close();
    source.close();
    if (
      path.dirname(directory) !== path.resolve(os.tmpdir()) ||
      !path.basename(directory).startsWith('cartoteca-op145-')
    )
      throw Error('Unexpected fixture directory');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  source.write({
    revision: 0,
    services: [],
    patients: ['p', 'q'].map((id) => ({
      id,
      name: 'Синтетический ' + id,
      createdBy: 'staff',
      phone: '+79990000000',
      visits: [
        { id: id + '-v', date: '2020-01-01', procedure: 'Synthetic', staffId: 'other', photos: [] },
      ],
      appointments: ['staff', 'other'].map((staff, n) => ({
        id: id + '-a' + n,
        date: '2035-01-01',
        time: n ? '23:30' : '09:00',
        staffId: staff,
        duration: 60,
        service: 'Synthetic',
        notes: 'Protected ' + staff,
      })),
    })),
  });
  if (version === 2) {
    migrateCabinetRecords(source);
    source.close();
    source = createStorage(directory, { cabinetSchema: 2 });
  }
  const key = fs.readFileSync(path.join(directory, 'encryption.key'));
  const loaded = new Map();
  let requests = 0,
    active = true;
  const id = (sql, method, args) => JSON.stringify([sql, method, args]);
  const assertActive = () => {
    if (!active) throw Error('Snapshot closed');
  };
  const db = {
    dialect: 'postgres',
    revisionProfile: 3,
    catalog: {
      version,
      tables: Object.fromEntries(
        source.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((row) => [row.name, {}]),
      ),
    },
    isTransaction: true,
    transactionIntent: 'READONLY',
    snapshotVersion: () => {
      assertActive();
      return '1:10:';
    },
    prepare(sql) {
      const read = (method, args) => {
        assertActive();
        const selected = id(sql, method, args);
        if (!loaded.has(selected)) throw Error('Unprepared SQL');
        return structuredClone(loaded.get(selected));
      };
      return {
        readRequest: (method, args) => ({ sql, method, args }),
        all: (...args) => read('all', args),
        get: (...args) => read('get', args),
        run: () => {
          throw Error('Read-only');
        },
      };
    },
    async prefetchAll(tokens) {
      assertActive();
      for (const { sql, method, args } of tokens) {
        const selected = id(sql, method, args);
        if (!loaded.has(selected)) {
          requests++;
          loaded.set(selected, source.db.prepare(sql)[method](...args));
        }
      }
    },
  };
  operation = await createOperationCabinet({
    db,
    directory,
    encode: source.encode,
    decode: source.decode,
    hash: (value) => crypto.createHmac('sha256', key).update(value).digest('hex'),
  });
  return {
    source,
    operation,
    requests: () => requests,
    cancel: () => {
      active = false;
    },
  };
}
for (const version of [1, 2]) {
  test(`operation schema${version}: selected profiles/history/duplicates equal canonical reads without implicit SQL`, async (t) => {
    const f = await fixture(t, version);
    assert.throws(() => f.operation.readSelected(['p']), /not prepared/);
    const ids = ['q', 'missing', 'p', 'q'];
    assert.deepEqual(await f.operation.readSelectedAsync(ids), f.source.readSelected(ids));
    const before = f.requests();
    assert.deepEqual(f.operation.readSelected(ids), f.source.readSelected(ids));
    assert.equal(f.requests(), before);
    assert.deepEqual(
      await f.operation.readSelectedAppointmentsAsync(ids),
      f.source.readSelectedAppointments(ids),
    );
    assert.throws(() => f.operation.transaction(() => {}, 'IMMEDIATE'), /read-only/);
  });
  test(`operation schema${version}: calendar details/occupancy/month preserve names, audience and midnight overlap`, async (t) => {
    const f = await fixture(t, version);
    for (const staffId of ['', 'staff', 'other'])
      for (const projection of ['details', 'occupancy', 'overview']) {
        const options = { staffId, projection, overview: { from: '2035-01-01', to: '2035-01-31' } };
        const actual = await f.operation.calendarSnapshotAsync('2035-01-02', '2035-01-02', options);
        assert.deepEqual(actual, f.source.calendarSnapshot('2035-01-02', '2035-01-02', options));
        assert.deepEqual(f.operation.calendarSnapshot('2035-01-02', '2035-01-02', options), actual);
        if (projection === 'occupancy')
          assert.equal(JSON.stringify(actual.appointments).includes('Protected'), false);
      }
  });
  test(`operation schema${version}: explicit patient and directory preparation preserves clinical visibility`, async (t) => {
    const f = await fixture(t, version),
      current = { organizationId: 'org', accountId: 'staff', role: 'cosmetologist' };
    const patient = await prepareCabinetRead({
      storage: f.operation,
      current,
      url: new URL('http://test/api/cabinet/patient?id=p'),
    });
    assert.deepEqual(
      patient.patients,
      cabinetForUser(current, f.source.readSelected(['p'])).patients,
    );
    assert.equal(patient.patients[0].visits.length, 0);
    assert.equal(patient.patients[0].appointments.length, 1);
    const url = new URL('http://test/api/cabinet/directory?limit=100');
    await prepareCabinetRead({ storage: f.operation, current, url, timeZone: 'Europe/Moscow' });
    assert.deepEqual(
      directoryPage(f.operation, current, url),
      directoryPage(f.source, current, url),
    );
    await assert.rejects(
      prepareCabinetRead({
        storage: f.operation,
        current,
        url: new URL('http://test/api/cabinet/patient?id=absent'),
      }),
      { status: 404 },
    );
    f.cancel();
    assert.throws(() => f.operation.readOnlySnapshot(() => true), /Snapshot closed/);
  });
}
