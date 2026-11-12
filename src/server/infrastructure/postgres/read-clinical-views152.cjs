const { fail } = require('../../../shared/errors.cjs');
const { calendarReadPlan } = require('../../modules/cabinet/calendar-read.cjs');
const { calendarPeriod } = require('../../modules/cabinet/queries.cjs');
const { createCalendarProjection } = require('../calendar-projection.cjs');
const { visibleAppointmentRows, projectAppointments } = require('../cabinet-index-reads145.cjs');
const { historyLookup } = require('./read-history-bundle152.cjs');
const { unpack } = require('./cabinet-read-bundle136.cjs');
const { createPatientRecords } = require('../cabinet-records.cjs');
const { cabinetForUser } = require('../../modules/access/cabinet-policy.cjs');
function days(from, to, hash) {
  const result = [];
  for (
    let day = Date.parse(from + 'T00:00:00Z');
    day <= Date.parse(to + 'T00:00:00Z');
    day += 86400000
  )
    result.push(hash('day:' + new Date(day).toISOString().slice(0, 10)));
  if (!result.length || result.length > 45) throw fail(400, 'Выберите период до 45 дней.');
  return result;
}
function clinicalKey(operation, current, url) {
  // Patient page cursors belong to their current account and session. Calendar
  // base data contains no conditional HMAC or user-dependent notification state.
  const patient = url.pathname.startsWith('/api/cabinet/patient');
  const query = new URLSearchParams(url.searchParams);
  query.delete('version');
  query.delete('until');
  query.sort();
  if (url.pathname === '/api/cabinet/directory')
    for (const key of [...query.keys()]) query.delete(key);
  return JSON.stringify([
    operation.epoch,
    operation.scope.storeId,
    current.role,
    current.role === 'cosmetologist' || patient ? current.accountId : '*',
    patient ? current.sessionId : null,
    url.pathname,
    query.toString(),
  ]);
}
function meta(rows, decode, name, fallback) {
  const row = rows.find((row) => row.bucket === 'meta' && row.id === name);
  return row ? decode(row.value) : fallback;
}
async function nativeDirectory(operation, prepared, current) {
  const audience =
    current.role === 'cosmetologist' ? prepared.hash('staff:' + current.accountId) : '*';
  const rows = await operation.selectView('directory', { audience });
  return {
    revision: meta(rows, prepared.decode, 'revision', 0),
    initialized: meta(rows, prepared.decode, 'initialized', false),
    directory: rows
      .filter((row) => row.bucket === 'summary')
      .map((row) => prepared.decode(row.value)),
  };
}
async function nativeCalendar(operation, prepared, current, url) {
  const plan = calendarReadPlan(url, calendarPeriod);
  const ranges = [{ bucket: 'main', days: days(plan.from, plan.to, prepared.hash) }];
  if (plan.overview)
    ranges.push({
      bucket: 'overview',
      days: days(plan.overview.from, plan.overview.to, prepared.hash),
    });
  const staff = current.role === 'cosmetologist' ? current.accountId : '';
  const rows = await operation.selectView('calendar', {
    ranges,
    audience: staff ? prepared.hash('staff:' + staff) : null,
  });
  const contacts = rows.filter((row) => row.bucket === 'contact'),
    revision = meta(rows, prepared.decode, 'revision', 0);
  const appointments = (bucket, includeNames) =>
    projectAppointments(
      visibleAppointmentRows(
        rows.filter((row) => row.bucket === bucket),
        prepared.decode,
        staff,
      ),
      includeNames,
      contacts,
      prepared.decode,
    );
  const snapshot = {
    revision,
    appointments:
      plan.projection === 'overview' ? [] : appointments('main', plan.projection === 'details'),
  };
  if (plan.overview) {
    const calendarProjection = createCalendarProjection({
      indexes: { appointments: () => appointments('overview', false) },
      budget: prepared.readCacheBudget,
      owner: prepared.encode,
    });
    snapshot.overview = calendarProjection(revision, plan.overview.from, plan.overview.to, staff);
  }
  const patients = new Map();
  if (plan.projection === 'details')
    for (const appointment of snapshot.appointments) {
      if (!patients.has(appointment.patientId))
        patients.set(appointment.patientId, { id: appointment.patientId, appointments: [] });
      patients.get(appointment.patientId).appointments.push(appointment);
    }
  return { plan, snapshot, patients: [...patients.values()] };
}
async function nativePatientPage(operation, prepared, current, url, reader) {
  const params = reader.parameters(current, url);
  const audience =
    current.role === 'cosmetologist' ? prepared.hash('staff:' + current.accountId) : '*';
  const rows = await operation.selectView('history', { ...params, audience });
  return reader.readPrepared(current, url, historyLookup(rows));
}
async function nativeFullPatient(operation, prepared, current, url) {
  const id = url.searchParams.get('id');
  if (typeof id !== 'string' || !id || id.length > 120) throw fail(400, 'Укажите карточку.');
  const selection = { operation: 'cabinet-selected-v1', patientIds: [id], serviceIds: [] };
  const rows = unpack(
    { rows: await operation.selectView('selected', selection) },
    selection,
    operation.cabinetCatalog.version,
  );
  const records = createPatientRecords({
    db: prepared.cabinetDb,
    encode: prepared.encode,
    decode: prepared.decode,
    hash: prepared.hash,
    schemaVersion: operation.cabinetCatalog.version,
  });
  const result = cabinetForUser(current, {
    revision: meta(
      rows.meta.map((row) => ({ ...row, id: row.key, bucket: 'meta' })),
      prepared.decode,
      'revision',
      0,
    ),
    initialized: meta(
      rows.meta.map((row) => ({ ...row, id: row.key, bucket: 'meta' })),
      prepared.decode,
      'initialized',
      false,
    ),
    services: [],
    patients: records
      ? records.hydrateRows(rows.patients, rows.records)
      : rows.patients.map((row) => prepared.decode(row.value)),
  });
  if (!result.patients.length) throw fail(404, 'Карточка не найдена.');
  return { ...result, kind: 'patient' };
}
function operationStorage(prepared, operation, revision, calendar = null) {
  const statement = prepared.cabinetDb.prepare('SELECT value FROM meta WHERE key=?');
  return {
    get: (name, fallback) => {
      operation.assertActive();
      if (name === 'revision') return revision;
      const row = statement.get(name);
      return row ? prepared.decode(row.value) : fallback;
    },
    prefetchMeta: (keys) =>
      prepared.cabinetDb.prefetchAll(keys.map((key) => statement.readRequest('get', [key]))),
    readVersion: () => [operation.epoch, operation.snapshot, 0],
    calendarSnapshot: () => calendar.snapshot,
  };
}
function directoryStorage(prepared, value, operation, budget, witness) {
  return {
    directory: prepared.directory,
    filename: prepared.directory,
    encode: prepared.encode,
    decode: prepared.decode,
    readCacheBudget: budget,
    readCacheIdentity: operation.epoch + ':' + operation.scope.storeId,
    readCacheVersion: witness || operation.snapshot,
    readVersion: () => [operation.epoch, operation.snapshot, 0],
    get: (name, fallback) =>
      name === 'revision' ? value.revision : name === 'initialized' ? value.initialized : fallback,
    readOnlySnapshot: (callback) => callback(),
    transaction: (callback) => callback(),
    indexes: { summaryRows: () => [] },
  };
}
module.exports = {
  clinicalKey,
  nativeDirectory,
  nativeCalendar,
  nativePatientPage,
  nativeFullPatient,
  directoryStorage,
  operationStorage,
};
