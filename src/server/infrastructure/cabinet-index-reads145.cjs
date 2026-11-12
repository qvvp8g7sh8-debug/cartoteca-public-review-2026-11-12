const { fail } = require('../../shared/errors.cjs');
const { patientNameParts } = require('../../shared/patient-names.cjs');

// The synchronous and operation-owned async readers share SQL and projection.
// Async preparation fetches explicit groups once; a projection never replays.
function visibleAppointmentRows(rows, decode, staffId) {
  return rows
    .map((row) => ({ patientId: row.patient_id, appointment: decode(row.value) }))
    .filter(
      ({ appointment }) =>
        (!staffId || appointment.staffId === staffId) &&
        !['cancelled', 'no_show'].includes(appointment.status),
    );
}
function projectAppointments(visible, includeNames, rows, decode) {
  if (!includeNames)
    return visible.map(({ appointment }) =>
      Object.fromEntries(
        ['id', 'date', 'time', 'duration', 'staffId', 'roomId', 'status']
          .filter((key) => appointment[key] !== undefined)
          .map((key) => [key, appointment[key]]),
      ),
    );
  const subscription = includeNames === 'subscription',
    contacts = new Map();
  for (const row of rows) {
    const contact = decode(row.value);
    contacts.set(row.patient_id, {
      name: patientNameParts(contact).lastFirst,
      ...(!subscription ? { phone: contact.phone || '' } : {}),
    });
  }
  return visible.map(({ patientId, appointment }) => {
    const contact = contacts.get(patientId);
    if (subscription)
      return {
        ...Object.fromEntries(
          ['id', 'date', 'time', 'duration', 'staffId', 'status']
            .filter((key) => appointment[key] !== undefined)
            .map((key) => [key, appointment[key]]),
        ),
        patientName: contact?.name || '',
      };
    return {
      ...appointment,
      patientName: contact ? contact.name : appointment.patientName || '',
      patientPhone: contact?.phone || '',
    };
  });
}
function createCabinetIndexReads({ prepare, decode, hash, db }) {
  const audience = (staff) => hash('staff:' + staff);
  const request = (statement, method, args) => statement.readRequest?.(method, args);
  const fetch = (requests) => db.prefetchAll?.(requests.filter(Boolean));
  function summariesPlan(current, ids) {
    const target = current.role === 'cosmetologist' ? audience(current.accountId) : '*';
    if (!ids)
      return [
        {
          statement: prepare(
            'SELECT patient_id,value FROM cabinet_summaries WHERE audience=? ORDER BY patient_id',
          ),
          method: 'all',
          args: [target],
        },
      ];
    const statement = prepare(
      'SELECT patient_id,value FROM cabinet_summaries WHERE audience=? AND patient_id=?',
    );
    return ids.map((id) => ({ statement, method: 'get', args: [target, id] }));
  }
  const planRows = (plan) =>
    plan.flatMap(({ statement, method, args }) => {
      const value = statement[method](...args);
      return method === 'get' ? (value ? [value] : []) : value;
    });
  const planRequests = (plan) =>
    plan.map(({ statement, method, args }) => request(statement, method, args));
  function summaryRows(current, ids) {
    return planRows(summariesPlan(current, ids));
  }
  async function summaryRowsAsync(current, ids) {
    const plan = summariesPlan(current, ids);
    await fetch(planRequests(plan));
    return planRows(plan);
  }
  function summaries(current, ids) {
    return summaryRows(current, ids).map((row) => decode(row.value));
  }
  function selectAppointments(from, to, staffId) {
    const keys = [];
    for (
      let date = Date.parse(from + 'T00:00:00Z'), end = Date.parse(to + 'T00:00:00Z');
      date <= end;
      date += 86400000
    )
      keys.push(hash('day:' + new Date(date).toISOString().slice(0, 10)));
    if (!keys.length || keys.length > 45) throw fail(400, 'Выберите период до 45 дней.');
    const join = staffId
      ? ' JOIN cabinet_summaries s ON s.patient_id=a.patient_id AND s.audience=?'
      : '';
    return {
      statement: prepare(
        'SELECT DISTINCT a.id,a.patient_id,a.value FROM cabinet_days d JOIN cabinet_appointments a ON a.id=d.appointment_id' +
          join +
          ' WHERE d.day_hash IN (' +
          keys.map(() => '?').join(',') +
          ')',
      ),
      method: 'all',
      args: staffId ? [audience(staffId), ...keys] : keys,
    };
  }
  const visibleAppointments = (plan, staffId) =>
    visibleAppointmentRows(planRows([plan]), decode, staffId);
  function contactsPlan(visible) {
    const ids = [...new Set(visible.map((row) => row.patientId))],
      plan = [];
    const statement = prepare(
      "SELECT patient_id,value FROM cabinet_summaries WHERE audience='*' AND patient_id IN (SELECT value FROM json_each(?))",
    );
    for (let offset = 0; offset < ids.length; offset += 200)
      plan.push({
        statement,
        method: 'all',
        args: [JSON.stringify(ids.slice(offset, offset + 200))],
      });
    return plan;
  }
  const project = (visible, includeNames, plan) =>
    projectAppointments(visible, includeNames, planRows(plan), decode);
  function appointments(from, to, { includeNames = true, staffId = '' } = {}) {
    const visible = visibleAppointments(selectAppointments(from, to, staffId), staffId);
    return project(visible, includeNames, includeNames ? contactsPlan(visible) : []);
  }
  // Private policy input: preserve legacy patientId for changed-patient exclusion.
  // Contact summaries never contribute to workspace scheduling rules.
  function appointmentOccupancy(from, to) {
    return visibleAppointments(selectAppointments(from, to, ''), '').map(({ appointment }) =>
      Object.fromEntries(
        ['id', 'patientId', 'date', 'time', 'duration', 'staffId', 'roomId', 'status']
          .filter((key) => appointment[key] !== undefined)
          .map((key) => [key, appointment[key]]),
      ),
    );
  }
  async function appointmentsAsync(from, to, { includeNames = true, staffId = '' } = {}) {
    const selection = selectAppointments(from, to, staffId);
    await fetch(planRequests([selection]));
    const visible = visibleAppointments(selection, staffId),
      contacts = includeNames ? contactsPlan(visible) : [];
    await fetch(planRequests(contacts));
    return project(visible, includeNames, contacts);
  }
  return {
    summaryRows,
    summaryRowsAsync,
    summaries,
    appointments,
    appointmentOccupancy,
    appointmentsAsync,
  };
}
module.exports = { createCabinetIndexReads, visibleAppointmentRows, projectAppointments };
