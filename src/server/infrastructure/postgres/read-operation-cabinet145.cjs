const { createCabinetIndexes } = require('../cabinet-indexes.cjs');
const { createPatientRecords } = require('../cabinet-records.cjs');
const { createCalendarProjection } = require('../calendar-projection.cjs');
const { createReadCacheBudget } = require('../read-cache-budget.cjs');
const { randomUUID } = require('node:crypto');

// A private adapter for one already-authorized physical PG READONLY snapshot.
// It opens no files/stores and cannot write. Preparation is explicit: projection
// reads missing from the operation are rejected by db, never replayed or guessed.
async function createOperationCabinet({
  db,
  encode,
  decode,
  hash,
  directory,
  schemaVersion = db.catalog.version,
  readCacheBudget = createReadCacheBudget({ maxBytes: 0 }),
  epoch = randomUUID(),
}) {
  if (
    db.dialect !== 'postgres' ||
    !db.isTransaction ||
    db.transactionIntent !== 'READONLY' ||
    ![1, 2].includes(schemaVersion)
  )
    throw Error('Owning prepared PostgreSQL snapshot required');
  const statements = new Map();
  const prepare = (sql) => {
    if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
    return statements.get(sql);
  };
  const token = (sql, method, args) => prepare(sql).readRequest(method, args);
  const fetch = (tokens) => db.prefetchAll(tokens);
  const metaSql = 'SELECT value FROM meta WHERE key=?';
  async function prefetchMeta(keys) {
    await fetch(keys.map((key) => token(metaSql, 'get', [key])));
  }
  await prefetchMeta(['revision', 'initialized']);
  if (schemaVersion === 2)
    await fetch([
      token(
        'SELECT kind,id,patient_id,position,value FROM cabinet_patient_records LIMIT 0',
        'all',
        [],
      ),
    ]);
  const records = createPatientRecords({ db, prepare, encode, decode, hash, schemaVersion });
  const indexes = createCabinetIndexes({
    db,
    prepare,
    directory,
    encode,
    decode,
    hash,
    schemaVersion,
  });
  const calendarProjection = createCalendarProjection({
    indexes,
    budget: readCacheBudget,
    owner: encode,
  });
  const snapshots = new Map(),
    calendars = new Map();
  function get(name, fallback = null) {
    const row = prepare(metaSql).get(name);
    return row ? decode(row.value) : fallback;
  }
  function selection(table, ids) {
    if (ids.length <= 1)
      return ids.map((id) => ({
        sql: 'SELECT id,value FROM ' + table + ' WHERE id=?',
        method: 'get',
        args: [id],
      }));
    const sql =
      'SELECT selected.id,selected.value FROM json_each(?) AS requested CROSS JOIN ' +
      table +
      ' AS selected WHERE selected.id=requested.value ORDER BY CAST(requested.key AS INTEGER)';
    const plan = [];
    for (let offset = 0; offset < ids.length; offset += 200)
      plan.push({ sql, method: 'all', args: [JSON.stringify(ids.slice(offset, offset + 200))] });
    return plan;
  }
  const readPlan = (plan) =>
    plan.flatMap(({ sql, method, args }) => {
      const result = prepare(sql)[method](...args);
      return method === 'get' ? (result ? [result] : []) : result;
    });
  const fetchPlan = (plan) => fetch(plan.map(({ sql, method, args }) => token(sql, method, args)));
  function recordPlan(patientIds) {
    const ids = [...new Set(patientIds)],
      plan = [];
    const sql =
      'SELECT kind,id,patient_id,position,value FROM cabinet_patient_records WHERE patient_id IN (SELECT value FROM json_each(?)) ORDER BY patient_id,kind,position';
    for (let offset = 0; offset < ids.length; offset += 200)
      plan.push({ sql, method: 'all', args: [JSON.stringify(ids.slice(offset, offset + 200))] });
    return plan;
  }
  async function readSelectedAsync(patientIds = [], serviceIds = []) {
    const key = JSON.stringify([patientIds, serviceIds]);
    if (snapshots.has(key)) return snapshots.get(key);
    const patients = selection('patients', patientIds),
      services = selection('services', serviceIds);
    const canonical = records ? recordPlan(patientIds) : [];
    await fetchPlan([...patients, ...services, ...canonical]);
    const selected = readPlan(patients);
    const result = {
      patients: records
        ? records.hydrateRows(selected, readPlan(canonical))
        : selected.map((row) => decode(row.value)),
      services: readPlan(services).map((row) => decode(row.value)),
      revision: get('revision', 0),
      initialized: get('initialized', false),
    };
    snapshots.set(key, result);
    return result;
  }
  function readSelected(patientIds = [], serviceIds = []) {
    const result = snapshots.get(JSON.stringify([patientIds, serviceIds]));
    if (!result) throw Error('Selected cabinet read was not prepared');
    return result;
  }
  const selectedAppointments = new Map();
  async function readSelectedAppointmentsAsync(patientIds = []) {
    const key = JSON.stringify(patientIds);
    if (selectedAppointments.has(key)) return selectedAppointments.get(key);
    let result;
    if (!records)
      result = (await readSelectedAsync(patientIds)).patients.map(({ id, appointments }) => ({
        id,
        appointments,
      }));
    else {
      const ids = [...new Set(patientIds)],
        sql =
          'SELECT p.id patient_id,r.kind,r.id,r.position,r.value FROM patients p ' +
          "LEFT JOIN cabinet_patient_records r ON r.patient_id=p.id AND r.kind='appointment' " +
          'WHERE p.id IN (SELECT value FROM json_each(?)) ORDER BY p.id,r.position';
      const tokens = [];
      for (let offset = 0; offset < ids.length; offset += 200)
        tokens.push(token(sql, 'all', [JSON.stringify(ids.slice(offset, offset + 200))]));
      await fetch(tokens);
      result = records.selectedAppointments(patientIds);
    }
    selectedAppointments.set(key, result);
    return result;
  }
  function readSelectedAppointments(patientIds = []) {
    if (!patientIds.length) return [];
    const result = selectedAppointments.get(JSON.stringify(patientIds));
    if (result) return result;
    return readSelected(patientIds).patients.map(({ id, appointments }) => ({ id, appointments }));
  }
  async function calendarSnapshotAsync(from, to, options) {
    const key = JSON.stringify([from, to, options]);
    if (calendars.has(key)) return calendars.get(key);
    const revision = get('revision', 0);
    const appointments =
      options?.projection === 'overview'
        ? []
        : await indexes.appointmentsAsync(from, to, {
            ...options,
            ...(options?.projection === 'occupancy' ? { includeNames: false } : {}),
            ...(options?.projection === 'subscription' ? { includeNames: 'subscription' } : {}),
          });
    if (options?.overview)
      await indexes.appointmentsAsync(options.overview.from, options.overview.to, {
        includeNames: false,
        staffId: options.staffId || '',
      });
    const result = {
      revision,
      appointments,
      ...(options?.overview
        ? {
            overview: calendarProjection(
              revision,
              options.overview.from,
              options.overview.to,
              options.staffId,
            ),
          }
        : {}),
    };
    calendars.set(key, result);
    return result;
  }
  function calendarSnapshot(from, to, options) {
    const result = calendars.get(JSON.stringify([from, to, options]));
    if (!result) throw Error('Calendar operation was not prepared');
    return result;
  }
  const readOnlySnapshot = (callback) => {
    if (!db.isTransaction || db.transactionIntent !== 'READONLY')
      throw Error('Owning snapshot ended');
    db.snapshotVersion();
    return callback();
  };
  return {
    db,
    filename: directory,
    directory,
    encode,
    decode,
    get,
    prefetchMeta,
    indexes,
    readCacheBudget,
    readSelected,
    readSelectedAsync,
    readSelectedAppointments,
    readSelectedAppointmentsAsync,
    calendarSnapshot,
    calendarSnapshotAsync,
    readVersion: () => [epoch, db.snapshotVersion(), 0],
    readOnlySnapshot,
    transaction: (callback, mode = 'DEFERRED') => {
      if (!['DEFERRED', 'READONLY'].includes(mode)) throw Error('Operation adapter is read-only');
      return readOnlySnapshot(callback);
    },
    close: () => {
      readCacheBudget.releaseOwner(encode);
      statements.clear();
      snapshots.clear();
      calendars.clear();
      selectedAppointments.clear();
    },
  };
}
module.exports = { createOperationCabinet };
