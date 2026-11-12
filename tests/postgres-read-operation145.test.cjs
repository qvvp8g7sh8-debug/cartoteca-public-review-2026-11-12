const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalSqliteSchema,
} = require('../src/server/infrastructure/postgres/catalog-canonical.cjs');
const {
  createOperationRows,
} = require('../src/server/infrastructure/postgres/read-operation-rows145.cjs');
const {
  isPostgresReadOperation,
} = require('../src/server/infrastructure/postgres/read-operation-routes145.cjs');
const scope = { kind: 'cabinet', storeId: '00000000-0000-4000-8000-000000000001' };
test('operation rows require explicit preparation and never replay a callback', async () => {
  let calls = 0,
    alive = true;
  const materialized = createOperationRows({
    snapshot: '1:2:',
    assertActive: () => {
      if (!alive) throw Error('closed');
    },
    execute: async (reads) => {
      calls++;
      return reads.map(() => ({
        fields: [{ name: 'value', dataTypeID: 17 }],
        rows: [[Buffer.from('cipher')]],
      }));
    },
  });
  const db = materialized.store(scope, canonicalSqliteSchema({ kind: 'cabinet', version: 1 }));
  const statement = db.prepare('SELECT value FROM meta WHERE key=?');
  assert.throws(() => statement.get('revision'), {
    code: 'POSTGRES_READ_OPERATION_NOT_MATERIALIZED',
  });
  assert.equal(calls, 0);
  await db.prefetchAll([
    statement.readRequest('get', ['revision']),
    statement.readRequest('get', ['revision']),
  ]);
  assert.equal(calls, 1);
  const first = statement.get('revision');
  first.value[0] = 0;
  assert.equal(statement.get('revision').value.toString(), 'cipher');
  await db.prefetchAll([statement.readRequest('get', ['revision'])]);
  assert.equal(calls, 1);
  assert.throws(() => db.prepare('DELETE FROM meta').run(), { code: 'POSTGRES_QUERY_ONLY' });
  assert.throws(() => db.prepare('DELETE FROM meta').readRequest('all', []), {
    code: 'POSTGRES_QUERY_ONLY',
  });
  alive = false;
  assert.throws(() => statement.get('revision'), /closed/);
});
test('foreign descriptors and session-authority cache enrollment fail closed', async () => {
  const catalog = canonicalSqliteSchema({ kind: 'platform', version: 19 });
  const one = createOperationRows({ snapshot: '1:2:', assertActive() {}, execute: async () => [] });
  const two = createOperationRows({ snapshot: '1:2:', assertActive() {}, execute: async () => [] });
  const db = one.store({ kind: 'platform', storeId: scope.storeId }, catalog);
  const token = db
    .prepare('SELECT value FROM organizations WHERE id=?')
    .readRequest('get', ['org']);
  await assert.rejects(two.prefetchAll([token]), { code: 'POSTGRES_READ_OPERATION_TOKEN' });
  assert.throws(
    () =>
      db
        .prepare('SELECT value FROM platform_sessions WHERE token_hash=?')
        .readRequest('get', ['hash']),
    { code: 'POSTGRES_READ_BATCH_AUTHORITY' },
  );
});
test('classifier enrolls bounded GET reads and only the explicit compact operation status', () => {
  for (const url of [
    '/api/cabinet/calendar?from=x',
    '/api/cabinet/patient?id=p',
    '/api/cabinet/patient/history?id=p',
    '/api/cabinet/patient/upcoming?id=p',
    '/api/cabinet/directory?q=x',
    '/api/cabinet/operation?id=synthetic-status148&statusOnly=1',
  ])
    assert.equal(isPostgresReadOperation({ method: 'GET', url }), true);
  for (const req of [
    { method: 'POST', url: '/api/cabinet/patient' },
    { method: 'GET', url: '/api/photos/a' },
    { method: 'GET', url: '/api/cabinet/operation' },
    { method: 'GET', url: '/api/cabinet/operation?statusOnly=0' },
    { method: 'POST', url: '/api/cabinet/operation?statusOnly=1' },
  ])
    assert.equal(isPostgresReadOperation(req), false);
});

const { decoratePatientView } = require('../src/server/modules/cabinet/queries.cjs');
test('page decoration touches only bounded upcoming records and preserves historical outcomes', () => {
  const old = { id: 'old', status: 'cancelled', confirmationKey: 'unchanged' };
  const next = { id: 'next', status: 'scheduled' };
  const data = {
    patient: { id: 'patient', appointments: [old, next], visits: [] },
    history: { entries: [{ kind: 'appointment', record: old }] },
    upcoming: { entries: [next], total: 1 },
  };
  let calls = 0;
  const decorated = decoratePatientView(data, (entries, patient) => {
    calls++;
    assert.equal(patient.id, 'patient');
    assert.deepEqual(entries, [next]);
    return entries.map((a) => ({ ...a, confirmationKey: 'fresh', deliveryReady: true }));
  });
  assert.equal(calls, 1);
  assert.equal(decorated.patient.appointments[0], old);
  assert.equal(decorated.history, data.history);
  assert.equal(decorated.patient.appointments[1].confirmationKey, 'fresh');
  assert.equal(decorated.upcoming.entries[0].deliveryReady, true);
  assert.equal(next.confirmationKey, undefined);
  assert.deepEqual(
    decoratePatientView({ entries: [next], total: 1 }, (entries) =>
      entries.map((a) => ({ ...a, manualConfirmedAt: 1 })),
    ).entries[0].manualConfirmedAt,
    1,
  );
  assert.deepEqual(
    decoratePatientView({ viewUnsupported: true }, () => assert.fail()),
    { viewUnsupported: true },
  );
  assert.throws(() => decoratePatientView({ entries: Array(51).fill(next) }, () => assert.fail()), {
    status: 503,
  });
});

test('aggregate source probe covers only metadata consumed by each closed read operation', () => {
  const {
    operationSources,
  } = require('../src/server/infrastructure/postgres/read-operation-sources145.cjs');
  const operation = {
    scope,
    cabinetCatalog: canonicalSqliteSchema({ kind: 'cabinet', version: 1 }),
    platform: { kind: 'platform', storeId: scope.storeId },
    platformCatalog: canonicalSqliteSchema({ kind: 'platform', version: 19 }),
  };
  const sources = (path) =>
    operationSources(operation, {
      current: { organizationId: 'org', role: 'owner' },
      url: new URL(path, 'http://local'),
      hash: (value) => value,
    });
  assert.equal(
    sources('/api/cabinet/directory').find((s) => s.table === 'meta').where,
    "s.key IN ('revision','initialized')",
  );
  assert.equal(
    sources('/api/cabinet/patient?id=p').find((s) => s.table === 'meta').where,
    "s.key IN ('revision','initialized') OR s.key LIKE 'booking-accepted:%'",
  );
});

test('exact schema2 LIMIT0 constructor check is an attested catalog projection, never table enrollment', async () => {
  let calls = 0,
    alive = true;
  const rows = createOperationRows({
    snapshot: '1:2:',
    assertActive() {
      if (!alive) throw Error('closed');
    },
    execute: async () => {
      calls++;
      throw Error('unprobed real read');
    },
  });
  const catalog = canonicalSqliteSchema({ kind: 'cabinet', version: 2 });
  const db = rows.store(scope, catalog);
  const sql = 'SELECT kind,id,patient_id,position,value FROM cabinet_patient_records LIMIT 0';
  await db.prefetchAll([db.prepare(sql).readRequest('all', [])]);
  assert.deepEqual(db.prepare(sql).all(), []);
  assert.equal(calls, 0);
  await assert.rejects(
    db.prefetchAll([
      db
        .prepare('SELECT kind,id,patient_id,position,value FROM cabinet_patient_records')
        .readRequest('all', []),
    ]),
    /unprobed real read/,
  );
  assert.equal(calls, 1);
  const bad = structuredClone(catalog);
  bad.tables.cabinet_patient_records.columns[0].type = 'BLOB';
  const other = createOperationRows({
    snapshot: '1:2:',
    assertActive() {},
    execute: async () => assert.fail(),
  });
  assert.throws(() => other.store(scope, bad).prepare(sql).readRequest('all', []), {
    code: 'POSTGRES_READ_OPERATION_CATALOG_SHAPE',
  });
  alive = false;
  assert.throws(() => db.prepare(sql).all(), /closed/);
});
