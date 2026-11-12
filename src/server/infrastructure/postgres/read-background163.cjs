const { calendarPeriod } = require('../../modules/cabinet/queries.cjs');
const fail = require('../../../shared/errors.cjs').fail;
async function readBackground163(context, operation, prepared) {
  const { current, url } = context,
    org = current.organizationId;
  const p = operation.platform,
    catalog = operation.platformCatalog,
    platform = prepared.platform;
  const sources = [];
  const add = (table, where, values = []) => {
    if (!catalog.tables[table]) throw fail(503, 'Подготовленная схема чтения недоступна.');
    sources.push({ scope: p, catalog, table, where, values });
  };
  add('organizations', 's.id=$2', [org]);
  let period, staff;
  if (url.pathname === '/api/work-schedules') {
    period = calendarPeriod(url);
    staff = url.searchParams.get('staffId') || current.accountId;
    if (current.role === 'cosmetologist' && staff !== current.accountId)
      throw fail(403, 'Недостаточно прав для этого графика.');
    const own = current.role === 'cosmetologist';
    add(
      'memberships',
      's.organization_id=$2' + (own ? ' AND s.account_id=$3' : ''),
      own ? [org, current.accountId] : [org],
    );
    add(
      'accounts',
      's.id IN(SELECT account_id FROM cartoteca_platform.memberships WHERE _store_id=$1 AND organization_id=$2' +
        (own ? ' AND account_id=$3' : '') +
        ')',
      own ? [org, current.accountId] : [org],
    );
    add('work_schedule_profiles', 's.organization_id=$2 AND s.staff_id=ANY($3::text[])', [
      org,
      [staff, 'organization'],
    ]);
    add(
      'work_schedule_days',
      's.organization_id=$2 AND s.date BETWEEN $3 AND $4' +
        (own ? ' AND s.staff_id=ANY($5::text[])' : ''),
      [org, period.from, period.to, ...(own ? [[staff, 'organization']] : [])],
    );
  }
  // Existing probe-to-heavy admission happens before fetching/decrypting any
  // organization profile, staff profile or schedule rows.
  await operation.probe(sources);
  const requests = [...platform.organization.readRequests(org)];
  if (period) {
    requests.push(
      ...platform.workspaceMembers.readRequests(
        org,
        current.role === 'cosmetologist' ? current.accountId : undefined,
      ),
    );
    if (staff !== 'organization')
      requests.push(...platform.workspaceIdentities.readRequests(org, staff));
    requests.push(
      ...platform.workSchedules.viewForActor.readRequests(current, staff, period.from, period.to),
    );
  }
  await prepared.db.prefetchAll(requests);
  const value = period
    ? platform.workSchedules.viewForActor(current, staff, period.from, period.to)
    : { timeZone: platform.organizationTimeZone(org) };
  operation.assertActive();
  return context.json(context.res, 200, value);
}
module.exports = { readBackground163 };
