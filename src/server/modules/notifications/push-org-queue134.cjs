const { queueStatements } = require('../../infrastructure/postgres/queue-org-statements134.cjs');
const { createQueueCompatibilityMaintenance } = require('./queue-compatibility-maintenance.cjs');
const {
  exclusions,
  candidateAfter,
  organizationQueue,
  createOrganizationClaims,
} = require('./queue-org134.cjs');
function createPushOrganizationQueue(c, devices) {
  const { db, id, open } = c,
    domain = 'push',
    sql = queueStatements(domain);
  const cleanup = createQueueCompatibilityMaintenance(c, 'staff_push_jobs');
  const choose = createOrganizationClaims(c, domain),
    maintain = createOrganizationClaims(c, domain);
  function omitted(options = {}) {
    const devices = options.excludeDevices || [],
      organizations = options.excludeOrganizations || [];
    if (
      !Array.isArray(devices) ||
      !Array.isArray(organizations) ||
      devices.length > 4 ||
      organizations.length > 2 ||
      ![...devices, ...organizations].every((value) => typeof value === 'string' && value)
    )
      throw Error('Invalid managed Push exclusions.');
    return [
      ...devices,
      ...Array(4 - devices.length).fill(''),
      ...organizations,
      ...Array(2 - organizations.length).fill(''),
    ];
  }
  const hint = db.prepare(`SELECT id,organization_id,next_at FROM staff_push_jobs WHERE next_at<=?
    AND (status='pending' OR (status='sending' AND lease_until<=?)) AND ${candidateAfter}
    AND organization_id NOT IN (${exclusions}) AND device_id NOT IN (?,?,?,?) AND organization_id NOT IN (?,?)
    ORDER BY next_at,id LIMIT 1`);
  const ready = [false, true].map((probes) =>
    db.prepare(`SELECT j.* FROM staff_push_jobs j
    WHERE j.organization_id=? AND j.next_at<=? AND j.expires_at>? AND (j.status='pending' OR (j.status='sending' AND j.lease_until<=?))
    AND j.device_id NOT IN (?,?,?,?) AND j.organization_id NOT IN (?,?)
    ${probes ? "AND j.event_key NOT LIKE 'staff-push-event:%'" : ''}
    AND NOT EXISTS(SELECT 1 FROM staff_push_jobs live WHERE live.organization_id=j.organization_id
      AND live.device_id=j.device_id AND live.status='sending' AND live.lease_until>?)
    ORDER BY j.next_at,j.id LIMIT 1`),
  );
  function claim(now = Date.now(), options) {
    if (!devices.runtimeAvailable()) return null;
    const blocked = omitted(options);
    return choose(
      (visited, cursor) =>
        hint.get(now, now, cursor.nextAt, cursor.nextAt, cursor.id, ...visited, ...blocked),
      (org) => {
        if (!devices.runtimeAvailable()) return null;
        cleanup.sweep(now, org);
        const hasEvents = devices.hasEnabledEvents(org);
        const row = ready[hasEvents ? 0 : 1].get(org, now, now, now, ...blocked, now);
        if (!row) return null;
        const lease = id(),
          until = now + 60000;
        const changed = db
          .prepare(sql.claim.sql)
          .run(
            lease,
            until,
            org,
            row.id,
            row.status,
            row.attempts,
            row.lease_until,
            row.lease_id,
            org,
            row.device_id,
            now,
          ).changes;
        return changed
          ? {
              ...row,
              lease_id: lease,
              lease_until: until,
              attempts: row.attempts + 1,
              decoded: open(row.value),
            }
          : null;
      },
    );
  }
  const maintenanceHint =
    db.prepare(`SELECT id,organization_id,next_at FROM staff_push_jobs WHERE ${candidateAfter}
    AND organization_id NOT IN (${exclusions}) ORDER BY next_at,id LIMIT 1`);
  return {
    claim,
    claimManaged: claim,
    claimManagedWithHead(now = Date.now(), options) {
      const job = claim(now, options);
      return { head: job ? { next_at: job.next_at } : null, job };
    },
    maintainManaged: (now = Date.now()) =>
      maintain(
        (visited, cursor) =>
          maintenanceHint.get(cursor.nextAt, cursor.nextAt, cursor.id, ...visited),
        (org) => cleanup.sweep(now, org),
      ) || { examined: 0, changed: 0 },
    finish(job, status, nextAt = 0) {
      return organizationQueue(
        c,
        domain,
        job.organization_id,
        () =>
          db
            .prepare(sql.finish.sql)
            .run(status, nextAt, job.organization_id, job.id, job.lease_id, job.lease_until)
            .changes,
      );
    },
    deferUnstarted(job, nextAt = Date.now() + 1000) {
      return organizationQueue(
        c,
        domain,
        job.organization_id,
        () =>
          db
            .prepare(sql.defer.sql)
            .run(nextAt, job.organization_id, job.id, job.lease_id, job.lease_until, job.attempts)
            .changes,
      );
    },
    deliveryFor: (job, callback) => organizationQueue(c, domain, job.organization_id, callback),
  };
}
module.exports = { createPushOrganizationQueue };
