const test = require('node:test');
const assert = require('node:assert/strict');
const {
  OPERATION,
  MAX_IDS,
  MAX_ROWS,
  MAX_BYTES,
  selectionOf,
  assertContext,
  queryFor,
  unpack,
} = require('../src/server/infrastructure/postgres/cabinet-read-bundle136.cjs');
const { createPatientRecords } = require('../src/server/infrastructure/cabinet-records.cjs');
const {
  canonicalSqliteSchema,
} = require('../src/server/infrastructure/postgres/catalog-canonical.cjs');
const scope = { kind: 'cabinet', storeId: 'synthetic-cabinet', organizationId: 'synthetic-org' };
const catalog = (version = 2) => ({
  version,
  tables: {
    patients: {},
    services: {},
    meta: {},
    ...(version === 2 ? { cabinet_patient_records: {} } : {}),
  },
});
const selection = (patientIds = [], serviceIds = []) => ({
  operation: OPERATION,
  patientIds,
  serviceIds,
});
const fail = (error) => error.status === 503 && /^POSTGRES_READ_BUNDLE_/.test(error.code);
const value = (input) => Buffer.from(JSON.stringify(input));
const row = (bucket, id, input, ordinal = null) => ({
  bucket,
  id,
  patient_id: null,
  record_kind: null,
  position: null,
  ordinal,
  value: value(input),
});
const record = (id, patient, kind = 'visit', position = 0) => ({
  ...row('record', id, { id }),
  patient_id: patient,
  record_kind: kind,
  position,
});

test('closed selection admits bounded copies and rejects arbitrary SQL, sparse IDs and extra fields', () => {
  const ids = ['first', 'first', 'second'],
    input = selection(ids, ['service']);
  const parsed = selectionOf(input);
  ids[0] = 'changed';
  assert.deepEqual(parsed.patientIds, ['first', 'first', 'second']);
  assert.equal(Object.isFrozen(parsed.patientIds), true);
  assert.equal(
    selectionOf(selection(Array.from({ length: MAX_IDS }, (_, n) => 'p-' + n))).patientIds.length,
    MAX_IDS,
  );
  for (const bad of [
    { ...selection(), operation: 'arbitrary' },
    { ...selection(), sql: 'DELETE FROM patients' },
    { ...selection(), scope },
    { ...selection(), patientIds: [null] },
    selection(new Array(1)),
    selection(['']),
    selection(['a'.repeat(121)]),
    selection(['a\0b']),
    selection(new Array(MAX_IDS + 1).fill('p')),
    selection([], new Array(MAX_IDS + 1).fill('s')),
  ])
    assert.throws(() => selectionOf(bad), fail);
});

test('capability requires the exact innermost cabinet in a fully read-only attested profile3 snapshot', () => {
  const frame = { scope, mode: 'READONLY' };
  for (const version of [1, 2])
    assert.doesNotThrow(() => assertContext(scope, catalog(version), [frame], 3, true));
  for (const frames of [
    [],
    [{ ...frame, mode: 'DEFERRED' }],
    [{ ...frame, mode: 'IMMEDIATE' }],
    [{ ...frame, mode: 'COMPOUND' }, frame],
    [{ ...frame, mode: 'QUEUEORG' }, frame],
    [{ ...frame, scope: { ...scope, storeId: 'foreign' } }],
    [{ ...frame, scope: { ...scope, organizationId: 'foreign' } }],
  ])
    assert.throws(() => assertContext(scope, catalog(), frames, 3, true), fail);
  for (const version of [1, 2])
    assert.throws(() => assertContext(scope, catalog(), [frame], version, true), fail);
  assert.throws(() => assertContext(scope, catalog(), [frame], 3, false), fail);
  assert.throws(() => assertContext(scope, catalog(0), [frame], 3, true), fail);
  assert.throws(
    () =>
      assertContext(
        scope,
        { version: 2, tables: { patients: {}, services: {}, meta: {} } },
        [frame],
        3,
        true,
      ),
    fail,
  );
});

test('SQL is fixed, value-bound and schema-specific with an explicit result-row ceiling', () => {
  const injection = "x'; DELETE FROM cartoteca_cabinet.patients;--";
  for (const version of [1, 2]) {
    const query = queryFor(scope, catalog(version), selection([injection], ['service']));
    assert.deepEqual(query.values, [scope.storeId, JSON.stringify([injection]), '["service"]']);
    assert.equal(query.text.includes(injection), false);
    assert.equal(query.text.includes('cabinet_patient_records'), version === 2);
    assert.ok(query.text.endsWith('LIMIT ' + (MAX_ROWS + 1)));
    assert.equal((query.text.match(/_store_id=\$1/g) || []).length, version === 2 ? 4 : 3);
    assert.equal(/\b(?:INSERT|UPDATE|DELETE|set_config|pg_sleep)\b/.test(query.text), false);
  }
  assert.ok(MAX_BYTES <= 128 * 1024 * 1024);
});

test('bundle preserves requested order, duplicates, encrypted bytes and canonical record groups', () => {
  const input = selection(['b', 'missing', 'a', 'a'], ['s', 's']);
  const rows = [
    row('patient', 'a', { id: 'a' }, 4n),
    row('patient', 'b', { id: 'b' }, 1n),
    row('patient', 'a', { id: 'a' }, 3n),
    row('service', 's', { id: 's' }, 2n),
    row('service', 's', { id: 's' }, 1n),
    record('v1', 'a', 'visit', 1n),
    record('a0', 'a', 'appointment', 0n),
    record('v0', 'a', 'visit', 0n),
    row('meta', 'revision', 17),
    row('meta', 'initialized', false),
  ];
  const bundle = unpack({ rows }, input, 2);
  assert.deepEqual(
    bundle.patients.map((r) => r.id),
    ['b', 'a', 'a'],
  );
  assert.deepEqual(
    bundle.services.map((r) => r.id),
    ['s', 's'],
  );
  assert.deepEqual(
    bundle.records.map((r) => r.id),
    ['a0', 'v0', 'v1'],
  );
  assert.ok(bundle.patients.every((r) => r.value instanceof Uint8Array));
  const records = createPatientRecords({
    // A real PG port carries the registered catalog. The optional history
    // component is absent in this canonical schema2 hydration-only fixture.
    db: { dialect: 'postgres', catalog: canonicalSqliteSchema({ kind: 'cabinet', version: 2 }) },
    schemaVersion: 2,
    prepare: () => ({ all: () => [] }),
    decode: (buffer) => JSON.parse(Buffer.from(buffer).toString()),
    encode: value,
  });
  const hydrated = records.hydrateRows(bundle.patients, bundle.records);
  assert.deepEqual(
    hydrated.map((p) => p.id),
    ['b', 'a', 'a'],
  );
  assert.deepEqual(
    hydrated[1].visits.map((v) => v.id),
    ['v0', 'v1'],
  );
  hydrated[1].visits.push({ id: 'local-only' });
  assert.equal(hydrated[2].visits.length, 2);
  assert.deepEqual(
    unpack({ rows: [row('meta', 'revision', null)] }, selection(), 1).meta[0].value,
    value(null),
  );
});

test('foreign, malformed, reordered or truncated native replies fail closed', () => {
  const input = selection(['p']);
  const patient = row('patient', 'p', { id: 'p' }, 1);
  for (const rows of [
    [{ ...patient, id: 'foreign' }],
    [{ ...patient, ordinal: 2 }],
    [patient, patient],
    [{ ...patient, _store_id: 'foreign' }],
    [{ ...patient, value: 'plaintext' }],
    [patient, { ...record('v', 'p'), patient_id: 'foreign' }],
    [record('orphan', 'p')],
    [patient, record('v', 'p', 'visit', 1)],
    [patient, record('v0', 'p'), record('v1', 'p')],
    [patient, { ...record('v', 'p'), record_kind: 'arbitrary' }],
    [row('meta', 'unknown', 1)],
    [row('meta', 'revision', 1), row('meta', 'revision', 2)],
  ])
    assert.throws(() => unpack({ rows }, input, 2), fail);
  assert.throws(() => unpack({ rows: [patient, record('v', 'p')] }, input, 1), fail);
  assert.throws(() => unpack({ rows: [], sql: 'ignored' }, input, 2), fail);
});
