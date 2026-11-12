const { createHistoryWrites } = require('./history-index-writes145.cjs');
// Optional schema2 index. Opaque ranks expose order, never dates, names or clinical text.
const { isActiveAppointment, isClosedAppointment } = require('../../shared/appointment-status.cjs');
const schema = `CREATE TABLE cabinet_history_entries(patient_id TEXT NOT NULL,audience TEXT NOT NULL,stream TEXT NOT NULL,rank INTEGER NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,position INTEGER NOT NULL,source_hash TEXT NOT NULL,PRIMARY KEY(patient_id,audience,stream,rank));
CREATE UNIQUE INDEX cabinet_history_record ON cabinet_history_entries(patient_id,audience,stream,kind,id);
CREATE TABLE cabinet_history_manifests(patient_id TEXT NOT NULL,audience TEXT NOT NULL,stream TEXT NOT NULL,witness_kind TEXT,witness_id TEXT,value BLOB NOT NULL,PRIMARY KEY(patient_id,audience,stream));`;
const streams = Object.freeze(['visit', 'outcome', 'upcoming']);
function supported(db, version = db.catalog?.version) {
  if (version !== 2) return false;
  const count = db.catalog
    ? Number(Boolean(db.catalog.tables.cabinet_history_entries)) +
      Number(Boolean(db.catalog.tables.cabinet_history_manifests))
    : db
        .prepare(
          "SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('cabinet_history_entries','cabinet_history_manifests')",
        )
        .get().n;
  if (count === 1)
    throw Object.assign(Error('Incomplete canonical history component'), {
      status: 503,
      code: 'CABINET_HISTORY_INDEX',
    });
  return count === 2;
}
const chronological = (a, b) =>
  (b.value.date + ' ' + (b.value.time || '')).localeCompare(
    a.value.date + ' ' + (a.value.time || ''),
  );
function sourceHash(hash, row) {
  return hash(
    JSON.stringify(['history145', row.patient_id, row.kind, row.id, row.position, hash(row.value)]),
  );
}
function streamRows(patient, collection) {
  const kind = collection === 'visits' ? 'visit' : 'appointment';
  return patient[collection].map((value, position) => ({
    kind,
    id: value.id,
    patient_id: patient.id,
    position,
    value,
  }));
}
function* historyRows(
  patient,
  canonicalRows,
  profileValue,
  { encode, hash, selectedStreams = streams },
) {
  const rows = new Map(canonicalRows.map((row) => [row.kind + ':' + row.id, row]));
  const visits = selectedStreams.includes('visit') ? streamRows(patient, 'visits') : [];
  const appointments = streamRows(patient, 'appointments');
  const profileHash = hash(profileValue);
  const proofs = new Map();
  for (const stream of selectedStreams) {
    const source = stream === 'visit' ? visits : appointments;
    const audiences = new Set(['*']),
      witnesses = new Map([['*', source[0]]]),
      grouped = new Map();
    for (const row of source)
      if (row.value.staffId) {
        const audience = hash('staff:' + row.value.staffId);
        audiences.add(audience);
        if (!witnesses.has(audience)) witnesses.set(audience, row);
      }
    const eligible = source.filter(
      (row) =>
        stream === 'visit' ||
        (stream === 'outcome' ? isClosedAppointment(row.value) : isActiveAppointment(row.value)),
    );
    eligible.sort(stream === 'upcoming' ? (a, b) => -chronological(a, b) : chronological);
    for (const row of eligible)
      if (row.value.staffId) {
        const audience = hash('staff:' + row.value.staffId);
        if (!grouped.has(audience)) grouped.set(audience, []);
        grouped.get(audience).push(row);
      }
    for (const audience of audiences) {
      const selected = audience === '*' ? eligible : grouped.get(audience) || [];
      const witness = witnesses.get(audience);
      const proofFor = (row) => {
        const canonical = rows.get(row.kind + ':' + row.id);
        if (
          !canonical ||
          canonical.patient_id !== patient.id ||
          canonical.position !== row.position
        )
          throw Error('Missing canonical history source');
        const key = row.kind + ':' + row.id;
        if (!proofs.has(key))
          proofs.set(key, {
            kind: row.kind,
            id: row.id,
            position: row.position,
            sourceHash: sourceHash(hash, canonical),
          });
        return proofs.get(key);
      };
      for (let rank = 0; rank < selected.length; rank++) {
        const row = selected[rank],
          proof = proofFor(row);
        yield {
          table: 'cabinet_history_entries',
          args: [
            patient.id,
            audience,
            stream,
            rank + 1,
            row.kind,
            row.id,
            row.position,
            proof.sourceHash,
          ],
        };
      }
      yield {
        table: 'cabinet_history_manifests',
        args: [
          patient.id,
          audience,
          stream,
          witness?.kind || null,
          witness?.id || null,
          encode({
            version: 1,
            patientId: patient.id,
            audience,
            stream,
            ...(audience === '*' ? { audiences: [...audiences].filter((v) => v !== '*') } : {}),
            profileHash,
            total: selected.length,
            photoCount:
              stream === 'visit'
                ? selected.reduce((n, row) => n + (row.value.photos || []).length, 0)
                : 0,
            witness: witness ? proofFor(witness) : null,
          }),
        ],
      };
    }
  }
}

function createHistoryIndex({
  db,
  prepare = db.prepare.bind(db),
  encode,
  decode,
  hash,
  schemaVersion,
}) {
  if (!supported(db, schemaVersion)) return null;
  if (typeof hash !== 'function') throw Error('History index requires the tenant key');
  const remove = (id) => {
    prepare('DELETE FROM cabinet_history_entries WHERE patient_id=?').run(id);
    prepare('DELETE FROM cabinet_history_manifests WHERE patient_id=?').run(id);
  };
  const writer = createHistoryWrites({
    db,
    prepare,
    encode,
    decode,
    hash,
    sourceHash,
    historyRows,
  });
  function syncPatient(patient, canonicalRows, profileValue, previous = null) {
    writer.sync(patient, canonicalRows, profileValue, streams, previous);
  }
  function syncAppointments(patientId, before, appointments, priorRows = null) {
    const profile = prepare('SELECT value FROM patients WHERE id=?').get(patientId);
    if (!profile) throw Error('Missing canonical patient profile');
    const rows = prepare(
      "SELECT kind,id,patient_id,position,value FROM cabinet_patient_records WHERE patient_id=? AND kind='appointment' ORDER BY position",
    ).all(patientId);
    if (rows.length !== appointments.length)
      throw Error('Canonical appointment index count mismatch');
    for (let i = 0; i < rows.length; i++)
      if (
        rows[i].id !== appointments[i].id ||
        rows[i].position !== i ||
        JSON.stringify(decode(rows[i].value)) !== JSON.stringify(appointments[i])
      )
        throw Error('Canonical appointment index mismatch');
    let previous = null;
    if (priorRows !== null) {
      if (!Array.isArray(priorRows) || !Array.isArray(before) || priorRows.length !== before.length)
        throw Error('Invalid prior canonical appointment snapshot');
      for (let i = 0; i < priorRows.length; i++) {
        const row = priorRows[i];
        if (
          row.kind !== 'appointment' ||
          row.id !== before[i].id ||
          row.position !== i ||
          (row.patient_id != null && row.patient_id !== patientId) ||
          JSON.stringify(decode(row.value)) !== JSON.stringify(before[i])
        )
          throw Error('Invalid prior canonical appointment snapshot');
      }
      previous = {
        patient: { id: patientId, visits: [], appointments: before },
        rows: priorRows.map((row) => ({ ...row, patient_id: patientId })),
        profileValue: profile.value,
      };
    }
    // Reuse the existing CAS refresh when appointment layout is unchanged.
    // Canonical old ciphers come only from the privately branded mutation read;
    // changed layouts still rebuild their affected streams in this transaction.
    writer.sync(
      { id: patientId, visits: [], appointments },
      rows,
      profile.value,
      ['outcome', 'upcoming'],
      previous,
    );
  }
  return { remove, syncPatient, syncAppointments };
}
module.exports = {
  schema,
  streams,
  supported,
  sourceHash,
  chronological,
  historyRows,
  createHistoryIndex,
};
