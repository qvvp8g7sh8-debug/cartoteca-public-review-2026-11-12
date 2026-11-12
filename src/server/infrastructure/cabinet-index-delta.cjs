// Reuse visit/photo indexes only when every non-appointment field is unchanged.
// All removals precede inserts, preserving valid moves between patients in one commit.
function createIndexReplacement({
  prepare,
  remove,
  put,
  putSummaries,
  putAppointments,
  preserveSummaries196 = () => false,
}) {
  const rest = (patient) => JSON.stringify({ ...patient, appointments: null });
  function plan(patient, before) {
    if (!before || rest(before) !== rest(patient)) return null;
    const prior = new Map(before.appointments.map((row) => [row.id, row]));
    const changed = [],
      removed = [];
    for (const row of patient.appointments) {
      const old = prior.get(row.id);
      if (!old || JSON.stringify(old) !== JSON.stringify(row)) {
        changed.push(row);
        if (old) removed.push(row.id);
      }
      prior.delete(row.id);
    }
    removed.push(...prior.keys());
    return { changed, removed };
  }
  return function replace(patients, ids, before = new Map()) {
    const deltas = new Map();
    // Capture authenticated semantic equality BEFORE any summary DELETE. The
    // default/legacy callback is false and preserves the original write plan.
    const kept196 = new Set(patients.filter(preserveSummaries196).map((p) => p.id));
    for (const patient of patients) {
      const delta = plan(patient, before.get(patient.id));
      if (delta) deltas.set(patient.id, delta);
    }
    for (const id of ids) {
      const delta = deltas.get(id);
      if (!delta) {
        if (kept196.has(id)) remove(id, { keepSummaries196: true });
        else remove(id);
        continue;
      }
      if (!kept196.has(id)) prepare('DELETE FROM cabinet_summaries WHERE patient_id=?').run(id);
      for (const appointmentId of delta.removed) {
        prepare('DELETE FROM cabinet_days WHERE appointment_id=?').run(appointmentId);
        prepare('DELETE FROM cabinet_appointments WHERE id=? AND patient_id=?').run(
          appointmentId,
          id,
        );
        prepare(
          "DELETE FROM cabinet_record_ids WHERE kind='appointment' AND id=? AND patient_id=?",
        ).run(appointmentId, id);
      }
    }
    for (const patient of patients) {
      const delta = deltas.get(patient.id);
      if (!delta) {
        if (kept196.has(patient.id)) put(patient, { keepSummaries196: true });
        else put(patient);
      } else {
        if (!kept196.has(patient.id)) putSummaries(patient);
        putAppointments(patient, delta.changed);
      }
    }
  };
}
module.exports = { createIndexReplacement };
