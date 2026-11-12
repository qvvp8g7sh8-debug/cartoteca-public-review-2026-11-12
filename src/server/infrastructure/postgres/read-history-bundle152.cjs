const fields =
  'bucket,id,patient_id,kind,position,audience,stream,rank,source_hash,witness_kind,witness_id,value';
const bad = () =>
  Object.assign(Error('Invalid native patient page'), {
    status: 503,
    code: 'POSTGRES_NATIVE_READ_VIEW',
  });
function historyQuery(scope, catalog, selection) {
  const { id, audience, mode, cursor } = selection;
  if (
    catalog.version !== 2 ||
    !catalog.tables.cabinet_history_entries ||
    !catalog.tables.cabinet_history_manifests ||
    typeof id !== 'string' ||
    !id ||
    id.length > 120 ||
    !(audience === '*' || /^[a-f0-9]{64}$/.test(audience)) ||
    !['card', 'history', 'upcoming'].includes(mode) ||
    !['visit', 'outcome', 'upcoming'].every(
      (key) => Number.isSafeInteger(cursor[key]) && cursor[key] >= 0,
    )
  )
    throw bad();
  const streams =
    mode === 'card'
      ? ['visit', 'outcome', 'upcoming']
      : mode === 'history'
        ? ['visit', 'outcome']
        : ['upcoming'];
  const values = [scope.storeId, id, audience],
    predicates = streams.map((stream) => {
      const offset = values.length;
      values.push(stream, cursor[stream]);
      return `(e.stream=$${offset + 1} AND e.rank>$${offset + 2} AND e.rank<=$${offset + 2}+51)`;
    });
  return {
    text: `WITH selected_entries AS MATERIALIZED (
SELECT e.* FROM cartoteca_cabinet.cabinet_history_entries e
WHERE e._store_id=$1 AND e.patient_id=$2 AND e.audience=$3 AND (${predicates.join(' OR ')}))
SELECT ${fields} FROM (
SELECT 'profile'::text AS bucket,p.id,NULL::text AS patient_id,NULL::text AS kind,NULL::bigint AS position,NULL::text AS audience,NULL::text AS stream,NULL::bigint AS rank,NULL::text AS source_hash,NULL::text AS witness_kind,NULL::text AS witness_id,p.value FROM cartoteca_cabinet.patients p WHERE p._store_id=$1 AND p.id=$2
UNION ALL SELECT 'meta',m.key,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,m.value FROM cartoteca_cabinet.meta m WHERE m._store_id=$1 AND m.key IN('revision','initialized')
UNION ALL SELECT 'manifest',NULL,m.patient_id,NULL,NULL,m.audience,m.stream,NULL,NULL,m.witness_kind,m.witness_id,m.value FROM cartoteca_cabinet.cabinet_history_manifests m WHERE m._store_id=$1 AND m.patient_id=$2 AND m.audience IN('*',$3)
UNION ALL SELECT DISTINCT 'witness'::text,r.id,r.patient_id,r.kind,r.position,NULL::text,NULL::text,NULL::bigint,NULL::text,NULL::text,NULL::text,r.value FROM cartoteca_cabinet.cabinet_history_manifests m JOIN cartoteca_cabinet.cabinet_patient_records r ON r._store_id=m._store_id AND r.patient_id=m.patient_id AND r.kind=m.witness_kind AND r.id=m.witness_id WHERE m._store_id=$1 AND m.patient_id=$2 AND m.audience=$3
UNION ALL SELECT 'entry',e.id,r.patient_id,e.kind,e.position,e.audience,e.stream,e.rank,e.source_hash,NULL,NULL,r.value FROM selected_entries e LEFT JOIN cartoteca_cabinet.cabinet_patient_records r ON r._store_id=e._store_id AND r.patient_id=e.patient_id AND r.kind=e.kind AND r.id=e.id AND r.position=e.position
) selected ORDER BY bucket,audience,stream,rank LIMIT 200`,
    values,
    maximumRows: 199,
  };
}
function historyLookup(rows) {
  const groups = (name) => rows.filter((row) => row.bucket === name);
  return ({ sql, method, args }) => {
    let result;
    if (sql === 'SELECT id,value FROM patients WHERE id=?') result = groups('profile');
    else if (sql === 'SELECT value FROM meta WHERE key=?')
      result = groups('meta').filter((row) => row.id === args[0]);
    else if (
      sql ===
      'SELECT audience,stream,witness_kind,witness_id,value FROM cabinet_history_manifests WHERE patient_id=? AND audience IN (?,?)'
    )
      result = groups('manifest');
    else if (
      sql ===
      'SELECT kind,id,patient_id,position,value FROM cabinet_patient_records WHERE patient_id=? AND kind=? AND id=?'
    )
      result = groups('witness').filter(
        (row) => row.patient_id === args[0] && row.kind === args[1] && row.id === args[2],
      );
    else if (
      sql ===
      'SELECT e.rank,e.kind,e.id,e.position,e.source_hash,r.patient_id,r.value FROM cabinet_history_entries e LEFT JOIN cabinet_patient_records r ON r.patient_id=e.patient_id AND r.kind=e.kind AND r.id=e.id AND r.position=e.position WHERE e.patient_id=? AND e.audience=? AND e.stream=? AND e.rank>? ORDER BY e.rank LIMIT 51'
    )
      result = groups('entry')
        .filter((row) => row.audience === args[1] && row.stream === args[2] && row.rank > args[3])
        .sort((a, b) => a.rank - b.rank);
    else throw bad();
    return method === 'get' ? result[0] : result;
  };
}
module.exports = { historyQuery, historyLookup };
