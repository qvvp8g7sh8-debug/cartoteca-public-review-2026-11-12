const { isActiveAppointment, isClosedAppointment } = require('../../shared/appointment-status.cjs');
const columns = Object.freeze({
  cabinet_history_entries: [
    'patient_id',
    'audience',
    'stream',
    'rank',
    'kind',
    'id',
    'position',
    'source_hash',
  ],
  cabinet_history_manifests: [
    'patient_id',
    'audience',
    'stream',
    'witness_kind',
    'witness_id',
    'value',
  ],
});
const collection = (p, stream) => (stream === 'visit' ? p.visits : p.appointments);
const eligible = (record, stream) =>
  stream === 'visit' ||
  (stream === 'outcome' ? isClosedAppointment(record) : isActiveAppointment(record));
function sameLayout(before, patient, stream) {
  const a = collection(before, stream),
    b = collection(patient, stream);
  return (
    a.length === b.length &&
    a.every(
      (old, i) =>
        old.id === b[i].id &&
        (old.staffId || '') === (b[i].staffId || '') &&
        eligible(old, stream) === eligible(b[i], stream) &&
        (!eligible(old, stream) ||
          (old.date === b[i].date && (old.time || '') === (b[i].time || ''))),
    )
  );
}
const bytes = (value) =>
  Buffer.isBuffer(value) ? value.length : typeof value === 'string' ? Buffer.byteLength(value) : 16;
const bad = () =>
  Object.assign(Error('Canonical history write mismatch'), {
    code: 'CABINET_HISTORY_INDEX',
    status: 503,
  });
function createHistoryWrites({ db, prepare, encode, decode, hash, sourceHash, historyRows }) {
  function bulk(table, iterable) {
    let batch = [],
      size = 0;
    const flush = () => {
      if (!batch.length) return;
      const names = columns[table];
      if (!names) throw bad();
      const tuple = '(' + names.map(() => '?').join(',') + ')';
      const sql =
        'INSERT INTO ' +
        table +
        '(' +
        names.join(',') +
        ') VALUES' +
        batch.map(() => tuple).join(',');
      const result = prepare(sql).run(...batch.flat());
      if (result.changes !== batch.length) throw bad();
      batch = [];
      size = 0;
    };
    for (const args of iterable) {
      const length = args.reduce((n, value) => n + bytes(value), 0);
      if (batch.length && (batch.length === 128 || size + length > 256 * 1024)) flush();
      batch.push(args);
      size += length;
    }
    flush();
  }
  // The source module supplies only these two fixed tables/fields. Each update
  // CASes the exact old ciphertext/hash; no selected row can be silently skipped.
  function patches(table, field, fields, patientId, rows) {
    for (let offset = 0; offset < rows.length; offset += 32) {
      const batch = rows.slice(offset, offset + 32);
      const condition = fields.map((key) => key + '=?').join(' AND ');
      const branches = batch.map(() => 'WHEN ' + condition + ' THEN ?').join(' ');
      const sql =
        'UPDATE ' +
        table +
        ' SET ' +
        field +
        '=CASE ' +
        branches +
        ' ELSE ' +
        field +
        ' END WHERE patient_id=? AND (' +
        batch.map(() => '(' + condition + ')').join(' OR ') +
        ')';
      const values = batch.flatMap((row) => [...row.expected, row.value]);
      values.push(patientId, ...batch.flatMap((row) => row.expected));
      if (prepare(sql).run(...values).changes !== batch.length) throw bad();
    }
  }
  function refresh(patient, canonicalRows, profileValue, previous, streams) {
    const prior = new Map(previous.rows.map((row) => [row.kind + ':' + row.id, row]));
    const next = new Map(canonicalRows.map((row) => [row.kind + ':' + row.id, row]));
    const profileHash = hash(profileValue),
      previousHash = hash(previous.profileValue);
    const manifests = prepare(
      'SELECT audience,stream,value FROM cabinet_history_manifests WHERE patient_id=?',
    ).all(patient.id);
    const entryUpdates = [],
      manifestUpdates = [];
    const proofs = new Map();
    const proof = (row) => {
      if (!row || row.patient_id !== patient.id) throw bad();
      if (!proofs.has(row))
        proofs.set(row, {
          kind: row.kind,
          id: row.id,
          position: row.position,
          sourceHash: sourceHash(hash, row),
        });
      return proofs.get(row);
    };
    for (const stream of streams) {
      const source = collection(patient, stream),
        oldSource = collection(previous.patient, stream);
      const kind = stream === 'visit' ? 'visit' : 'appointment',
        expected = new Map();
      const add = (audience, record, old, i) => {
        if (!expected.has(audience))
          expected.set(audience, {
            total: 0,
            photos: 0,
            oldPhotos: 0,
            witness: proof(next.get(kind + ':' + record.id)),
            oldWitness: proof(prior.get(kind + ':' + old.id)),
          });
        const item = expected.get(audience);
        if (eligible(record, stream)) item.total++;
        if (stream === 'visit') {
          item.photos += (record.photos || []).length;
          item.oldPhotos += (old.photos || []).length;
        }
      };
      if (!source.length)
        expected.set('*', { total: 0, photos: 0, oldPhotos: 0, witness: null, oldWitness: null });
      for (let i = 0; i < source.length; i++) {
        const record = source[i],
          old = oldSource[i],
          audiences = ['*', ...(record.staffId ? [hash('staff:' + record.staffId)] : [])];
        const before = prior.get(kind + ':' + record.id),
          after = next.get(kind + ':' + record.id);
        if (!before || !after || before.position !== i || after.position !== i) throw bad();
        for (const audience of audiences) add(audience, record, old, i);
        const same =
          before.value === after.value ||
          Buffer.from(before.value).equals(Buffer.from(after.value));
        if (!same && eligible(record, stream))
          for (const audience of audiences)
            entryUpdates.push({
              expected: [audience, stream, kind, record.id, i, proof(before).sourceHash],
              value: proof(after).sourceHash,
            });
      }
      const selected = manifests.filter((row) => row.stream === stream);
      if (selected.length !== expected.size) throw bad();
      const audiences = [...expected.keys()].filter((value) => value !== '*');
      for (const row of selected) {
        const value = decode(row.value),
          item = expected.get(row.audience);
        if (
          !item ||
          value.version !== 1 ||
          value.patientId !== patient.id ||
          value.audience !== row.audience ||
          value.stream !== stream ||
          value.profileHash !== previousHash ||
          value.total !== item.total ||
          value.photoCount !== item.oldPhotos ||
          JSON.stringify(value.witness) !== JSON.stringify(item.oldWitness) ||
          (row.audience === '*' && JSON.stringify(value.audiences) !== JSON.stringify(audiences))
        )
          throw bad();
        const updated = { ...value, profileHash, photoCount: item.photos, witness: item.witness };
        if (JSON.stringify(value) !== JSON.stringify(updated))
          manifestUpdates.push({
            expected: [row.audience, stream, row.value],
            value: encode(updated),
          });
      }
    }
    patches(
      'cabinet_history_entries',
      'source_hash',
      ['audience', 'stream', 'kind', 'id', 'position', 'source_hash'],
      patient.id,
      entryUpdates,
    );
    patches(
      'cabinet_history_manifests',
      'value',
      ['audience', 'stream', 'value'],
      patient.id,
      manifestUpdates,
    );
  }
  function sync(patient, canonicalRows, profileValue, streams, previous = null) {
    if (!db.isTransaction) throw Error('History index requires the canonical write transaction');
    const retained =
      previous?.patient?.id === patient.id && previous.profileValue && Array.isArray(previous.rows)
        ? streams.filter((stream) => sameLayout(previous.patient, patient, stream))
        : [];
    if (retained.length) refresh(patient, canonicalRows, profileValue, previous, retained);
    const rebuild = streams.filter((stream) => !retained.includes(stream));
    for (const stream of rebuild) {
      prepare('DELETE FROM cabinet_history_entries WHERE patient_id=? AND stream=?').run(
        patient.id,
        stream,
      );
      prepare('DELETE FROM cabinet_history_manifests WHERE patient_id=? AND stream=?').run(
        patient.id,
        stream,
      );
    }
    if (!rebuild.length) return;
    const pending = { cabinet_history_entries: [], cabinet_history_manifests: [] };
    // Flush bounded batches while the pure generator owns only this patient.
    for (const row of historyRows(patient, canonicalRows, profileValue, {
      encode,
      hash,
      selectedStreams: rebuild,
    })) {
      pending[row.table].push(row.args);
      if (pending[row.table].length === 128) {
        bulk(row.table, pending[row.table]);
        pending[row.table] = [];
      }
    }
    for (const [table, rows] of Object.entries(pending)) bulk(table, rows);
  }
  return { sync };
}
module.exports = { createHistoryWrites };
