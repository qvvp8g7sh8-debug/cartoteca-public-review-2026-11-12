const { isDeepStrictEqual: same } = require('node:util');
const { fail } = require('../../shared/errors.cjs');
const { isActiveAppointment } = require('../../shared/appointment-status.cjs');
const { patientNameParts } = require('../../shared/patient-names.cjs');
const { validateState } = require('../modules/cabinet/validation.cjs');
const conflict = () =>
  fail(409, 'Эта карточка или услуга уже изменена. Обновите страницу перед повторным сохранением.');
const profile = ({ visits, appointments, ...value }) => value;
const linked = (value) => value?.status === 'completed' || value?.completedVisitId !== undefined;
// A private schema2 port. No HTTP field can brand a compact snapshot. All policy,
// platform effects and receipts still run through the ordinary mutation owner.
function createAppointmentWriter145({
  prepare,
  runWrites,
  encode,
  decode,
  get,
  set,
  audit,
  hash,
  clock,
  generation,
  active,
  records,
  indexes,
  calendarOccupancy,
  readSelected,
  freeze,
  historyIndex,
}) {
  const writeRows =
    runWrites ||
    ((entries) => {
      for (const entry of entries) prepare(entry.sql).run(...entry.args);
    });
  const reads = new WeakMap(),
    owned = new WeakSet(),
    audience = (staff) => hash('staff:' + staff);
  function read(descriptor, current) {
    if (!active()) throw Error('Appointment mutation requires transaction');
    if (!records || !['owner', 'salon_admin'].includes(current.role) || !descriptor) return null;
    if (descriptor.changes.some((change) => linked(change.before) || linked(change.after)))
      return null;
    // The point command's canonical preparation has an explicit row/byte
    // bound. Larger sources select the existing full-work path before any
    // materialization/write; this never lowers HTTP admission based on input.
    if (descriptor.bounded) {
      const measured = prepare(
        "SELECT COUNT(*) n,COALESCE(SUM(length(value)),0) bytes FROM cabinet_patient_records WHERE patient_id=? AND kind='appointment'",
      ).get(descriptor.patientId);
      const profileBytes = prepare('SELECT length(value) bytes FROM patients WHERE id=?').get(
        descriptor.patientId,
      );
      if (
        measured.n > 200 ||
        measured.bytes > 1024 * 1024 ||
        (profileBytes?.bytes || 0) > 128 * 1024
      )
        return null;
    }
    const row = prepare('SELECT id,value FROM patients WHERE id=?').get(descriptor.patientId);
    if (!row) return null;
    const patient = decode(row.value);
    if (patient.id !== row.id || 'visits' in patient || 'appointments' in patient)
      throw Error('Invalid canonical appointment profile');
    const rows = prepare(
      "SELECT kind,id,position,value FROM cabinet_patient_records WHERE patient_id=? AND kind='appointment' ORDER BY position",
    ).all(patient.id);
    const appointments = rows.map((item, position) => {
      const value = decode(item.value);
      if (item.position !== position || value?.id !== item.id)
        throw Error('Invalid canonical appointment order');
      return value;
    });
    if (appointments.some(linked)) return null;
    const expected = descriptor.legacyBefore;
    if (expected) {
      if (!same(patient, profile(expected))) throw conflict();
      const count = prepare(
        "SELECT COUNT(*) n FROM cabinet_patient_records WHERE patient_id=? AND kind='visit'",
      ).get(patient.id).n;
      if (count !== expected.visits.length) throw conflict();
      for (let offset = 0; offset < count; offset += 200) {
        const bytes = prepare(
          "SELECT COALESCE(SUM(length(value)),0) n FROM cabinet_patient_records WHERE patient_id=? AND kind='visit' AND position>=? AND position<?",
        ).get(patient.id, offset, offset + 200).n;
        // An unusual huge historical batch retains the existing full-read path.
        if (bytes > 32 * 1024 * 1024) return null;
        const visits = prepare(
          "SELECT id,position,value FROM cabinet_patient_records WHERE patient_id=? AND kind='visit' AND position>=? AND position<? ORDER BY position",
        ).all(patient.id, offset, offset + 200);
        if (visits.length !== Math.min(200, count - offset)) throw conflict();
        for (let n = 0; n < visits.length; n++) {
          const visit = visits[n],
            wanted = expected.visits[offset + n];
          if (
            visit.position !== offset + n ||
            visit.id !== wanted.id ||
            !same(decode(visit.value), wanted)
          )
            throw conflict();
        }
      }
    }
    const value = {
      revision: get('revision', 0),
      initialized: get('initialized', false),
      patients: [{ ...patient, visits: [], appointments }],
      services: [],
    };
    owned.add(value);
    if (expected) freeze(expected.visits);
    reads.set(value, {
      generation: generation(),
      clock: clock(),
      rows,
      history: expected?.visits,
    });
    return freeze(value);
  }
  function summaries(patient) {
    const existing = prepare('SELECT audience,value FROM cabinet_summaries WHERE patient_id=?').all(
        patient.id,
      ),
      keep = new Set([
        '*',
        ...[patient.createdBy, ...patient.appointments.map((a) => a.staffId)]
          .filter(Boolean)
          .map(audience),
      ]),
      prior = new Map(existing.map((row) => [row.audience, decode(row.value)]));
    for (const [key, value] of prior) {
      if (
        value.id !== patient.id ||
        !Number.isSafeInteger(value.visitCount) ||
        value.visitCount < 0
      )
        throw Error('Invalid canonical patient summary');
      if (value.visitCount) keep.add(key);
    }
    function* updates() {
      for (const key of prior.keys())
        if (!keep.has(key))
          yield {
            sql: 'DELETE FROM cabinet_summaries WHERE patient_id=? AND audience=?',
            args: [patient.id, key],
          };
      for (const key of keep) {
        const appointments = patient.appointments.filter(
            (a) =>
              isActiveAppointment(a) && (key === '*' || (a.staffId && audience(a.staffId) === key)),
          ),
          old = prior.get(key),
          value = {
            ...(old || {
              id: patient.id,
              name: patient.name,
              ...Object.fromEntries(
                ['firstName', 'lastName', 'middleName', 'designation']
                  .filter((name) => patient[name] !== undefined)
                  .map((name) => [name, patient[name]]),
              ),
              phone: patient.phone || '',
              visitCount: 0,
              lastVisit: null,
            }),
            appointments: appointments.map((a) => ({
              id: a.id,
              date: a.date,
              time: a.time,
              service: a.service || '',
              duration: a.duration || 60,
            })),
          };
        const previousCipher196 = existing.find((row) => row.audience === key)?.value;
        if (indexes.directoryProjection164?.unchanged196?.(value, key, previousCipher196)) continue;
        const cipher = encode(value);
        yield {
          sql: 'INSERT INTO cabinet_summaries(patient_id,audience,value) VALUES(?,?,?) ON CONFLICT(patient_id,audience) DO UPDATE SET value=excluded.value',
          args: [patient.id, key, cipher],
        };
        const projection = indexes.directoryProjection164?.statement(value, key, cipher);
        if (projection) yield projection;
      }
    }
    writeRows(updates());
  }
  function write(payload, before, { appointmentOnly = false } = {}) {
    const captured = reads.get(before);
    reads.delete(before);
    if (
      !captured ||
      !active() ||
      captured.generation !== generation() ||
      captured.clock !== clock()
    )
      throw Error('Appointment mutation snapshot is no longer current');
    validateState(payload);
    if (
      payload.patients.length !== 1 ||
      payload.services.length ||
      payload.patients[0].id !== before.patients[0].id ||
      !same(profile(payload.patients[0]), profile(before.patients[0])) ||
      payload.patients[0].visits.length ||
      payload.patients[0].appointments.some(linked)
    )
      throw Error('Appointment writer cannot change profile/history');
    if (payload.revision !== get('revision', 0))
      throw fail(
        409,
        'Картотека изменилась в другой вкладке. Обновите страницу перед повторным сохранением.',
      );
    const patient = payload.patients[0],
      previous = before.patients[0];
    indexes.assertUnique([patient], [patient.id]);
    const old = new Map(
        captured.rows.map((row, n) => [row.id, { row, value: previous.appointments[n] }]),
      ),
      removed = [],
      inserted = [];
    patient.appointments.forEach((value, position) => {
      const prior = old.get(value.id);
      if (!prior || prior.row.position !== position || !same(prior.value, value)) {
        if (prior) removed.push(value.id);
        inserted.push({
          value,
          position,
          cipher: prior && same(prior.value, value) ? prior.row.value : encode(value),
        });
      }
      old.delete(value.id);
    });
    removed.push(...old.keys());
    function* writes() {
      for (const id of removed) {
        yield* [
          {
            sql: "DELETE FROM cabinet_patient_records WHERE kind='appointment' AND id=? AND patient_id=?",
            args: [id, patient.id],
          },
          { sql: 'DELETE FROM cabinet_days WHERE appointment_id=?', args: [id] },
          {
            sql: 'DELETE FROM cabinet_appointments WHERE id=? AND patient_id=?',
            args: [id, patient.id],
          },
          {
            sql: "DELETE FROM cabinet_record_ids WHERE kind='appointment' AND id=? AND patient_id=?",
            args: [id, patient.id],
          },
        ];
      }
      for (const { value: a, position, cipher } of inserted) {
        yield* [
          {
            sql: 'INSERT INTO cabinet_patient_records(kind,id,patient_id,position,value) VALUES(?,?,?,?,?)',
            args: ['appointment', a.id, patient.id, position, cipher],
          },
          {
            sql: 'INSERT INTO cabinet_record_ids(kind,id,patient_id) VALUES(?,?,?)',
            args: ['appointment', a.id, patient.id],
          },
          {
            sql: 'INSERT INTO cabinet_appointments(id,patient_id,value) VALUES(?,?,?)',
            args: [
              a.id,
              patient.id,
              encode({
                ...a,
                patientId: patient.id,
                patientName: patientNameParts(patient).lastFirst,
              }),
            ],
          },
        ];
        const end = Date.parse(a.date + 'T' + a.time + ':00Z') + (a.duration || 60) * 60000;
        for (let date = Date.parse(a.date + 'T00:00:00Z'); date < end; date += 86400000)
          yield {
            sql: 'INSERT INTO cabinet_days(day_hash,appointment_id) VALUES(?,?)',
            args: [hash('day:' + new Date(date).toISOString().slice(0, 10)), a.id],
          };
      }
    }
    writeRows(writes());
    summaries(patient);
    calendarOccupancy.update([patient], new Set([patient.id]), new Map([[patient.id, previous]]));
    historyIndex?.syncAppointments(
      patient.id,
      previous.appointments,
      patient.appointments,
      captured.rows,
    );
    const revision = get('revision', 0) + 1;
    set('revision', revision);
    set('initialized', true);
    audit('cabinet_saved', { patients: 1, services: 0, partial: true });
    // Only the privately branded non-linked appointment path can emit a delta.
    // A full card is still read on demand; no empty history becomes authoritative.
    if (appointmentOnly)
      return { revision, patients: [patient], services: [], appointmentOnly: true };
    // Legacy PATCH already supplied unchanged history which this transaction
    // stream-verified. Typed POST hydrates it once solely for its existing reply.
    const patients = captured.history
      ? [{ ...patient, visits: captured.history }]
      : readSelected([patient.id], []).patients;
    return { revision, patients, services: [] };
  }
  return { read, write, owns: (value) => owned.has(value) };
}
module.exports = { createAppointmentWriter145 };
