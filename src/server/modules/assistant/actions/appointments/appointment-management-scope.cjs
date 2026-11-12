const { readSteps } = require('../../read-steps.cjs');
const { fail } = require('../../../../../shared/errors.cjs');
const { isActiveAppointment } = require('../../../../../shared/appointment-status.cjs');
const { startsAt } = require('../../../notifications/appointments.cjs');
const { validDate, minutes } = require('../../../../../shared/work-schedule.cjs');
function managementContext(c) {
  return readSteps(function* () {
    c.assertCurrent();
    if (
      !c.current.organizationId ||
      c.current.globalAdmin ||
      !['owner', 'salon_admin', 'cosmetologist'].includes(c.current.role)
    )
      throw fail(403, 'Нет доступа к записям этой организации.');
    const snapshot = c.assistantReads ? yield c.assistantReads.appointmentContext() : null;
    const all = snapshot ? snapshot.members : c.platform.workspaceMembers(c.current.organizationId);
    return {
      ownerId: all.find((row) => row.role === 'owner')?.accountId || '',
      timeZone: c.assistantReads
        ? yield c.assistantReads.timeZone()
        : c.platform.organizationTimeZone(c.current.organizationId),
      members: all.filter(
        (row) =>
          row.status === 'active' &&
          ['owner', 'cosmetologist'].includes(row.role) &&
          (c.current.role !== 'cosmetologist' || row.accountId === c.current.accountId),
      ),
    };
  }).call(this);
}
function eligibleManagementAppointment(c, row, now, ownerId = '', summary = false, timeZone) {
  const duration = Number(row.duration || 60),
    staffId = row.staffId || ownerId;
  return (
    typeof row.id === 'string' &&
    Boolean(row.id) &&
    isActiveAppointment(row) &&
    validDate(row.date) &&
    Number.isFinite(minutes(row.time)) &&
    Number.isSafeInteger(duration) &&
    duration >= 5 &&
    duration <= 1440 &&
    duration % 5 === 0 &&
    (c.current.role !== 'cosmetologist' ||
      (summary && !row.staffId) ||
      staffId === c.current.accountId) &&
    startsAt(row, timeZone || c.platform.organizationTimeZone(c.current.organizationId)) >= now
  );
}
function managementClientContext(c) {
  return readSteps(function* () {
    const context = yield managementContext(c);
    const current = c.current,
      organizationId = current.organizationId;
    const identity = JSON.stringify([
      organizationId,
      current.accountId,
      current.role,
      current.sessionId,
    ]);
    const check = () => {
      c.assertCurrent();
      if (
        JSON.stringify([
          c.current.organizationId,
          c.current.accountId,
          c.current.role,
          c.current.sessionId,
        ]) !== identity
      )
        throw fail(409, 'Доступ к поиску записей изменился.');
    };
    const storage = c.tenantStore(organizationId),
      now = Date.now();
    const predicate = (patient) =>
      (patient.appointments || []).some((appointment) =>
        eligibleManagementAppointment(c, appointment, now, '', true, context.timeZone),
      );
    const scoped = {
      ...storage,
      filename: storage.filename + ':assistant-future-management',
      // A new encoder identity gives this read its own fresh directory snapshot.
      // It must neither poison the normal directory cache nor retain expired slots.
      encode: (...args) => storage.encode(...args),
      indexes: {
        ...storage.indexes,
        summaryRows(actor, ids) {
          check();
          const rows = storage.indexes.summaryRows(actor, ids).filter((row) => {
            const patient = storage.decode(row.value);
            return patient?.id === row.patient_id && predicate(patient);
          });
          check();
          return rows;
        },
      },
    };
    return {
      ...c,
      ...(c.assistantReads
        ? {
            assistantReads: {
              ...c.assistantReads,
              directory(query, limit, options = {}) {
                return readSteps(function* () {
                  check();
                  const result = yield c.assistantReads.directory(query, limit, {
                    ...options,
                    predicate,
                  });
                  check();
                  return result;
                }).call(this);
              },
              summaries(ids, options = {}) {
                return readSteps(function* () {
                  check();
                  const result = yield c.assistantReads.summaries(ids, { ...options, predicate });
                  check();
                  return result;
                }).call(this);
              },
            },
          }
        : {}),
      tenantStore(org) {
        check();
        if (org !== organizationId) throw fail(403, 'Организация изменилась.');
        return scoped;
      },
    };
  }).call(this);
}
module.exports = { managementContext, eligibleManagementAppointment, managementClientContext };
