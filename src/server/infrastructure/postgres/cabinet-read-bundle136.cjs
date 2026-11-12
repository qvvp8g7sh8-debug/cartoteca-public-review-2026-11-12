'use strict';
// Closed encrypted selection only. No SQL, table, mode or scope is supplied by a caller.
const OPERATION = 'cabinet-selected-v1';
const MAX_IDS = 200;
const MAX_ROWS = MAX_IDS * 20000 + MAX_IDS * 2 + 2;
const MAX_BYTES = 128 * 1024 * 1024;
const fields = ['bucket', 'id', 'patient_id', 'record_kind', 'position', 'ordinal', 'value'];
function fault(code = 'POSTGRES_READ_BUNDLE_INVALID') {
  return Object.assign(Error('Prepared cabinet read selection is unavailable.'), {
    code,
    status: 503,
  });
}
function exact(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function identifier(value) {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 120 && !value.includes('\0')
  );
}
function selectionOf(value) {
  if (!exact(value, ['operation', 'patientIds', 'serviceIds']) || value.operation !== OPERATION)
    throw fault();
  for (const ids of [value.patientIds, value.serviceIds])
    if (!Array.isArray(ids) || ids.length > MAX_IDS || !Array.from(ids).every(identifier))
      throw fault();
  return Object.freeze({
    operation: OPERATION,
    patientIds: Object.freeze([...value.patientIds]),
    serviceIds: Object.freeze([...value.serviceIds]),
  });
}
function assertContext(scope, catalog, frames, revisionProfile, lineageVerified) {
  const frame = frames.at(-1);
  if (
    revisionProfile !== 3 ||
    !lineageVerified ||
    scope?.kind !== 'cabinet' ||
    !identifier(scope.storeId) ||
    ![1, 2].includes(catalog?.version) ||
    !frame ||
    frames.some((entry) => entry.mode !== 'READONLY') ||
    frame.scope?.kind !== 'cabinet' ||
    frame.scope.storeId !== scope.storeId ||
    (frame.scope.organizationId || null) !== (scope.organizationId || null)
  )
    throw fault('POSTGRES_READ_BUNDLE_SCOPE');
  for (const table of [
    'patients',
    'services',
    'meta',
    ...(catalog.version === 2 ? ['cabinet_patient_records'] : []),
  ])
    if (!catalog.tables?.[table]) throw fault('POSTGRES_READ_BUNDLE_SCHEMA');
}
function queryFor(scope, catalog, selection) {
  selection = selectionOf(selection);
  if (scope?.kind !== 'cabinet' || !identifier(scope.storeId) || ![1, 2].includes(catalog?.version))
    throw fault('POSTGRES_READ_BUNDLE_SCHEMA');
  const records =
    catalog.version === 2
      ? `
 UNION ALL SELECT 'record',r.id,r.patient_id,r.kind,r.position,NULL::bigint,r.value
 FROM cartoteca_cabinet.cabinet_patient_records r
 WHERE r._store_id=$1 AND r.patient_id IN(SELECT id FROM requested_patients)`
      : '';
  return {
    text: `WITH requested_patients AS (
 SELECT value AS id,ordinality FROM jsonb_array_elements_text($2::jsonb) WITH ORDINALITY),
 requested_services AS (
 SELECT value AS id,ordinality FROM jsonb_array_elements_text($3::jsonb) WITH ORDINALITY)
 SELECT * FROM (
 SELECT 'patient'::text AS bucket,p.id,NULL::text AS patient_id,NULL::text AS record_kind,
 NULL::bigint AS position,r.ordinality AS ordinal,p.value
 FROM requested_patients r JOIN cartoteca_cabinet.patients p ON p.id=r.id AND p._store_id=$1
 UNION ALL SELECT 'service',s.id,NULL::text,NULL::text,NULL::bigint,r.ordinality,s.value
 FROM requested_services r JOIN cartoteca_cabinet.services s ON s.id=r.id AND s._store_id=$1${records}
 UNION ALL SELECT 'meta',m.key,NULL::text,NULL::text,NULL::bigint,NULL::bigint,m.value
 FROM cartoteca_cabinet.meta m WHERE m._store_id=$1 AND m.key IN('revision','initialized')
 ) selected ORDER BY bucket,ordinal,patient_id,record_kind,position,id LIMIT ${MAX_ROWS + 1}`,
    values: [
      scope.storeId,
      JSON.stringify(selection.patientIds),
      JSON.stringify(selection.serviceIds),
    ],
  };
}
function integer(value, min, max) {
  if (typeof value !== 'bigint' && !Number.isSafeInteger(value)) throw fault();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw fault();
  return number;
}
function unpack(value, selection, schemaVersion) {
  selection = selectionOf(selection);
  if (
    ![1, 2].includes(schemaVersion) ||
    !exact(value, ['rows']) ||
    !Array.isArray(value.rows) ||
    value.rows.length > MAX_ROWS
  )
    throw fault();
  const patients = [],
    services = [],
    records = [],
    meta = [],
    seen = new Set();
  const patientsRequested = new Set(selection.patientIds);
  let bytes = 0;
  for (const row of value.rows) {
    if (!exact(row, fields) || !identifier(row.id) || !(row.value instanceof Uint8Array))
      throw fault();
    bytes += row.value.byteLength + Buffer.byteLength(row.id) + 96;
    if (bytes > MAX_BYTES) throw fault('POSTGRES_READ_BUNDLE_CAPACITY');
    if (['patient', 'service'].includes(row.bucket)) {
      const ids = row.bucket === 'patient' ? selection.patientIds : selection.serviceIds;
      const ordinal = integer(row.ordinal, 1, ids.length);
      const key = row.bucket + ':' + ordinal;
      if (
        ids[ordinal - 1] !== row.id ||
        seen.has(key) ||
        row.patient_id !== null ||
        row.record_kind !== null ||
        row.position !== null
      )
        throw fault();
      seen.add(key);
      (row.bucket === 'patient' ? patients : services).push({
        id: row.id,
        value: row.value,
        ordinal,
      });
    } else if (row.bucket === 'record') {
      const key = 'record:' + row.record_kind + ':' + row.id;
      if (
        schemaVersion !== 2 ||
        !identifier(row.patient_id) ||
        !patientsRequested.has(row.patient_id) ||
        !['visit', 'appointment'].includes(row.record_kind) ||
        row.ordinal !== null ||
        seen.has(key)
      )
        throw fault();
      const position = integer(row.position, 0, 9999);
      seen.add(key);
      records.push({
        kind: row.record_kind,
        id: row.id,
        patient_id: row.patient_id,
        position,
        value: row.value,
      });
    } else if (row.bucket === 'meta') {
      const key = 'meta:' + row.id;
      if (
        !['revision', 'initialized'].includes(row.id) ||
        seen.has(key) ||
        row.patient_id !== null ||
        row.record_kind !== null ||
        row.position !== null ||
        row.ordinal !== null
      )
        throw fault();
      seen.add(key);
      meta.push({ key: row.id, value: row.value });
    } else throw fault();
  }
  const present = new Set(patients.map((row) => row.id));
  if (records.some((row) => !present.has(row.patient_id))) throw fault();
  const selected = (rows) =>
    rows.sort((a, b) => a.ordinal - b.ordinal).map(({ id, value }) => ({ id, value }));
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  records.sort(
    (a, b) =>
      compare(a.patient_id, b.patient_id) || compare(a.kind, b.kind) || a.position - b.position,
  );
  const positions = new Map();
  for (const row of records) {
    const key = JSON.stringify([row.patient_id, row.kind]);
    const position = positions.get(key) || 0;
    if (row.position !== position) throw fault();
    positions.set(key, position + 1);
  }
  return { patients: selected(patients), services: selected(services), records, meta };
}
module.exports = {
  OPERATION,
  MAX_IDS,
  MAX_ROWS,
  MAX_BYTES,
  fault,
  selectionOf,
  assertContext,
  queryFor,
  unpack,
};
