const { eventCategory } = require('./push-validation.cjs');
const { createQueueCompatibilityMaintenance } = require('./queue-compatibility-maintenance.cjs');
function createPushQueue(c, devices) {
  const { db, seal, open, transaction, id, limitKey } = c;
  const queueTransaction = c.queueTransaction
    ? (work) => c.queueTransaction(work, 'push')
    : (work) => (db.isTransaction ? work() : transaction(work));
  const cleanup = c.notificationMaintenance?.enabled
    ? null
    : createQueueCompatibilityMaintenance(c, 'staff_push_jobs');
  function maintainManaged(now = Date.now()) {
    return cleanup?.hasRows()
      ? queueTransaction(() => cleanup.sweep(now))
      : { examined: 0, changed: 0 };
  }
  function enqueue(
    org,
    staffId,
    event,
    reference,
    eventKey,
    expiresAt = Date.now() + 86400000,
    onlyDevice = '',
  ) {
    if (!db.isTransaction) throw Error('Push event requires platform transaction.');
    if (!devices.runtimeAvailable()) return;
    for (const row of devices.recipients(org, staffId, event, reference)) {
      if (onlyDevice && onlyDevice !== row.id) continue;
      db.prepare(
        "INSERT INTO staff_push_jobs(id,organization_id,account_id,device_id,event_key,value,status,next_at,expires_at) VALUES(?,?,?,?,?,?,'pending',?,?) ON CONFLICT(device_id,event_key) DO UPDATE SET value=excluded.value,status='pending',next_at=excluded.next_at,expires_at=excluded.expires_at,attempts=0,lease_id=NULL,lease_until=0 WHERE staff_push_jobs.organization_id=excluded.organization_id AND (staff_push_jobs.status='cancelled' OR (? AND staff_push_jobs.status='pending' AND staff_push_jobs.expires_at<>excluded.expires_at))",
      ).run(
        id(),
        org,
        row.account_id,
        row.id,
        limitKey('staff-push-event', eventKey),
        seal({
          event,
          reference,
          staffId,
          bindingId: row.decoded.bindingId,
          channelVersion: devices.channelVersion(),
        }),
        Date.now(),
        expiresAt,
        event === 'reminder' && reference.kind === 'workday' ? 1 : 0,
      );
    }
  }
  function test(token, deviceId, now = Date.now()) {
    return transaction(() => {
      const user = devices.actor(token),
        row = devices.owned(user, deviceId);
      if (!devices.runtimeAvailable()) throw c.fail(503, 'Пуш-уведомления выключены на сервере.');
      if (!row.decoded.enabled || !devices.allowed(user.organizationId))
        throw c.fail(403, 'Подключите уведомления.');
      const recent = db
        .prepare(
          'SELECT 1 FROM staff_push_jobs WHERE device_id=? AND next_at>? AND expires_at>? LIMIT 1',
        )
        .get(deviceId, now - 30000, now);
      if (recent) throw c.fail(429, 'Подождите 30 секунд перед повторной проверкой.');
      db.prepare(
        "INSERT INTO staff_push_jobs(id,organization_id,account_id,device_id,event_key,value,status,next_at,expires_at) VALUES(?,?,?,?,?,?,'pending',?,?)",
      ).run(
        id(),
        user.organizationId,
        user.accountId,
        deviceId,
        id(),
        seal({
          event: 'test',
          bindingId: row.decoded.bindingId,
          reference: {},
          channelVersion: devices.channelVersion(),
        }),
        now,
        now + 60000,
      );
      return { queued: true };
    });
  }
  const due = [false, true].map((probeOnly) =>
    db.prepare(
      "SELECT * FROM staff_push_jobs WHERE next_at<=? AND (status='pending' OR (status='sending' AND lease_until<=?))" +
        (c.notificationMaintenance?.enabled
          ? " AND status IN ('pending','sending') AND expires_at>?"
          : '') +
        (probeOnly ? " AND event_key NOT LIKE 'staff-push-event:%'" : '') +
        ' ORDER BY next_at,id LIMIT 1',
    ),
  );
  function claim(now = Date.now()) {
    if (!devices.runtimeAvailable()) return null;
    const hasEvents = devices.hasEnabledEvents();
    if (!hasEvents && !devices.hasPendingTests(now)) return null;
    const select = due[hasEvents ? 0 : 1];
    const parameters = c.notificationMaintenance?.enabled ? [now, now, now] : [now, now];
    // No write transaction for an empty queue. Reselect under the lock below.
    if (!select.get(...parameters)) return null;
    return queueTransaction(() => {
      if (!c.notificationMaintenance?.enabled) {
        db.prepare(
          "UPDATE staff_push_jobs SET status='cancelled',lease_id=NULL,lease_until=0 WHERE expires_at<=? AND status IN ('pending','sending')",
        ).run(now);
        db.prepare(
          "DELETE FROM staff_push_jobs WHERE expires_at<? AND status IN ('sent','failed','cancelled')",
        ).run(now - 7 * 86400000);
      }
      const row = select.get(...parameters);
      if (!row) return null;
      const lease = id(),
        until = now + 60000,
        decoded = open(row.value);
      const claimed = db
        .prepare(
          "UPDATE staff_push_jobs SET status='sending',attempts=attempts+1,lease_id=?,lease_until=? WHERE id=? AND status=? AND attempts=? AND lease_until=? AND lease_id IS ?",
        )
        .run(lease, until, row.id, row.status, row.attempts, row.lease_until, row.lease_id);
      if (!claimed.changes) return null;
      return {
        ...row,
        lease_id: lease,
        lease_until: until,
        attempts: row.attempts + 1,
        decoded,
      };
    });
  }
  // Managed delivery keeps legacy claim() intact. Two status-specific heads
  // avoid the OR's whole-ready merge; the outer sort sees at most two rows.
  // Legacy(status,next_at) still needs tie sorting on id; Q1 is not enabled here.
  const managed = [false, true].map((probeOnly) => {
    function head(status, peek) {
      return (
        `SELECT ${peek ? 'j.next_at,j.lease_until,j.status' : 'j.*'} FROM staff_push_jobs j` +
        (c.notificationMaintenance?.enabled && !peek && status === 'pending'
          ? ' INDEXED BY nqm_v1_push_ready'
          : '') +
        ` WHERE j.status='${status}' AND j.next_at<=?` +
        (status === 'sending' ? ' AND j.lease_until<=?' : '') +
        // Expired entries are never candidates, even while a bounded legacy
        // cleanup has not reached their primary-key page yet.
        ' AND j.expires_at>?' +
        (c.notificationMaintenance?.enabled ? " AND j.status IN ('pending','sending')" : '') +
        (probeOnly ? " AND j.event_key NOT LIKE 'staff-push-event:%'" : '') +
        ' AND j.device_id NOT IN (?,?,?,?) AND j.organization_id NOT IN (?,?)' +
        " AND NOT EXISTS(SELECT 1 FROM staff_push_jobs live WHERE live.device_id=j.device_id AND live.status='sending' AND live.lease_until>?)" +
        ' ORDER BY j.next_at' +
        (peek ? '' : ',j.id') +
        ' LIMIT 1'
      );
    }
    return {
      select: db.prepare(
        `SELECT * FROM (${head('pending', false)}) UNION ALL SELECT * FROM (${head('sending', false)}) ORDER BY next_at,id LIMIT 1`,
      ),
      peek: ['pending', 'sending'].map((status) => db.prepare(head(status, true))),
    };
  });
  function managedParameters(now, options = {}) {
    const devices = options.excludeDevices || [],
      organizations = options.excludeOrganizations || [];
    if (
      !Number.isSafeInteger(now) ||
      devices.length > 4 ||
      organizations.length > 2 ||
      !Array.isArray(devices) ||
      !Array.isArray(organizations) ||
      ![...devices, ...organizations].every((id) => typeof id === 'string' && id)
    )
      throw Error('Invalid managed Push exclusions.');
    const blocked = [
      ...devices,
      ...Array(4 - devices.length).fill(''),
      ...organizations,
      ...Array(2 - organizations.length).fill(''),
      now,
    ];
    return ['pending', 'sending'].map((status) => [
      now,
      ...(status === 'sending' ? [now] : []),
      now,
      ...blocked,
    ]);
  }
  function managedSelection(now) {
    if (!devices.runtimeAvailable()) return null;
    const hasEvents = devices.hasEnabledEvents();
    return hasEvents || devices.hasPendingTests(now) ? managed[hasEvents ? 0 : 1] : null;
  }
  function peekManaged(now = Date.now(), options) {
    const selection = managedSelection(now);
    if (!selection) return null;
    const parameters = managedParameters(now, options);
    const a = selection.peek[0].get(...parameters[0]),
      b = selection.peek[1].get(...parameters[1]);
    // This is the next_at age of a currently selectable head, not enqueue age
    // or an end-to-end delivery SLO. A live sending lease is never selectable.
    return !a ? b || null : !b || a.next_at <= b.next_at ? a : b;
  }
  function claimManaged(now = Date.now(), options) {
    const selection = managedSelection(now);
    if (!selection) return null;
    const parameters = managedParameters(now, options).flat();
    if (!selection.select.get(...parameters)) return null;
    return queueTransaction(() => {
      if (!devices.runtimeAvailable()) return null;
      // Preserve expiry/retention policy, but never sweep the complete table
      // on each managed send. Explicit claim() keeps its legacy contract.
      if (cleanup) cleanup.sweep(now);
      const fresh = managedSelection(now);
      const row = fresh?.select.get(...parameters);
      if (!row) return null;
      const lease = id(),
        until = now + 60000,
        decoded = open(row.value);
      const result = db
        .prepare(
          "UPDATE staff_push_jobs SET status='sending',attempts=attempts+1,lease_id=?,lease_until=? WHERE id=? AND status=? AND attempts=? AND lease_until=? AND lease_id IS ? AND NOT EXISTS(SELECT 1 FROM staff_push_jobs live WHERE live.device_id=? AND live.status='sending' AND live.lease_until>?)",
        )
        .run(
          lease,
          until,
          row.id,
          row.status,
          row.attempts,
          row.lease_until,
          row.lease_id,
          row.device_id,
          now,
        );
      return result.changes
        ? { ...row, lease_id: lease, lease_until: until, attempts: row.attempts + 1, decoded }
        : null;
    });
  }
  function valid(job, now = Date.now()) {
    if (
      !devices.runtimeAvailable() ||
      (job.decoded.channelVersion || '') !== devices.channelVersion()
    )
      return null;
    const row = devices.device(job.device_id),
      member = devices.member(job.organization_id, job.account_id);
    if (
      !row ||
      row.organization_id !== job.organization_id ||
      row.account_id !== job.account_id ||
      !row.decoded.enabled ||
      row.decoded.bindingId !== job.decoded.bindingId ||
      !member ||
      !devices.allowed(job.organization_id) ||
      job.expires_at <= now ||
      job.lease_until <= now ||
      (job.decoded.event === 'reminder' && job.account_id !== job.decoded.staffId) ||
      (job.decoded.event !== 'test' &&
        !row.decoded.preferences.events.includes(
          eventCategory(job.decoded.event, job.decoded.reference),
        )) ||
      (!['owner', 'salon_admin'].includes(member.role) &&
        job.decoded.event !== 'test' &&
        job.account_id !== job.decoded.staffId) ||
      !db
        .prepare(
          "SELECT 1 FROM staff_push_jobs WHERE id=? AND status='sending' AND lease_id=? AND lease_until=?",
        )
        .get(job.id, job.lease_id, job.lease_until)
    )
      return null;
    return row;
  }
  function deferUnstarted(job, nextAt = Date.now() + 1000) {
    return queueTransaction(() => {
      // Only a known no-send may refund its current attempt. Rebound, cancelled,
      // finished or reclaimed rows cannot be revived by a late queued callback.
      return db
        .prepare(
          "UPDATE staff_push_jobs SET status='pending',next_at=?,lease_id=NULL,lease_until=0,attempts=attempts-1 WHERE id=? AND status='sending' AND lease_id=? AND lease_until=? AND attempts=? AND attempts>0",
        )
        .run(nextAt, job.id, job.lease_id, job.lease_until, job.attempts).changes;
    });
  }
  function finish(job, status, nextAt = 0) {
    return queueTransaction(() => {
      return db
        .prepare(
          "UPDATE staff_push_jobs SET status=?,next_at=?,lease_id=NULL,lease_until=0 WHERE id=? AND status='sending' AND lease_id=? AND lease_until=?",
        )
        .run(status, nextAt, job.id, job.lease_id, job.lease_until).changes;
    });
  }
  return {
    enqueue,
    test,
    claim,
    claimManaged,
    peekManaged,
    maintainManaged,
    valid,
    deferUnstarted,
    finish,
    ...(typeof c.organizationQueueTransaction === 'function'
      ? require('./push-org-queue134.cjs').createPushOrganizationQueue(c, devices)
      : {}),
  };
}
module.exports = { createPushQueue };
