// Read-only provenance, independent of current date, staff or confirmation status.
// Keep only identifiers/stamps in a bounded organization cache, never contact data.
const { createBatchQuery } = require('../notifications/appointment-state-batch.cjs');
function createBookingRequestOrigins(
  { db, open },
  { maxOrganizations = 256, maxEntries = 20000 } = {},
) {
  if (
    !Number.isSafeInteger(maxOrganizations) ||
    maxOrganizations < 1 ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1
  )
    throw Error('Invalid provenance cache bounds.');
  const cache = new Map();
  let retained = 0;
  const retainedRequests =
    "FROM booking_requests WHERE organization_id=? AND status IN ('accepted','pending','requested','expired')";
  const rows = db.prepare('SELECT id,substr(value,1,28) stamp ' + retainedRequests);
  const presence = db.prepare('SELECT 1 AS present ' + retainedRequests + ' LIMIT 1');
  const values = createBatchQuery(
    db,
    `SELECT b.id,b.value FROM json_each((SELECT entries FROM request_scope)) r
    CROSS JOIN booking_requests b ON b.id=r.value
    WHERE b.organization_id=(SELECT org FROM request_scope)`,
  );
  function appointmentSources(org, patients, storage) {
    if (!patients.some((p) => p.appointments?.length)) return new Set();
    const owned = !db.isTransaction;
    if (owned) db.exec('BEGIN DEFERRED');
    try {
      const result = readSources(org, patients, storage);
      if (owned) db.exec('COMMIT');
      return result;
    } catch (error) {
      if (owned) db.exec('ROLLBACK');
      throw error;
    }
  }
  function readSources(org, patients, storage) {
    // Empty native response snapshots do not need cursor open/fetch/close.
    // A nonempty history keeps the original streaming provenance and commit proof.
    if (db.canPrefetchReads && !presence.get(org)) return new Set();
    const previous = cache.get(org) || new Map(),
      requests = new Map(),
      origins = new Map();
    const changed = [];
    for (const row of rows.iterate(org)) {
      const stamp = Buffer.from(row.stamp).toString('hex');
      let entry = previous.get(row.id);
      if (!entry || entry.stamp !== stamp) {
        changed.push(row.id);
        entry = { stamp, pair: '' };
      }
      requests.set(row.id, entry);
    }
    // The stamp scan remains streaming. Only the already bounded JSON value
    // queries share a read-only RPC; cabinet acceptance still reads its own owner.
    if (db.canPrefetchReads) {
      const requests = values.readRequests(org, changed);
      if (requests.length && requests.length <= 32) db.prefetchReads(requests);
    }
    for (const row of values(org, changed)) {
      const value = open(row.value);
      requests.get(row.id).pair =
        value.acceptance?.patientId && value.appointmentId
          ? JSON.stringify([value.acceptance.patientId, value.appointmentId])
          : '';
    }
    for (const [id, entry] of requests) if (entry.pair) origins.set(entry.pair, id);
    retained -= cache.get(org)?.size || 0;
    cache.delete(org);
    if (requests.size <= maxEntries) {
      cache.set(org, requests);
      retained += requests.size;
    }
    while (cache.size > maxOrganizations || retained > maxEntries) {
      const oldest = cache.keys().next().value;
      retained -= cache.get(oldest).size;
      cache.delete(oldest);
    }
    const result = new Set();
    for (const patient of patients)
      for (const appointment of patient.appointments || []) {
        const pair = JSON.stringify([patient.id, appointment.id]),
          requestId = origins.get(pair);
        // The cabinet commit, including recovery after a platform rollback, is proof.
        if (requestId && storage.get('booking-accepted:' + requestId) === true) result.add(pair);
      }
    return result;
  }
  appointmentSources.readRequests = (org) =>
    db.canPrefetchReads && presence.readRequest ? [presence.readRequest('get', [org])] : [];
  appointmentSources.prepareAsync = async (org, patients, storage) => {
    if (!patients.some((patient) => patient.appointments?.length)) return;
    if (!db.prefetchAll || !presence.readRequest || !rows.readRequest)
      throw Error('Prepared provenance read is unavailable');
    await db.prefetchAll([presence.readRequest('get', [org])]);
    if (!presence.get(org)) return;
    await db.prefetchAll([rows.readRequest('all', [org])]);
    const previous = cache.get(org) || new Map(),
      changed = [];
    for (const row of rows.all(org))
      if (previous.get(row.id)?.stamp !== Buffer.from(row.stamp).toString('hex'))
        changed.push(row.id);
    // The exact existing fixed SQL/chunks are reused, including nonempty history.
    for (let offset = 0; offset < changed.length; offset += 6400)
      await db.prefetchAll(values.readRequests(org, changed.slice(offset, offset + 6400)));
    const pairs = new Set(
      patients.flatMap((patient) =>
        patient.appointments.map((a) => JSON.stringify([patient.id, a.id])),
      ),
    );
    const keys = [];
    for (const [id, entry] of previous)
      if (pairs.has(entry.pair)) keys.push('booking-accepted:' + id);
    for (const row of values(org, changed)) {
      const value = open(row.value);
      if (
        value.acceptance?.patientId &&
        value.appointmentId &&
        pairs.has(JSON.stringify([value.acceptance.patientId, value.appointmentId]))
      )
        keys.push('booking-accepted:' + row.id);
    }
    await storage.prefetchMeta([...new Set(keys)]);
  };
  return { appointmentSources };
}
module.exports = { createBookingRequestOrigins };
