const { createHmac, randomBytes } = require('node:crypto');
const { startsAt } = require('../notifications/appointments.cjs');
const { fail } = require('../../../shared/errors.cjs');
const secret = randomBytes(32);

function calendarReadPlan(requestUrl, period) {
  const { from, to } = period(requestUrl);
  const compact = requestUrl.searchParams.get('compact') === '1';
  const projection = compact ? requestUrl.searchParams.get('projection') || 'details' : 'details';
  if (!['details', 'occupancy', 'overview'].includes(projection))
    throw fail(400, 'Неизвестный вид календаря.');
  let overview;
  if (compact) {
    const url = new URL(requestUrl);
    url.searchParams.set('from', requestUrl.searchParams.get('monthFrom'));
    url.searchParams.set('to', requestUrl.searchParams.get('monthTo'));
    overview = period(url);
  }
  return { from, to, compact, projection, overview };
}
function calendarRead(c, period) {
  const requestTime = Date.now();
  const { from, to, compact, projection, overview } = calendarReadPlan(c.url, period);
  const storage = c.tenantStore(c.current.organizationId);
  let zone, platformVersion, storageVersion, runtimeStatus, plan;
  if (compact && !c.calendarVersion163) {
    const revision = storage.get('revision', 0);
    zone = c.platform.organizationTimeZone(c.current.organizationId);
    // Capture before either the conditional comparison or the snapshot. A miss
    // reuses these observations; a concurrent change forces the next read to miss.
    platformVersion = c.platform.readVersion?.();
    storageVersion = storage.readVersion?.();
    runtimeStatus = c.telegram.status?.();
    plan = c.platform.subscription(c.current.organizationId);
    // Auth/organization access has already run for this request. Tokens confer no access.
    const versionFor = (rev, until) =>
      createHmac('sha256', secret)
        .update(
          JSON.stringify([
            c.current.organizationId,
            c.current.accountId,
            c.current.sessionId,
            c.current.role,
            from,
            to,
            overview,
            projection,
            rev,
            storageVersion,
            platformVersion,
            runtimeStatus,
            plan,
            until,
          ]),
        )
        .digest('base64url');
    const until = Number(c.url.searchParams.get('until'));
    if (
      compact &&
      c.platform.readVersion &&
      Number.isSafeInteger(until) &&
      until > Date.now() &&
      until <= Date.now() + 3600000 &&
      c.url.searchParams.get('version') === versionFor(revision, until)
    )
      return c.json(c.res, 200, { revision, unchanged: true });
  }
  const snapshot = storage.calendarSnapshot(from, to, {
    staffId: c.current.role === 'cosmetologist' ? c.current.accountId : '',
    ...(compact ? { overview, projection } : {}),
  });
  let appointments = snapshot.appointments;
  if (projection === 'details') {
    const patients = new Map();
    for (const a of appointments) {
      if (c.current.role === 'cosmetologist' && a.staffId !== c.current.accountId) continue;
      if (!patients.has(a.patientId))
        patients.set(a.patientId, { id: a.patientId, appointments: [] });
      patients.get(a.patientId).appointments.push(a);
    }
    appointments = c.appointmentState
      .decorate({ patients: [...patients.values()] }, c.current.organizationId, {
        readSnapshot: c.projectionSnapshotProof?.(),
      })
      .patients.flatMap((p) => p.appointments);
  }
  const personal = c.platform.personalEvents?.view(c.current, from, to, { projection }) || {
    personalEvents: [],
    personalRevision: 0,
  };
  if (!compact)
    return c.json(c.res, 200, { revision: snapshot.revision, appointments, ...personal });
  // Channel readiness changes at appointment start even without a database write.
  // Keep a boundary crossed during this synchronous read expired, not valid for
  // another hour with channel decoration calculated before the boundary.
  if (compact && c.calendarVersion163)
    zone = c.platform.organizationTimeZone(c.current.organizationId);
  const validUntil = appointments.reduce((limit, a) => {
    const start = startsAt(a, zone);
    return start > requestTime ? Math.min(limit, start) : limit;
  }, requestTime + 3600000);
  const version = c.calendarVersion163
    ? c.calendarVersion163.sign(snapshot.revision, validUntil)
    : createHmac('sha256', secret)
        .update(
          JSON.stringify([
            c.current.organizationId,
            c.current.accountId,
            c.current.sessionId,
            c.current.role,
            from,
            to,
            overview,
            projection,
            snapshot.revision,
            storageVersion,
            platformVersion,
            runtimeStatus,
            plan,
            validUntil,
          ]),
        )
        .digest('base64url');
  return c.json(c.res, 200, {
    ...snapshot,
    appointments,
    ...personal,
    personalOverview:
      c.platform.personalEvents?.overview(c.current, overview.from, overview.to) || [],
    version,
    validUntil,
  });
}
module.exports = { calendarRead, calendarReadPlan };
