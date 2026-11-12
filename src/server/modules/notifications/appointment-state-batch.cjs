const { fingerprint, serviceFingerprint } = require('./appointments.cjs');
const { isActiveAppointment } = require('../../../shared/appointment-status.cjs');

const pairKey = (patient, appointment) => JSON.stringify([patient, appointment]);
function appointmentRows(patients, zone, confirmations) {
  return patients.flatMap((patient) =>
    (patient.appointments || []).map((a) => {
      const identity = confirmations.identity
        ? confirmations.identity(a, zone)
        : {
            fingerprint: fingerprint(a, zone),
            services: serviceFingerprint(a),
            stamp: confirmations.stamp(a, zone),
          };
      return {
        patient: patient.id,
        appointment: a.id,
        ...identity,
        active: isActiveAppointment(a),
      };
    }),
  );
}

// Fixed SQL, bound JSON input and small chunks: prepared statements do not grow
// with the calendar size. Every caller includes its organization predicate.
// The callers drive CROSS JOIN from the requested rows, so a large tenant's
// full receipt history never becomes the outer loop of each small batch.
function createBatchQuery(db, sql) {
  let statement;
  const prepared = () =>
    (statement ||= db.prepare('WITH request_scope(org,entries) AS (VALUES(?,?)) ' + sql));
  const query = (org, entries) => {
    const result = [];
    if (!entries.length) return result;
    for (let offset = 0; offset < entries.length; offset += 200)
      result.push(...prepared().all(org, JSON.stringify(entries.slice(offset, offset + 200))));
    return result;
  };
  // Opaque requests borrow this same statement/SQL and bound values. They grant
  // no authority and are usable only in the driver's current physical RO frame.
  query.readRequests = (org, entries) => {
    if (!db.canPrefetchReads || !entries.length || entries.length > 6400) return [];
    const statement = prepared();
    if (!statement.readRequest) return [];
    const requests = [];
    for (let offset = 0; offset < entries.length; offset += 200)
      requests.push(
        statement.readRequest('all', [org, JSON.stringify(entries.slice(offset, offset + 200))]),
      );
    return requests;
  };
  return query;
}

module.exports = { appointmentRows, pairKey, createBatchQuery };
