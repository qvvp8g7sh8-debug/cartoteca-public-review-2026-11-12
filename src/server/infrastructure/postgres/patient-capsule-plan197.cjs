const { sourceProbe } = require('./read-source-probe152.cjs');
const { historyQuery } = require('./read-history-bundle152.cjs');
const { viewQuery } = require('./read-view-queries152.cjs');
// These are the unchanged SQLite cabinet2 source columns, not native _store_id.
// Preparation verifies the complete native catalog before granting this port.
const columns = {
  patients: [
    ['id', 'TEXT'],
    ['value', 'BLOB'],
  ],
  meta: [
    ['key', 'TEXT'],
    ['value', 'BLOB'],
  ],
  cabinet_history_manifests: [
    ['patient_id', 'TEXT'],
    ['audience', 'TEXT'],
    ['stream', 'TEXT'],
    ['witness_kind', 'TEXT'],
    ['witness_id', 'TEXT'],
    ['value', 'BLOB'],
  ],
  cabinet_history_entries: [
    ['patient_id', 'TEXT'],
    ['audience', 'TEXT'],
    ['stream', 'TEXT'],
    ['rank', 'INTEGER'],
    ['kind', 'TEXT'],
    ['id', 'TEXT'],
    ['position', 'INTEGER'],
    ['source_hash', 'TEXT'],
  ],
  cabinet_patient_records: [
    ['kind', 'TEXT'],
    ['id', 'TEXT'],
    ['patient_id', 'TEXT'],
    ['position', 'INTEGER'],
    ['value', 'BLOB'],
  ],
};
const catalog197 = Object.freeze({
  version: 2,
  tables: Object.fromEntries(
    Object.entries(columns).map(([name, list]) => [
      name,
      { columns: list.map(([name, type]) => ({ name, type })) },
    ]),
  ),
});
const modes = ['card', 'history', 'upcoming', 'appointment'];
function patientCapsuleSources197({ scope, catalog, cabinetCatalog = catalog, selection }) {
  catalog = cabinetCatalog;
  const { kind, id, appointmentId, audience, cursor } = selection;
  const add = (table, where, values) => ({ scope, catalog, table, where, values });
  if (kind === 'appointment')
    return [
      add('meta', "s.key IN ('revision','initialized')", []),
      add('patients', 's.id=$2', [id]),
      add('cabinet_patient_records', "s.patient_id=$2 AND s.kind='appointment' AND s.id=$3", [
        id,
        appointmentId,
      ]),
    ];
  if (!modes.includes(kind)) throw Error('Invalid capsule selection.');
  const streams =
    kind === 'card'
      ? ['visit', 'outcome', 'upcoming']
      : kind === 'history'
        ? ['visit', 'outcome']
        : ['upcoming'];
  const positions = streams.flatMap((stream) => [stream, cursor[stream]]);
  const predicates = streams.map(
    (_, i) => `(e.stream=$${i * 2 + 4} AND e.rank>$${i * 2 + 5} AND e.rank<=$${i * 2 + 5}+51)`,
  );
  const entries =
    'e._store_id=$1 AND e.patient_id=$2 AND e.audience=$3 AND (' + predicates.join(' OR ') + ')';
  return [
    add('patients', 's.id=$2', [id]),
    add('meta', "s.key IN ('revision','initialized')", []),
    add('cabinet_history_manifests', "s.patient_id=$2 AND s.audience IN ('*',$3)", [id, audience]),
    add('cabinet_history_entries', entries.replaceAll('e.', 's.'), [id, audience, ...positions]),
    add(
      'cabinet_patient_records',
      's.patient_id=$2 AND ((EXISTS(SELECT 1 FROM cartoteca_cabinet.cabinet_history_entries e WHERE ' +
        entries +
        ' AND e.kind=s.kind AND e.id=s.id AND e.position=s.position)) OR EXISTS(SELECT 1 FROM cartoteca_cabinet.cabinet_history_manifests m WHERE m._store_id=$1 AND m.patient_id=$2 AND m.audience=$3 AND m.witness_kind=s.kind AND m.witness_id=s.id))',
      [id, audience, ...positions],
    ),
  ];
}
const sqlLiteral = (s) => "'" + s.replaceAll("'", "''") + "'";
function substitutions197(kind) {
  const selected = {
    kind,
    id: '__patient197__',
    appointmentId: '__appointment197__',
    audience: 'b'.repeat(64),
    cursor: { visit: 101, outcome: 202, upcoming: 303 },
  };
  const map = new Map([
    ['__store197__', 'p_cabinet'],
    ['__patient197__', 'p_patient'],
    ['__appointment197__', 'p_appointment'],
    ['b'.repeat(64), 'p_audience'],
    [101, 'p_cursors[1]'],
    [202, 'p_cursors[2]'],
    [303, 'p_cursors[3]'],
  ]);
  function resolve(value) {
    if (map.has(value)) return map.get(value);
    if (['visit', 'outcome', 'upcoming'].includes(value)) return sqlLiteral(value);
    throw Error('Unclosed capsule SQL parameter.');
  }
  const bind = (text, values) => text.replace(/\$(\d+)/g, (_, n) => resolve(values[Number(n) - 1]));
  return { selected, bind };
}
function sourceSQL197(kind) {
  const { selected, bind } = substitutions197(kind),
    scope = { kind: 'cabinet', storeId: '__store197__' };
  return patientCapsuleSources197({ scope, catalog: catalog197, selection: selected })
    .map((source, i) =>
      bind(sourceProbe(source, i, 0, { witness: kind !== 'appointment' }), [
        scope.storeId,
        ...source.values,
      ]),
    )
    .join('\nUNION ALL\n');
}
function bodySQL197(kind) {
  const { selected, bind } = substitutions197(kind),
    scope = { kind: 'cabinet', storeId: '__store197__' };
  const plan =
    kind === 'appointment'
      ? viewQuery(scope, catalog197, 'appointment', {
          patientId: selected.id,
          id: selected.appointmentId,
        })
      : historyQuery(scope, catalog197, {
          id: selected.id,
          audience: selected.audience,
          mode: kind,
          cursor: selected.cursor,
        });
  return bind(plan.text, plan.values);
}
module.exports = { catalog197, modes, patientCapsuleSources197, sourceSQL197, bodySQL197 };
