const { fail } = require('../../../shared/errors.cjs');
const { cabinetForUser } = require('../../modules/access/cabinet-policy.cjs');
const { calendarPeriod } = require('../../modules/cabinet/queries.cjs');
const { calendarReadPlan } = require('../../modules/cabinet/calendar-read.cjs');
const { parameters } = require('../../modules/cabinet/directory.cjs');

// Explicit preparation for three public reads. Existing handlers execute once
// against the prepared operation; no missing-SQL exception can replay them.
async function prepareCabinetRead({ storage, current, url, timeZone }) {
  if (url.pathname === '/api/cabinet/directory') {
    if (url.searchParams.get('picker') !== '1') parameters(url, timeZone);
    await storage.indexes.summaryRowsAsync(current);
    return { patients: [], kind: 'directory' };
  }
  if (url.pathname === '/api/cabinet/patient') {
    const id = url.searchParams.get('id');
    if (typeof id !== 'string' || !id || id.length > 120) throw fail(400, 'Укажите карточку.');
    const cabinet = cabinetForUser(current, await storage.readSelectedAsync([id]));
    if (!cabinet.patients.length) throw fail(404, 'Карточка не найдена.');
    return { ...cabinet, kind: 'patient' };
  }
  if (url.pathname !== '/api/cabinet/calendar') throw Error('Unsupported operation route');
  const plan = calendarReadPlan(url, calendarPeriod);
  const snapshot = await storage.calendarSnapshotAsync(plan.from, plan.to, {
    staffId: current.role === 'cosmetologist' ? current.accountId : '',
    ...(plan.compact ? { overview: plan.overview, projection: plan.projection } : {}),
  });
  const patients = new Map();
  if (plan.projection === 'details')
    for (const appointment of snapshot.appointments) {
      if (current.role === 'cosmetologist' && appointment.staffId !== current.accountId) continue;
      if (!patients.has(appointment.patientId))
        patients.set(appointment.patientId, { id: appointment.patientId, appointments: [] });
      patients.get(appointment.patientId).appointments.push(appointment);
    }
  return { ...plan, patients: [...patients.values()], kind: 'calendar' };
}
module.exports = { prepareCabinetRead };
