const { fail } = require('../../shared/errors.cjs');
const interactiveReads = new Set([
  '/api/cabinet/bootstrap',
  '/api/cabinet/calendar',
  '/api/cabinet/directory',
  '/api/cabinet/patient',
  '/api/cabinet/operation',
  '/api/cabinet/time-zone',
  '/api/work-schedules',
  '/api/work-schedules/calendar-settings',
  '/api/workspace/availability',
]);
const interactiveWrites = new Set([
  'PATCH /api/cabinet/changes',
  'POST /api/cabinet/appointments',
  'POST /api/appointments/confirmation',
  'POST /api/calendar/personal-event',
  'DELETE /api/calendar/personal-event',
]);

function requestPriority(route, bytes = 0) {
  // Priority is server policy, never a header or client-supplied organization.
  // Large JSON/photo/import work keeps its existing memory/CPU admissions.
  if (route.access !== 'organization' || bytes > 256 * 1024) return 'normal';
  return (route.method === 'GET' && interactiveReads.has(route.path)) ||
    interactiveWrites.has(route.method + ' ' + route.path)
    ? 'interactive'
    : 'normal';
}
function requestScope(current) {
  if (current?.organizationId) return 'org:' + current.organizationId;
  return current?.accountId ? 'account:' + current.accountId : null;
}
function createRequestWork({ dispatcher, route, current, authorize, cancelled }) {
  const scopeKey = requestScope(current);
  return (callback, bytes = 0) =>
    dispatcher.run(
      () => {
        // Admission can await. Cookie/context/role revocation is checked again
        // before any parse, read or mutation, outside all borrowed transactions.
        authorize();
        return callback();
      },
      { priority: requestPriority(route, bytes), scopeKey, cancelled },
    );
}
function createPhotoWork({ dispatcher, requireCurrent, assertRequestContext, cancelled }) {
  const current = requireCurrent();
  const authorize = () => {
    const fresh = requireCurrent();
    // Native images cannot send custom headers; their URL pins both contexts.
    assertRequestContext(fresh);
    assertRequestContext(fresh, true, true);
    if (
      fresh.accountId !== current.accountId ||
      fresh.organizationId !== current.organizationId ||
      fresh.role !== current.role ||
      fresh.globalAdmin !== current.globalAdmin
    )
      throw fail(403, 'Доступ изменился. Повторите операцию.');
  };
  authorize();
  return createRequestWork({
    dispatcher,
    route: { method: 'GET', path: '/api/photos/', access: 'organization' },
    current,
    authorize,
    cancelled,
  });
}
module.exports = { requestPriority, requestScope, createRequestWork, createPhotoWork };
