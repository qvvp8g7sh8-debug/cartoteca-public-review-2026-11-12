const { fingerprint, serviceFingerprint } = require('../notifications/appointments.cjs');
const { isActiveAppointment } = require('../../../shared/appointment-status.cjs');
const { createBatchQuery, pairKey } = require('../notifications/appointment-state-batch.cjs');
function createAppointmentConfirmations({ db, seal, open, crypto, audit, notify = () => {} }) {
  const readRows = createBatchQuery(
    db,
    `SELECT c.patient_id,c.appointment_id,c.value,
    json_extract(r.value,'$.stamp') expected_stamp
    FROM json_each((SELECT entries FROM request_scope)) r
    CROSS JOIN appointment_manual_confirmations c ON c.patient_id=json_extract(r.value,'$.patient')
      AND c.appointment_id=json_extract(r.value,'$.appointment')
    WHERE c.organization_id=(SELECT org FROM request_scope)`,
  );
  const actorsQuery = createBatchQuery(
    db,
    `SELECT a.id,a.value FROM json_each((SELECT entries FROM request_scope)) r
    CROSS JOIN accounts a ON a.id=r.value
    JOIN memberships m ON m.account_id=a.id
    WHERE m.organization_id=(SELECT org FROM request_scope)`,
  );
  const receiptQuery = db.prepare(
    'SELECT value FROM appointment_manual_confirmations WHERE organization_id=? AND patient_id=? AND appointment_id=?',
  );
  const actorQuery = db.prepare(
    'SELECT a.value FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE m.organization_id=? AND a.id=?',
  );
  function stampParts(a, appointmentFingerprint, services) {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify([appointmentFingerprint, services, a.roomId || '']))
      .digest('hex');
  }
  function stamp(a, zone) {
    return stampParts(a, fingerprint(a, zone), serviceFingerprint(a));
  }
  // A read batch needs both source hashes as well as their combined stamp.
  // Compute them together; ordinary mutation checks still derive their own stamp.
  function identity(a, zone) {
    const appointmentFingerprint = fingerprint(a, zone),
      services = serviceFingerprint(a);
    return {
      fingerprint: appointmentFingerprint,
      services,
      stamp: stampParts(a, appointmentFingerprint, services),
    };
  }
  function read(org, patient, a, zone) {
    if (!isActiveAppointment(a)) return null;
    const row = receiptQuery.get(org, patient, a.id);
    const saved = row ? open(row.value) : null;
    if (!saved || saved.stamp !== stamp(a, zone)) return null;
    const account = actorQuery.get(org, saved.actorId);
    return {
      manualConfirmedAt: saved.confirmedAt,
      manualConfirmedBy: account ? open(account.value).displayName : 'Сотрудник',
    };
  }
  function readMany(org, entries) {
    const result = new Map(),
      actors = new Map(),
      confirmed = [];
    for (const row of readRows(
      org,
      entries.filter((entry) => entry.active),
    )) {
      const saved = open(row.value);
      if (saved.stamp === row.expected_stamp) confirmed.push({ row, saved });
    }
    let pending = [];
    const flush = () => {
      if (!pending.length) return;
      for (const row of actorsQuery(org, pending)) actors.set(row.id, open(row.value).displayName);
      pending = [];
    };
    for (const { saved } of confirmed) {
      const id = saved.actorId;
      if (actors.has(id)) continue;
      // Preserve the old text-binding behavior for unusual legacy identifiers;
      // PostgreSQL JSON cannot represent lone UTF-16 surrogates or NUL.
      if (typeof id !== 'string' || !id.isWellFormed() || id.includes('\0')) {
        flush();
        const account = actorQuery.get(org, id);
        actors.set(id, account ? open(account.value).displayName : 'Сотрудник');
      } else {
        actors.set(id, 'Сотрудник');
        pending.push(id);
        if (pending.length === 200) flush();
      }
    }
    flush();
    for (const { row, saved } of confirmed)
      result.set(pairKey(row.patient_id, row.appointment_id), {
        manualConfirmedAt: saved.confirmedAt,
        manualConfirmedBy: actors.get(saved.actorId),
      });
    return result;
  }
  readMany.readRequests = (org, entries) =>
    readRows.readRequests(
      org,
      entries.filter((entry) => entry.active),
    );
  readMany.actorReadRequests = (org, entries) => {
    const requests = [],
      ids = new Set();
    for (const row of readRows(
      org,
      entries.filter((entry) => entry.active),
    )) {
      const saved = open(row.value);
      if (saved.stamp === row.expected_stamp) ids.add(saved.actorId);
    }
    let pending = [];
    const flush = () => {
      requests.push(...actorsQuery.readRequests(org, pending));
      pending = [];
    };
    for (const id of ids) {
      if (typeof id !== 'string' || !id.isWellFormed() || id.includes('\0')) {
        flush();
        if (actorQuery.readRequest) requests.push(actorQuery.readRequest('get', [org, id]));
      } else {
        pending.push(id);
        if (pending.length === 200) flush();
      }
    }
    flush();
    return requests;
  };
  // Caller holds platform then cabinet locks and has authorized the current appointment.
  function set(org, patient, a, zone, actor, confirmed, now = Date.now()) {
    const prior = read(org, patient, a, zone);
    if ((confirmed && prior) || (!confirmed && !prior)) return prior;
    if (confirmed)
      db.prepare('INSERT OR REPLACE INTO appointment_manual_confirmations VALUES(?,?,?,?)').run(
        org,
        patient,
        a.id,
        seal({ stamp: stamp(a, zone), actorId: actor, confirmedAt: now }),
      );
    else
      db.prepare(
        'DELETE FROM appointment_manual_confirmations WHERE organization_id=? AND patient_id=? AND appointment_id=?',
      ).run(org, patient, a.id);
    audit(
      confirmed ? 'appointment_manually_confirmed' : 'appointment_manual_confirmation_removed',
      actor,
      org,
      { patientId: patient, appointmentId: a.id },
    );
    if (confirmed) notify(org, patient, a);
    return read(org, patient, a, zone);
  }
  function invalidateChanges(org, before, next, zone) {
    const updated = new Map(
      next.patients.flatMap((p) => p.appointments.map((a) => [a.id, { a, patientId: p.id }])),
    );
    for (const p of before.patients)
      for (const a of p.appointments) {
        const current = updated.get(a.id);
        if (
          !current ||
          !isActiveAppointment(current.a) ||
          current.patientId !== p.id ||
          stamp(a, zone) !== stamp(current.a, zone)
        )
          db.prepare(
            'DELETE FROM appointment_manual_confirmations WHERE organization_id=? AND patient_id=? AND appointment_id=?',
          ).run(org, p.id, a.id);
      }
  }
  function invalidateZone(org) {
    db.prepare('DELETE FROM appointment_manual_confirmations WHERE organization_id=?').run(org);
  }
  return { stamp, identity, read, readMany, set, invalidateChanges, invalidateZone };
}
module.exports = { createAppointmentConfirmations };
