const { queueStatements } = require('../../infrastructure/postgres/queue-org-statements134.cjs');
const { createQueueCompatibilityMaintenance } = require('./queue-compatibility-maintenance.cjs');
const { channelEnabled } = require('./staff-event-preferences.cjs');
const {
  exclusions,
  candidateAfter,
  organizationQueue,
  createOrganizationClaims,
} = require('./queue-org134.cjs');
function createStaffOrganizationQueue(c, work, channel) {
  const { db, id, open } = c,
    domain = 'staff-' + channel;
  const table = channel === 'max' ? 'staff_max_jobs' : 'staff_notification_jobs';
  const sql = queueStatements(domain),
    cleanup = createQueueCompatibilityMaintenance(c, table);
  const choose = createOrganizationClaims(c, domain);
  const hint = db.prepare(`SELECT id,organization_id,next_at FROM ${table} WHERE next_at<=?
    AND (status='pending' OR (status='sending' AND lease_until<=?)) AND ${candidateAfter}
    AND organization_id NOT IN (${exclusions}) ORDER BY next_at,id LIMIT 1`);
  function claim(now = Date.now()) {
    if (!channelEnabled(c, channel)) return null;
    return choose(
      (omitted, cursor) => hint.get(now, now, cursor.nextAt, cursor.nextAt, cursor.id, ...omitted),
      (org) => {
        if (!channelEnabled(c, channel)) return null;
        cleanup.sweep(now, org);
        cleanup.recover(now, 8, org);
        work.pruneManaged(now, org);
        const row = work.next(now, true, org);
        if (!row) return null;
        const leaseId = id(),
          until = now + 120000;
        const changed = db
          .prepare(sql.claim.sql)
          .run(
            until,
            leaseId,
            org,
            row.id,
            row.status,
            row.attempts,
            row.lease_until,
            row.lease_id,
          ).changes;
        return changed
          ? {
              ...row,
              attempts: row.attempts + 1,
              lease_id: leaseId,
              lease_until: until,
              decoded: open(row.value),
            }
          : null;
      },
    );
  }
  return {
    claim,
    claimManaged: claim,
    finish(job, status, nextAt = 0, refund = false) {
      return organizationQueue(c, domain, job.organization_id, () => {
        const changed = Boolean(
          db
            .prepare(sql.finish.sql)
            .run(
              status,
              nextAt,
              refund ? 1 : 0,
              job.organization_id,
              job.id,
              job.lease_id,
              job.lease_until,
              refund ? 1 : 0,
            ).changes,
        );
        if (changed && job.decoded.kind === 'test' && !['pending', 'sending'].includes(status))
          work.forget(job.id, job.organization_id);
        return changed;
      });
    },
    deliveryFor: (job, callback) => organizationQueue(c, domain, job.organization_id, callback),
  };
}
module.exports = { createStaffOrganizationQueue };
