const { createHistoryIndex } = require('./cabinet-history-index145.cjs');
// Tenant schema 2 canonical records. The calendar tables remain derived indexes.
const COLLECTIONS = Object.freeze({ visit: 'visits', appointment: 'appointments' });
function patientProfile(patient) {
  const { visits, appointments, ...profile } = patient;
  return profile;
}
function createPatientRecords({
  db,
  prepare = db.prepare.bind(db),
  encode,
  decode,
  hash,
  schemaVersion = db.prepare('PRAGMA user_version').get().user_version,
}) {
  const version = schemaVersion;
  if (![0, 1, 2].includes(version)) throw Error('Unsupported cabinet database version');
  if (version !== 2) return null;
  // Fail closed for a partial/malformed migration; never infer canonical data from indexes.
  prepare('SELECT kind,id,patient_id,position,value FROM cabinet_patient_records LIMIT 0').all();
  function rowsFor(ids) {
    const rows = [];
    for (let offset = 0; offset < ids.length; offset += 200)
      rows.push(
        ...prepare(
          'SELECT kind,id,patient_id,position,value FROM cabinet_patient_records ' +
            'WHERE patient_id IN (SELECT value FROM json_each(?)) ORDER BY patient_id,kind,position',
        ).all(JSON.stringify(ids.slice(offset, offset + 200))),
      );
    return rows;
  }
  function recordValue(row) {
    const value = decode(row.value);
    if (!value || value.id !== row.id || !COLLECTIONS[row.kind])
      throw Error('Invalid canonical cabinet record');
    return value;
  }
  const historyIndex = createHistoryIndex({
    db,
    prepare,
    encode,
    decode,
    hash,
    schemaVersion: version,
  });
  const writeReads = new WeakMap();
  function hydrateRows(rows, recordRows, captureWrite = false) {
    const byPatient = new Map();
    const emitted = new Set();
    for (const row of recordRows) {
      let lists = byPatient.get(row.patient_id);
      if (!lists) byPatient.set(row.patient_id, (lists = { visits: [], appointments: [] }));
      const list = lists[COLLECTIONS[row.kind]];
      if (!list || row.position !== list.length) throw Error('Invalid cabinet record order');
      list.push(recordValue(row));
    }
    return rows.map((row) => {
      const profile = decode(row.value);
      if (!profile || profile.id !== row.id || 'visits' in profile || 'appointments' in profile)
        throw Error('Invalid canonical patient profile');
      const lists = byPatient.get(row.id) || { visits: [], appointments: [] };
      const result = { ...profile, ...(emitted.has(row.id) ? structuredClone(lists) : lists) };
      emitted.add(row.id);
      if (captureWrite)
        writeReads.set(result, {
          records: recordRows.filter((record) => record.patient_id === row.id),
          profileValue: row.value,
        });
      return result;
    });
  }
  function hydrate(rows, captureWrite = false) {
    return hydrateRows(rows, rowsFor([...new Set(rows.map((row) => row.id))]), captureWrite);
  }
  function captureWrite(patients) {
    const rows = [],
      seen = new Set();
    for (const patient of patients) {
      const captured = writeReads.get(patient);
      if (!captured || seen.has(patient.id)) return null;
      seen.add(patient.id);
      rows.push(...captured.records);
    }
    return {
      before: new Map(patients.map((patient) => [patient.id, patient])),
      rows,
      profiles: new Map(
        patients.map((patient) => [patient.id, writeReads.get(patient).profileValue]),
      ),
    };
  }
  function appointments(patientId) {
    return prepare(
      "SELECT kind,id,position,value FROM cabinet_patient_records WHERE patient_id=? AND kind='appointment' ORDER BY position",
    )
      .all(patientId)
      .map((row, position) => {
        if (row.position !== position) throw Error('Invalid cabinet record order');
        return recordValue(row);
      });
  }
  // Fresh canonical appointment projection: do not decrypt profiles or visits
  // merely to decorate a visible calendar. Missing patients remain absent.
  function selectedAppointments(patientIds) {
    const ids = [...new Set(patientIds)],
      byPatient = new Map();
    const query = prepare(
      'SELECT p.id patient_id,r.kind,r.id,r.position,r.value FROM patients p ' +
        "LEFT JOIN cabinet_patient_records r ON r.patient_id=p.id AND r.kind='appointment' " +
        'WHERE p.id IN (SELECT value FROM json_each(?)) ORDER BY p.id,r.position',
    );
    for (let offset = 0; offset < ids.length; offset += 200)
      for (const row of query.all(JSON.stringify(ids.slice(offset, offset + 200)))) {
        let list = byPatient.get(row.patient_id);
        if (!list) byPatient.set(row.patient_id, (list = []));
        if (row.kind === null) {
          if (row.id !== null || row.position !== null || row.value !== null || list.length)
            throw Error('Invalid empty canonical appointment projection');
        } else {
          if (row.kind !== 'appointment' || row.position !== list.length)
            throw Error('Invalid cabinet record order');
          list.push(recordValue(row));
        }
      }
    const emitted = new Set();
    return patientIds.flatMap((id) => {
      if (!byPatient.has(id)) return [];
      const appointments = byPatient.get(id),
        duplicate = emitted.has(id);
      emitted.add(id);
      return [{ id, appointments: duplicate ? structuredClone(appointments) : appointments }];
    });
  }
  function appointment(patientId, id) {
    const row = prepare(
      "SELECT kind,id,value FROM cabinet_patient_records WHERE kind='appointment' AND id=? AND patient_id=?",
    ).get(id, patientId);
    return row ? recordValue(row) : null;
  }
  // Caller owns the cabinet transaction and has run the shared full mutation policy.
  function sync(patients, selectedIds, encoder = encode, captured = null) {
    if (!db.isTransaction) throw Error('Cabinet transaction required');
    const ids =
      selectedIds ||
      prepare('SELECT id FROM patients ORDER BY rowid')
        .all()
        .map((r) => r.id);
    const selected = new Set(ids),
      incoming = new Set(patients.map((p) => p.id));
    const profiles = [],
      pendingProfiles = [],
      profilesQuery = prepare(
        'SELECT selected.id,selected.value FROM json_each(?) AS requested CROSS JOIN ' +
          'patients AS selected WHERE selected.id=requested.value ' +
          'ORDER BY CAST(requested.key AS INTEGER)',
      );
    const flushProfiles = () => {
      if (!pendingProfiles.length) return;
      profiles.push(...profilesQuery.all(JSON.stringify(pendingProfiles)));
      pendingProfiles.length = 0;
    };
    for (const id of captured ? [] : ids) {
      if (typeof id !== 'string' || !id.isWellFormed() || id.includes('\0')) {
        flushProfiles();
        const row = prepare('SELECT id,value FROM patients WHERE id=?').get(id);
        if (row) profiles.push(row);
      } else {
        pendingProfiles.push(id);
        if (pendingProfiles.length === 200) flushProfiles();
      }
    }
    flushProfiles();
    // One fresh encrypted record selection feeds hydration and the write diff.
    // Reuse belongs only to this synchronous write transaction, never a later save.
    const recordRows = captured?.rows || rowsFor([...new Set(ids)]),
      present = new Set(profiles.map((row) => row.id));
    const before =
      captured?.before ||
      new Map(
        hydrateRows(
          profiles,
          recordRows.filter((row) => present.has(row.patient_id)),
        ).map((p) => [p.id, p]),
      );
    const oldRecords = new Map(recordRows.map((row) => [row.kind + ':' + row.id, row]));
    const oldValues = new Map();
    for (const patient of before.values())
      for (const [kind, collection] of Object.entries(COLLECTIONS))
        for (const value of patient[collection]) oldValues.set(kind + ':' + value.id, value);
    const retained = new Set(),
      inserts = [],
      removals = new Map(),
      changedProfiles = [];
    const previousPatients = new Map(),
      indexedIds = new Set();
    for (const patient of patients) {
      if (selectedIds && !selected.has(patient.id))
        throw Error('Patient is outside write selection');
      const prior = before.get(patient.id);
      if (!prior || JSON.stringify(prior) !== JSON.stringify(patient)) {
        previousPatients.set(patient.id, prior || null);
        indexedIds.add(patient.id);
      }
      const profile = patientProfile(patient);
      if (!prior || JSON.stringify(patientProfile(prior)) !== JSON.stringify(profile))
        changedProfiles.push({ id: patient.id, value: encoder(profile) });
      for (const [kind, collection] of Object.entries(COLLECTIONS)) {
        if (prior && patient[collection] === prior[collection]) {
          for (const row of recordRows)
            if (row.patient_id === patient.id && row.kind === kind) {
              const key = kind + ':' + row.id;
              if (retained.has(key)) throw Error('Duplicate canonical cabinet record');
              retained.add(key);
            }
          continue;
        }
        patient[collection].forEach((value, position) => {
          const key = kind + ':' + value.id;
          if (retained.has(key)) throw Error('Duplicate canonical cabinet record');
          retained.add(key);
          const old = oldRecords.get(key);
          const same = old && JSON.stringify(oldValues.get(key)) === JSON.stringify(value);
          if (!same || old.patient_id !== patient.id || old.position !== position) {
            if (old) removals.set(key, old);
            inserts.push({
              kind,
              id: value.id,
              patientId: patient.id,
              position,
              value: same ? old.value : encoder(value),
            });
          }
        });
      }
    }
    for (const [key, row] of oldRecords) if (!retained.has(key)) removals.set(key, row);
    // All removals precede inserts, supporting moves/swaps without losing record uniqueness.
    const removeRecord = prepare(
      'DELETE FROM cabinet_patient_records WHERE kind=? AND id=? AND patient_id=?',
    );
    for (const row of removals.values()) removeRecord.run(row.kind, row.id, row.patient_id);
    for (const id of ids)
      if (!incoming.has(id)) {
        prepare('DELETE FROM patients WHERE id=?').run(id);
        indexedIds.add(id);
      }
    for (const row of changedProfiles)
      prepare(
        'INSERT INTO patients(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
      ).run(row.id, row.value);
    const insert = prepare(
      'INSERT INTO cabinet_patient_records(kind,id,patient_id,position,value) VALUES(?,?,?,?,?)',
    );
    for (const row of inserts) insert.run(row.kind, row.id, row.patientId, row.position, row.value);
    if (historyIndex) {
      const canonical = new Map(oldRecords);
      for (const key of removals.keys()) canonical.delete(key);
      for (const row of inserts)
        canonical.set(row.kind + ':' + row.id, { ...row, patient_id: row.patientId });
      for (const id of indexedIds) {
        const patient = patients.find((value) => value.id === id);
        if (!patient) historyIndex.remove(id);
        else {
          const profileValue = prepare('SELECT value FROM patients WHERE id=?').get(id)?.value;
          if (!profileValue) throw Error('Missing canonical history profile');
          historyIndex.syncPatient(
            patient,
            [...canonical.values()].filter((row) => row.patient_id === id),
            profileValue,
            {
              patient: before.get(id),
              rows: recordRows.filter((row) => row.patient_id === id),
              profileValue:
                captured?.profiles?.get(id) || profiles.find((row) => row.id === id)?.value,
            },
          );
        }
      }
    }
    return { previousPatients, indexedIds };
  }
  return {
    historyIndex,
    hydrate,
    hydrateRows,
    captureWrite,
    appointments,
    selectedAppointments,
    appointment,
    sync,
  };
}
function prepareRecordCiphers({ before, next }, version, encode) {
  const result = new Map();
  const add = (old, value) => {
    const serialized = JSON.stringify(value);
    if (!old || JSON.stringify(old) !== serialized) result.set(serialized, encode(value));
  };
  const prior = new Map(before.patients.map((patient) => [patient.id, patient]));
  for (const patient of next.patients) {
    const old = prior.get(patient.id);
    if (version !== 2) add(old, patient);
    else {
      add(old && patientProfile(old), patientProfile(patient));
      for (const collection of Object.values(COLLECTIONS)) {
        if (old?.[collection] === patient[collection]) continue;
        const previous = new Map((old?.[collection] || []).map((record) => [record.id, record]));
        for (const record of patient[collection]) add(previous.get(record.id), record);
      }
    }
  }
  const services = new Map(before.services.map((service) => [service.id, service]));
  for (const service of next.services) add(services.get(service.id), service);
  return result;
}
module.exports = { createPatientRecords, patientProfile, prepareRecordCiphers };
