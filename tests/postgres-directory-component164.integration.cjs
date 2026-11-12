const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, createHmac } = require('node:crypto');
const { queueFixture } = require('./helpers/postgres-queue134-fixture.cjs');
const { codec } = require('../src/server/migrations/prepare-cabinet-records.cjs');
const {
  verifyDirectory164,
  prepareDirectory164,
} = require('../src/server/infrastructure/postgres/directory-component164.cjs');
const {
  prepareReadScopes163,
} = require('../src/server/infrastructure/postgres/read-scope-prepare163.cjs');
const {
  verifyReadScopes163,
} = require('../src/server/infrastructure/postgres/read-scope-schema163.cjs');
const {
  projectionKey,
  READY_KEY,
  createDirectoryProjectionWriter164,
} = require('../src/server/infrastructure/cabinet-directory-projection164.cjs');
test(
  '164 explicit encrypted adjunct preserves direct DML, rollback, closed attestation and current-data inverse with163 clocks',
  { timeout: 120000 },
  async (t) => {
    const f = await queueFixture(t, { cabinetVersion: 2 }),
      role = f.runtime.application.user;
    const key = randomBytes(32),
      ciphers = {
        ...codec(key),
        hash: (value) => createHmac('sha256', key).update(value).digest('hex'),
      };
    const store = f.a.c[0],
      scope = f.cabinets[0],
      source = {
        id: 'synthetic-patient',
        name: 'Synthetic owner',
        phone: '+79001234567',
        visitCount: 7,
        lastVisit: { date: '2030-01-01', procedure: 'Synthetic' },
        appointments: [{ id: 'synthetic-a', date: '2035-01-01', service: 'Synthetic' }],
      };
    const put = store.prepare(
      'INSERT INTO cabinet_summaries(patient_id,audience,value)VALUES(?,?,?) ON CONFLICT(patient_id,audience) DO UPDATE SET value=excluded.value',
    );
    const cipher = ciphers.encode(source);
    put.run(source.id, '*', cipher);
    await f.admin.query('BEGIN');
    await prepareReadScopes163(f.admin, role);
    await f.admin.query('COMMIT');
    const before163 = await verifyReadScopes163(f.admin, role);
    assert.equal(await verifyDirectory164(f.admin, role), null);
    await f.admin.query('BEGIN');
    const prepared = await prepareDirectory164(f.admin, role, {
      stores: [{ storeId: scope.storeId, ciphers }],
    });
    await f.admin.query('COMMIT');
    assert.equal(prepared.prepared, true);
    assert.equal(prepared.summaries, 1);
    assert.equal(prepared.clinicalRowsChanged, 0);
    assert.deepEqual(await verifyReadScopes163(f.admin, role), before163);
    const sidecarKey = projectionKey(source.id, '*');
    const get = (key) => store.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value;
    const preparedBytes = get(sidecarKey);
    assert.ok(preparedBytes);
    assert.doesNotMatch(preparedBytes.toString(), /Synthetic|2035|7900/);
    assert.deepEqual(ciphers.decode(get(READY_KEY)), { version: 1 });
    const projection = ciphers.decode(preparedBytes);
    assert.equal(projection.sourceHash, ciphers.hash(cipher));
    assert.deepEqual(projection.row.appointments, [{ date: '2035-01-01' }]);
    store.exec('BEGIN IMMEDIATE');
    put.run(source.id, '*', ciphers.encode({ ...source, visitCount: 8 }));
    assert.equal(get(sidecarKey), undefined);
    store.exec('ROLLBACK');
    assert.deepEqual(get(sidecarKey), preparedBytes);
    const changed = ciphers.encode({ ...source, visitCount: 123 });
    put.run(source.id, '*', changed);
    assert.equal(get(sidecarKey), undefined);
    assert.deepEqual(
      store
        .prepare("SELECT value FROM cabinet_summaries WHERE patient_id=? AND audience='*'")
        .get(source.id).value,
      changed,
    );
    const writer = createDirectoryProjectionWriter164({
      prepare: store.prepare.bind(store),
      ...ciphers,
    });
    writer.write({ ...source, visitCount: 123 }, '*', changed);
    assert.ok(get(sidecarKey));
    store
      .prepare("DELETE FROM cabinet_summaries WHERE patient_id=? AND audience='*'")
      .run(source.id);
    assert.equal(get(sidecarKey), undefined);
    put.run(source.id, '*', changed);
    writer.write({ ...source, visitCount: 123 }, '*', changed);
    await f.admin.query('BEGIN');
    await f.admin.query(
      'ALTER TABLE cartoteca_cabinet.cabinet_summaries DISABLE TRIGGER ct_directory164',
    );
    await assert.rejects(
      verifyDirectory164(f.admin, role),
      (error) => error.code === 'POSTGRES_DIRECTORY_COMPONENT_INVALID',
    );
    await f.admin.query('ROLLBACK');
    await f.admin.query('BEGIN');
    const inverse = await prepareDirectory164(f.admin, role, { rollback: true });
    await f.admin.query('COMMIT');
    assert.equal(inverse.prepared, false);
    assert.equal(await verifyDirectory164(f.admin, role), null);
    assert.equal(get(sidecarKey), undefined);
    assert.equal(get(READY_KEY), undefined);
    assert.deepEqual(
      store
        .prepare("SELECT value FROM cabinet_summaries WHERE patient_id=? AND audience='*'")
        .get(source.id).value,
      changed,
    );
    assert.deepEqual(await verifyReadScopes163(f.admin, role), before163);
  },
);
