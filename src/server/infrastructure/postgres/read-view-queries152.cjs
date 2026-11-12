const { historyQuery } = require('./read-history-bundle152.cjs');
const bad = () =>
  Object.assign(Error('Invalid native clinical view'), {
    status: 503,
    code: 'POSTGRES_NATIVE_READ_VIEW',
  });
function viewQuery(scope, catalog, kind, selection) {
  if (scope.kind !== 'cabinet' || ![1, 2].includes(catalog.version)) throw bad();
  if (kind === 'history') return historyQuery(scope, catalog, selection);
  if (kind === 'appointment') {
    if (
      catalog.version !== 2 ||
      ![selection.patientId, selection.id].every(
        (v) => typeof v === 'string' && v.length > 0 && v.length <= 120,
      )
    )
      throw bad();
    return {
      text: `SELECT 'profile'::text AS bucket,p.id,p.value FROM cartoteca_cabinet.patients p WHERE p._store_id=$1 AND p.id=$2
UNION ALL SELECT 'appointment',r.id,r.value FROM cartoteca_cabinet.cabinet_patient_records r WHERE r._store_id=$1 AND r.patient_id=$2 AND r.kind='appointment' AND r.id=$3
UNION ALL SELECT 'meta',m.key,m.value FROM cartoteca_cabinet.meta m WHERE m._store_id=$1 AND m.key='revision'`,
      values: [scope.storeId, selection.patientId, selection.id],
      maximumRows: 3,
    };
  }
  if (kind === 'selected') {
    if (
      selection.operation !== 'cabinet-selected-v1' ||
      selection.patientIds?.length !== 1 ||
      selection.serviceIds?.length !== 0 ||
      typeof selection.patientIds[0] !== 'string' ||
      !selection.patientIds[0] ||
      selection.patientIds[0].length > 120
    )
      throw bad();
    const records =
      catalog.version === 2
        ? `UNION ALL SELECT 'record',r.id,r.patient_id,r.kind,r.position,NULL::bigint,r.value
      FROM cartoteca_cabinet.cabinet_patient_records r WHERE r._store_id=$1 AND r.patient_id=$2`
        : '';
    return {
      text: `SELECT * FROM (
      SELECT 'patient'::text AS bucket,p.id,NULL::text AS patient_id,NULL::text AS record_kind,NULL::bigint AS position,1::bigint AS ordinal,p.value FROM cartoteca_cabinet.patients p WHERE p._store_id=$1 AND p.id=$2
      ${records}
      UNION ALL SELECT 'meta',m.key,NULL,NULL,NULL,NULL,m.value FROM cartoteca_cabinet.meta m WHERE m._store_id=$1 AND m.key IN('revision','initialized')
      ) selected ORDER BY bucket,ordinal,patient_id,record_kind,position,id LIMIT 20004`,
      values: [scope.storeId, selection.patientIds[0]],
      maximumRows: 20003,
    };
  }
  for (const name of [
    'meta',
    'cabinet_summaries',
    ...(kind === 'calendar' ? ['cabinet_appointments', 'cabinet_days'] : []),
  ])
    if (!catalog.tables[name]) throw bad();
  if (kind === 'directory') {
    if (!(selection.audience === '*' || /^[a-f0-9]{64}$/.test(selection.audience))) throw bad();
    return {
      text: `SELECT 'summary'::text AS bucket,s.patient_id AS id,s.patient_id,s.value FROM cartoteca_cabinet.cabinet_summaries s WHERE s._store_id=$1 AND s.audience=$2
UNION ALL SELECT 'meta',m.key,NULL::text,m.value FROM cartoteca_cabinet.meta m WHERE m._store_id=$1 AND m.key IN('revision','initialized') ORDER BY bucket,id`,
      values: [scope.storeId, selection.audience],
    };
  }
  if (
    kind !== 'calendar' ||
    !Array.isArray(selection.ranges) ||
    selection.ranges.length < 1 ||
    selection.ranges.length > 2 ||
    selection.ranges.some(
      (range) =>
        !['main', 'overview'].includes(range.bucket) ||
        !Array.isArray(range.days) ||
        range.days.length < 1 ||
        range.days.length > 45 ||
        range.days.some((day) => !/^[a-f0-9]{64}$/.test(day)),
    ) ||
    !(selection.audience === null || /^[a-f0-9]{64}$/.test(selection.audience))
  )
    throw bad();
  const buckets = [],
    days = [];
  for (const range of selection.ranges)
    for (const day of range.days) {
      buckets.push(range.bucket);
      days.push(day);
    }
  return {
    text: `WITH requested AS (SELECT * FROM unnest($2::text[],$3::text[]) AS request(bucket,day)), selected AS MATERIALIZED (
SELECT DISTINCT q.bucket,a.id,a.patient_id,a.value FROM requested q JOIN cartoteca_cabinet.cabinet_days d ON d._store_id=$1 AND d.day_hash=q.day JOIN cartoteca_cabinet.cabinet_appointments a ON a._store_id=d._store_id AND a.id=d.appointment_id
WHERE $4::text IS NULL OR EXISTS(SELECT 1 FROM cartoteca_cabinet.cabinet_summaries s WHERE s._store_id=$1 AND s.patient_id=a.patient_id AND s.audience=$4))
SELECT bucket,id,patient_id,value FROM selected
UNION ALL SELECT 'contact',s.patient_id,s.patient_id,s.value FROM cartoteca_cabinet.cabinet_summaries s WHERE s._store_id=$1 AND s.audience='*' AND s.patient_id IN(SELECT patient_id FROM selected)
UNION ALL SELECT 'meta',m.key,NULL::text,m.value FROM cartoteca_cabinet.meta m WHERE m._store_id=$1 AND m.key IN('revision','initialized')`,
    values: [scope.storeId, buckets, days, selection.audience],
  };
}
module.exports = { viewQuery };
