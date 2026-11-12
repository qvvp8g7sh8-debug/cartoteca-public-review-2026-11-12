const { queueStatements } = require('../../infrastructure/postgres/queue-org-statements134.cjs');
const { createQueueCompatibilityMaintenance } = require('./queue-compatibility-maintenance.cjs');
const {
  exclusions,
  candidateAfter,
  organizationQueue,
  createOrganizationClaims,
} = require('./queue-org134.cjs');
function createTelegramOrganizationQueue(c) {
  const { db, open, tokenHash } = c,
    domain = 'telegram',
    sql = queueStatements(domain);
  const cleanup = createQueueCompatibilityMaintenance(c, 'telegram_jobs');
  const choose = createOrganizationClaims(c, domain);
  const hint = db.prepare(`SELECT id,organization_id,next_at FROM telegram_jobs WHERE next_at<=?
    AND (status='pending' OR (status='sending' AND lease_until<=?)) AND ${candidateAfter}
    AND organization_id NOT IN (${exclusions}) ORDER BY next_at,id LIMIT 1`);
  const ready =
    db.prepare(`SELECT * FROM telegram_jobs WHERE organization_id=? AND next_at<=? AND expires_at>?
    AND (status='pending' OR (status='sending' AND lease_until<=?)) ORDER BY next_at,id LIMIT 1`);
  function claim(now = Date.now()) {
    return choose(
      (omitted, cursor) => hint.get(now, now, cursor.nextAt, cursor.nextAt, cursor.id, ...omitted),
      (org) => {
        cleanup.sweep(now, org);
        const row = ready.get(org, now, now, now);
        if (!row) return null;
        const until = now + 120000;
        const changed = db
          .prepare(sql.claim.sql)
          .run(
            until,
            org,
            row.id,
            row.status,
            row.attempts,
            row.lease_until,
            row.callback_hash,
            now,
          ).changes;
        return changed
          ? { ...row, lease_until: until, attempts: row.attempts + 1, decoded: open(row.value) }
          : null;
      },
    );
  }
  return {
    claim,
    claimManaged: claim,
    finish(job, status, nextAt = 0) {
      return organizationQueue(c, domain, job.organization_id, () =>
        Boolean(
          db
            .prepare(sql.finish.sql)
            .run(
              status,
              nextAt,
              job.organization_id,
              job.id,
              job.attempts,
              tokenHash(job.decoded.callback),
              job.lease_until,
            ).changes,
        ),
      );
    },
    defer(job, nextAt) {
      return organizationQueue(c, domain, job.organization_id, () =>
        Boolean(
          db
            .prepare(sql.defer.sql)
            .run(
              nextAt,
              job.organization_id,
              job.id,
              job.attempts,
              tokenHash(job.decoded.callback),
              job.lease_until,
            ).changes,
        ),
      );
    },
    deliveryFor: (job, callback) => organizationQueue(c, domain, job.organization_id, callback),
  };
}
module.exports = { createTelegramOrganizationQueue };
