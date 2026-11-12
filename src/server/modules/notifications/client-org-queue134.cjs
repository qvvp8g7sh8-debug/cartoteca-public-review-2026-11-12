const { queueStatements } = require('../../infrastructure/postgres/queue-org-statements134.cjs');
const { createQueueCompatibilityMaintenance } = require('./queue-compatibility-maintenance.cjs');
const {
  exclusions,
  candidateAfter,
  organizationQueue,
  createOrganizationClaims,
} = require('./queue-org134.cjs');
function createClientOrganizationQueue(c) {
  const { db, seal, open, tokenHash } = c,
    domain = 'client',
    sql = queueStatements(domain);
  const shapes = new Map();
  const decode = (row) => (row ? { ...row, decoded: open(row.value) } : null);
  function selection(channels) {
    if (!Array.isArray(channels) || channels.some((value) => !['telegram', 'max'].includes(value)))
      throw Error('Invalid notification claim channels.');
    const selected = [...new Set(channels)].sort(),
      key = selected.join(',');
    if (!selected.length) return null;
    if (!shapes.has(key)) {
      const scope = selected.map(() => '?').join(',');
      shapes.set(key, {
        selected,
        choose: createOrganizationClaims(c, domain),
        cleanup: createQueueCompatibilityMaintenance(c, 'notification_channel_jobs', selected),
        hint: db.prepare(`SELECT id,organization_id,next_at FROM notification_channel_jobs WHERE
          ((status='pending' AND next_at<=?) OR (status IN ('reserved','sending') AND lease_until<=?))
          AND channel IN (${scope}) AND ${candidateAfter} AND organization_id NOT IN (${exclusions}) ORDER BY next_at,id LIMIT 1`),
        ready:
          db.prepare(`SELECT * FROM notification_channel_jobs WHERE organization_id=? AND status='pending'
          AND next_at<=? AND expires_at>? AND channel IN (${scope}) ORDER BY next_at,id LIMIT 1`),
      });
    }
    return shapes.get(key);
  }
  function claim(now = Date.now(), channels = ['telegram', 'max']) {
    const shape = selection(channels);
    if (!shape) return null;
    const { selected, cleanup } = shape;
    return shape.choose(
      (omitted, cursor) =>
        shape.hint.get(now, now, ...selected, cursor.nextAt, cursor.nextAt, cursor.id, ...omitted),
      (org) => {
        cleanup.sweep(now, org);
        if (c.notificationMaintenance?.enabled)
          c.notificationMaintenance.recoverClient(now, selected, org);
        else cleanup.recover(now, 8, org);
        const row = shape.ready.get(org, now, now, ...selected);
        if (!row || cleanup.blocks(now, row.next_at, org)) return null;
        const until = now + 120000;
        const changed = db
          .prepare(sql.claim.sql)
          .run(until, org, row.id, row.attempt, row.lease_until, now, now).changes;
        return changed
          ? decode({ ...row, status: 'reserved', attempt: row.attempt + 1, lease_until: until })
          : null;
      },
    );
  }
  return {
    claim,
    claimManaged: claim,
    transition(job, from, status, nextAt = 0, now = Date.now(), acknowledgement = {}) {
      return organizationQueue(c, domain, job.organization_id, () =>
        Boolean(
          db.prepare(sql.transition.sql).run(
            status,
            nextAt,
            status === 'sending' ? job.lease_until : 0,
            seal({
              ...job.decoded,
              updatedAt: now,
              ...(status === 'sent' ? { acceptedAt: now, ...acknowledgement } : {}),
            }),
            job.organization_id,
            job.id,
            from,
            job.attempt,
            tokenHash(job.decoded.callback),
            job.lease_until,
          ).changes,
        ),
      );
    },
    deliveryFor: (job, callback) => organizationQueue(c, domain, job.organization_id, callback),
  };
}
module.exports = { createClientOrganizationQueue };
