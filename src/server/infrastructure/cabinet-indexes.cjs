const { isActiveAppointment } = require('../../shared/appointment-status.cjs');
const { patientNameParts } = require('../../shared/patient-names.cjs');
const { migrateCabinetIndexes } = require('../migrations/001-cabinet-indexes.cjs');
const { fail } = require('../../shared/errors.cjs');
const { createIndexReplacement } = require('./cabinet-index-delta.cjs');
const { createDirectoryProjectionWriter164 } = require('./cabinet-directory-projection164.cjs');
function createCabinetIndexes({
  db,
  directory,
  encode,
  decode,
  hash,
  prepare = (sql) => db.prepare(sql),
  schemaVersion = db.prepare('PRAGMA user_version').get().user_version,
}) {
  const audience = (staff) => hash('staff:' + staff);
  const directoryProjection164 = createDirectoryProjectionWriter164({
    // This adjunct is explicitly prepared for native PG stores only. Legacy
    // SQLite/index-only factories never query or activate an optional marker.
    prepare: db.dialect === 'postgres' && db.transactionIntent !== 'READONLY' ? prepare : undefined,
    encode,
    decode,
    hash,
    logicalState196: db.revisionProfile === 3 ? db.directoryState196 : null,
  });
  function summary(patient, staff) {
    const visits = staff ? patient.visits.filter((v) => v.staffId === staff) : patient.visits;
    const appointments = (
      staff ? patient.appointments.filter((a) => a.staffId === staff) : patient.appointments
    ).filter((a) => isActiveAppointment(a));
    const last = visits.reduce((prior, v) => (!prior || v.date > prior.date ? v : prior), null);
    return {
      id: patient.id,
      name: patient.name,
      ...Object.fromEntries(
        ['firstName', 'lastName', 'middleName', 'designation']
          .filter((key) => patient[key] !== undefined)
          .map((key) => [key, patient[key]]),
      ),
      phone: patient.phone || '',
      visitCount: visits.length,
      lastVisit: last ? { date: last.date, procedure: last.procedure || '' } : null,
      appointments: appointments.map((a) => ({
        id: a.id,
        date: a.date,
        time: a.time,
        service: a.service || '',
        duration: a.duration || 60,
      })),
    };
  }
  function remove(id, { keepSummaries196 = false } = {}) {
    prepare(
      'DELETE FROM cabinet_days WHERE appointment_id IN (SELECT id FROM cabinet_appointments WHERE patient_id=?)',
    ).run(id);
    for (const table of [
      'cabinet_summaries',
      'cabinet_patient_counts',
      'cabinet_record_ids',
      'cabinet_appointments',
      'cabinet_photo_refs',
    ].filter((table) => !keepSummaries196 || table !== 'cabinet_summaries'))
      prepare('DELETE FROM ' + table + ' WHERE patient_id=?').run(id);
  }
  function putSummaries(patient) {
    const staff = new Set(
      [
        patient.createdBy,
        ...patient.visits.map((v) => v.staffId),
        ...patient.appointments.map((a) => a.staffId),
      ].filter(Boolean),
    );
    const insertSummary = prepare(
      'INSERT INTO cabinet_summaries(patient_id,audience,value) VALUES(?,?,?)',
    );
    const put = (target, value) => {
      const cipher = encode(value);
      insertSummary.run(patient.id, target, cipher);
      directoryProjection164.write(value, target, cipher);
    };
    put('*', summary(patient));
    for (const id of staff) put(audience(id), summary(patient, id));
  }
  function put(patient, { keepSummaries196 = false } = {}) {
    if (!keepSummaries196) putSummaries(patient);
    let photos = 0;
    const record = prepare('INSERT INTO cabinet_record_ids(kind,id,patient_id) VALUES(?,?,?)');
    for (const v of patient.visits) {
      record.run('visit', v.id, patient.id);
      for (const ph of v.photos || []) {
        photos++;
        const id = ph.data.match(/^\/api\/photos\/([a-f0-9]{32})$/)?.[1];
        if (id)
          prepare(
            'INSERT OR IGNORE INTO cabinet_photo_refs(photo_id,patient_id,audience) VALUES(?,?,?)',
          ).run(id, patient.id, audience(v.staffId || ''));
      }
    }
    prepare('INSERT INTO cabinet_patient_counts(patient_id,photo_count) VALUES(?,?)').run(
      patient.id,
      photos,
    );
    putAppointments(patient, patient.appointments);
  }
  function putAppointments(patient, appointments) {
    const record = prepare('INSERT INTO cabinet_record_ids(kind,id,patient_id) VALUES(?,?,?)');
    const appointment = prepare(
      'INSERT INTO cabinet_appointments(id,patient_id,value) VALUES(?,?,?)',
    );
    const day = prepare('INSERT INTO cabinet_days(day_hash,appointment_id) VALUES(?,?)');
    for (const a of appointments) {
      record.run('appointment', a.id, patient.id);
      appointment.run(
        a.id,
        patient.id,
        encode({
          ...a,
          patientId: patient.id,
          patientName: patientNameParts(patient).lastFirst,
        }),
      );
      const start = Date.parse(a.date + 'T' + a.time + ':00Z'),
        end = start + (a.duration || 60) * 60000;
      for (let date = Date.parse(a.date + 'T00:00:00Z'); date < end; date += 86400000)
        day.run(hash('day:' + new Date(date).toISOString().slice(0, 10)), a.id);
    }
  }
  function preserveSummaries196(patient) {
    if (!directoryProjection164.logical196) return false;
    const targets = new Map([['*', summary(patient)]]);
    const staff = new Set(
      [
        patient.createdBy,
        ...patient.visits.map((v) => v.staffId),
        ...patient.appointments.map((a) => a.staffId),
      ].filter(Boolean),
    );
    for (const id of staff) targets.set(audience(id), summary(patient, id));
    const existing = prepare('SELECT audience,value FROM cabinet_summaries WHERE patient_id=?').all(
      patient.id,
    );
    return (
      existing.length === targets.size &&
      existing.every(
        (row) =>
          targets.has(row.audience) &&
          directoryProjection164.unchanged196(targets.get(row.audience), row.audience, row.value),
      )
    );
  }
  const replace = createIndexReplacement({
    prepare,
    remove,
    put,
    putSummaries,
    putAppointments,
    preserveSummaries196,
  });
  // Schema 2 has the same derived indexes; its explicit migration owns canonical records.
  // Do not alter or re-run the historical version-1 migration against normalized profiles.
  if (![0, 1, 2].includes(schemaVersion)) throw Error('Unsupported cabinet database version');
  // A prepared schema needs no migration checks. The version was read from this
  // connection at open, never retained across tenants or connection lifetimes.
  if (schemaVersion === 0)
    migrateCabinetIndexes({
      db,
      directory,
      rebuild() {
        replace(
          prepare('SELECT value FROM patients')
            .all()
            .map((row) => decode(row.value)),
          [],
        );
      },
    });
  function assertUnique(patients, changedIds) {
    const changed = new Set(changedIds),
      entries = [];
    let query;
    const checkOwner = (prior) => {
      if (prior && !changed.has(prior.patient_id))
        throw fail(400, 'Идентификаторы записей должны быть уникальными.');
    };
    const check = () => {
      if (!entries.length) return;
      query ||= prepare(
        'SELECT existing.patient_id FROM json_each(?) AS requested CROSS JOIN ' +
          'cabinet_record_ids AS existing WHERE ' +
          "existing.kind=json_extract(requested.value,'$.kind') AND " +
          "existing.id=json_extract(requested.value,'$.id')",
      );
      for (const prior of query.all(JSON.stringify(entries))) checkOwner(prior);
      entries.length = 0;
    };
    for (const p of patients)
      for (const [kind, records] of [
        ['visit', p.visits],
        ['appointment', p.appointments],
      ])
        for (const record of records) {
          // JSONB rejects malformed Unicode/NUL that old parameter binding handled.
          // Preserve legacy point semantics for those rare IDs, including failures.
          if (
            typeof record.id !== 'string' ||
            !record.id.isWellFormed() ||
            record.id.includes('\0')
          ) {
            check();
            checkOwner(
              prepare('SELECT patient_id FROM cabinet_record_ids WHERE kind=? AND id=?').get(
                kind,
                record.id,
              ),
            );
          } else {
            entries.push({ kind, id: record.id });
            if (entries.length === 200) check();
          }
        }
    check();
  }
  const reads = require('./cabinet-index-reads145.cjs').createCabinetIndexReads({
    prepare,
    decode,
    hash,
    db,
  });
  function photoVisible(id, current) {
    return Boolean(
      prepare('SELECT 1 FROM cabinet_photo_refs WHERE photo_id=? AND audience=? LIMIT 1').get(
        id,
        audience(current.accountId),
      ),
    );
  }
  function totals() {
    return {
      patients: prepare('SELECT COUNT(*) n FROM patients').get().n,
      services: prepare('SELECT COUNT(*) n FROM services').get().n,
      photos: prepare('SELECT COALESCE(SUM(photo_count),0) n FROM cabinet_patient_counts').get().n,
    };
  }
  return { replace, assertUnique, ...reads, photoVisible, totals, directoryProjection164 };
}
module.exports = { createCabinetIndexes };
