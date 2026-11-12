const paths = Object.freeze([
  '/api/cabinet/calendar',
  '/api/cabinet/time-zone',
  '/api/work-schedules',
  '/api/cabinet/patient',
  '/api/cabinet/patient/history',
  '/api/cabinet/patient/upcoming',
  '/api/cabinet/directory',
]);
function isPostgresReadOperation(request) {
  if (request?.method !== 'GET' || typeof request.url !== 'string') return false;
  try {
    const url = new URL(request.url, 'http://native.invalid');
    return (
      paths.includes(url.pathname) ||
      (url.pathname === '/api/cabinet/operation' && url.searchParams.get('statusOnly') === '1')
    );
  } catch {
    return false;
  }
}
module.exports = { isPostgresReadOperation, postgresReadOperationPaths: paths };
