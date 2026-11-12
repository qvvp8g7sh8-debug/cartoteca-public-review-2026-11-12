const {
  STAFF_EVENTS,
  APPOINTMENT_EVENTS,
  storedEvents,
  channelEnabled,
  channelVersion,
} = require('./staff-event-preferences.cjs');
const { createStaffQueueWork } = require('./staff-queue-work.cjs');
const { createQueueCompatibilityMaintenance } = require('./queue-compatibility-maintenance.cjs');
function createStaffQueue(c, links, channel = 'telegram') {
  const { db, seal, open, transaction, id, limitKey, fail } = c;
  const queueTransaction = c.queueTransaction
    ? (work) => c.queueTransaction(work, 'staff-' + channel)
    : (work) => (db.isTransaction ? work() : transaction(work));
  if (!['telegram', 'max'].includes(channel)) throw Error('Unknown staff notification channel.');
  // Identifiers are selected from a closed server-side set, never request input.
  const linksTable = channel === 'max' ? 'staff_max_links' : 'staff_telegram_links';
  const jobsTable = channel === 'max' ? 'staff_max_jobs' : 'staff_notification_jobs';
  const work = createStaffQueueWork(c, links, channel);
  let cleanup;
  function recipients(org, staffId, event) {
    if (!channelEnabled(c, channel) || !links.allowed(org) || !STAFF_EVENTS.includes(event))
      return [];
    return links.interest
      .rows(org, staffId ?? '', event)
      .map((row) => ({ ...row, link: open(row.value) }))
      .filter(
        (row) =>
          (['owner', 'salon_admin'].includes(row.role) || row.account_id === staffId) &&
          row.link.enabled &&
          storedEvents(row.link).includes(event),
      );
  }
  function insert(org, account, value, key, now, expiresAt = now + 86400000) {
    if (!db.isTransaction) throw Error('Staff event must commit with the booking transaction.');
    const jobId = id();
    const saved = db
      .prepare(
        `INSERT OR IGNORE INTO ${jobsTable}(id,organization_id,account_id,event_key,value,status,next_at,expires_at) VALUES(?,?,?,?,?,'pending',?,?)`,
      )
      .run(jobId, org, account, limitKey('staff-booking-event', key), seal(value), now, expiresAt);
    if (saved.changes) work.notifyPending();
    return saved.changes ? jobId : null;
  }
  function enqueue(org, record, event, now = Date.now()) {
    if (!channelEnabled(c, channel)) return;
    if (!db.isTransaction) throw Error('Staff event must commit with the booking transaction.');
    if (!['new-request', 'client-agreed', 'client-declined'].includes(event)) return;
    for (const row of recipients(org, record.staffId, event))
      insert(
        org,
        row.account_id,
        {
          requestId: record.id,
          event,
          eventVersion: row.link.eventVersions?.[event] || '',
          channelVersion: channelVersion(c, channel),
          revision: record.revision,
          chatId: row.link.chatId,
          bindingId: row.link.bindingId,
        },
        JSON.stringify([record.id, event, record.revision]),
        now,
      );
  }
  function appointmentRecipients(org, staffId, event) {
    if (!APPOINTMENT_EVENTS.includes(event)) return [];
    return recipients(org, staffId, event).map((row) => ({
      accountId: row.account_id,
      bindingId: row.link.bindingId,
      eventVersion: row.link.eventVersions?.[event] || '',
    }));
  }
  function enqueueAppointment(
    org,
    staffId,
    event,
    reference,
    eventKey,
    now = Date.now(),
    intended = null,
  ) {
    if (!channelEnabled(c, channel)) return;
    if (!db.isTransaction) throw Error('Staff event must commit with the booking transaction.');
    if (!APPOINTMENT_EVENTS.includes(event)) return;
    for (const row of recipients(org, staffId, event)) {
      if (
        intended &&
        !intended.some(
          (value) =>
            value.accountId === row.account_id &&
            value.bindingId === row.link.bindingId &&
            (value.eventVersion || '') === (row.link.eventVersions?.[event] || ''),
        )
      )
        continue;
      insert(
        org,
        row.account_id,
        {
          kind: 'appointment',
          staffId,
          event,
          eventVersion: row.link.eventVersions?.[event] || '',
          channelVersion: channelVersion(c, channel),
          reference,
          chatId: row.link.chatId,
          bindingId: row.link.bindingId,
        },
        JSON.stringify(['appointment', eventKey]),
        now,
      );
    }
  }
  function test(token, value, now = Date.now()) {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => key !== 'bindingId') ||
      typeof value.bindingId !== 'string'
    )
      throw fail(400, 'Укажите своё подключение уведомлений.');
    return transaction(() => {
      if (!channelEnabled(c, channel)) throw fail(409, 'Канал уведомлений выключен.');
      const actor = c.onlineBooking.actor(token),
        org = actor.organizationId;
      const link = links.link(org, actor.accountId);
      if (!link || link.bindingId !== value.bindingId)
        throw fail(409, 'Привязка уже изменилась. Обновите её состояние.');
      if (!links.allowed(org)) throw fail(403, 'Уведомления недоступны.');
      if (link.lastTestAt && now - link.lastTestAt < 30000)
        throw fail(429, 'Подождите 30 секунд перед повторной проверкой.');
      db.prepare(`UPDATE ${linksTable} SET value=? WHERE organization_id=? AND account_id=?`).run(
        seal({ ...link, lastTestAt: now }),
        org,
        actor.accountId,
      );
      const jobId = insert(
        org,
        actor.accountId,
        {
          kind: 'test',
          event: 'test',
          channelVersion: channelVersion(c, channel),
          chatId: link.chatId,
          bindingId: link.bindingId,
        },
        JSON.stringify(['test', id()]),
        now,
        now + 60000,
      );
      if (jobId) work.remember(jobId, now);
      return { queued: true };
    });
  }
  function claim(now = Date.now(), managed = false) {
    // No writes, cleanup, leases, or transaction while this enabled channel is idle.
    if (!work.hasPendingWork(now)) return null;
    // The explicit legacy API also prunes a runtime-key range. Only managed
    // delivery/Q1 uses the closed queue intent; legacy keeps the policy fence.
    const claimTransaction =
      !managed && !c.notificationMaintenance?.enabled ? transaction : queueTransaction;
    return claimTransaction(() => {
      if (!channelEnabled(c, channel)) return null;
      if (c.notificationMaintenance?.enabled && channel === 'max')
        c.notificationMaintenance.recoverStaffMax(now);
      if (managed && !c.notificationMaintenance?.enabled) {
        cleanup ||= createQueueCompatibilityMaintenance(c, jobsTable);
        cleanup.sweep(now);
        cleanup.recover(now);
        work.pruneManaged(now);
      } else if (!c.notificationMaintenance?.enabled) {
        if (channel === 'max')
          db.prepare(
            "UPDATE staff_max_jobs SET status='uncertain',lease_id=NULL,lease_until=0 WHERE status='sending' AND lease_until<=?",
          ).run(now);
        db.prepare(
          `UPDATE ${jobsTable} SET status='cancelled',lease_id=NULL,lease_until=0 WHERE expires_at<=? AND status IN ('pending','sending')`,
        ).run(now);
        db.prepare(
          `DELETE FROM ${jobsTable} WHERE expires_at<? AND status IN ('sent','failed','cancelled'${channel === 'max' ? ",'uncertain'" : ''})`,
        ).run(now - 7 * 86400000);
        work.prune(now);
      }
      const row = work.next(now, managed);
      if (!row) return null;
      const leaseId = id(),
        leaseUntil = now + 120000;
      const claimed = db
        .prepare(
          `UPDATE ${jobsTable} SET status='sending',attempts=attempts+1,lease_until=?,lease_id=? WHERE id=? AND status=? AND attempts=? AND lease_until=? AND lease_id IS ?`,
        )
        .run(leaseUntil, leaseId, row.id, row.status, row.attempts, row.lease_until, row.lease_id);
      if (!claimed.changes) return null;
      return {
        ...row,
        attempts: row.attempts + 1,
        lease_id: leaseId,
        lease_until: leaseUntil,
        decoded: open(row.value),
      };
    });
  }
  function finish(job, status, nextAt = 0, refund = false) {
    return queueTransaction(() => {
      const finished = Boolean(
        db
          .prepare(
            `UPDATE ${jobsTable} SET status=?,next_at=?,lease_until=0,lease_id=NULL,attempts=attempts-? WHERE id=? AND status='sending' AND lease_id=? AND lease_until=?`,
          )
          .run(status, nextAt, refund ? 1 : 0, job.id, job.lease_id, job.lease_until).changes,
      );
      if (finished && job.decoded.kind === 'test' && !['pending', 'sending'].includes(status))
        work.forget(job.id);
      return finished;
    });
  }
  function valid(job, now, resolveAppointment = () => null) {
    if (
      !channelEnabled(c, channel) ||
      (job.decoded.channelVersion || '') !== channelVersion(c, channel) ||
      !links.allowed(job.organization_id) ||
      job.expires_at <= now ||
      job.lease_until <= now
    )
      return null;
    const recipient = links.link(job.organization_id, job.account_id),
      actor = links.member(job.organization_id, job.account_id);
    const test = job.decoded.event === 'test' && job.decoded.kind === 'test';
    if (
      !recipient ||
      (!test && (!recipient.enabled || !storedEvents(recipient).includes(job.decoded.event))) ||
      recipient.bindingId !== job.decoded.bindingId ||
      recipient.chatId !== job.decoded.chatId ||
      (!test &&
        (recipient.eventVersions?.[job.decoded.event] || '') !==
          (job.decoded.eventVersion || '')) ||
      !actor
    )
      return null;
    const lease = db
      .prepare(
        `SELECT 1 FROM ${jobsTable} WHERE id=? AND status='sending' AND lease_id=? AND lease_until=?`,
      )
      .get(job.id, job.lease_id, job.lease_until);
    if (!lease) return null;
    if (test) return { kind: 'test' };
    if (job.decoded.kind === 'appointment') {
      if (
        !APPOINTMENT_EVENTS.includes(job.decoded.event) ||
        (!['owner', 'salon_admin'].includes(actor.role) && job.account_id !== job.decoded.staffId)
      )
        return null;
      return resolveAppointment(job);
    }
    const r = c.bookingRequests.get(job.organization_id, job.decoded.requestId, now);
    if (!r || (!['owner', 'salon_admin'].includes(actor.role) && job.account_id !== r.staffId))
      return null;
    if (
      job.decoded.event === 'new-request' &&
      (!['pending', 'requested'].includes(r.status) ||
        r.proposal ||
        r.revision !== job.decoded.revision)
    )
      return null;
    if (
      job.decoded.event === 'client-agreed' &&
      (r.status !== 'requested' ||
        r.proposal?.state !== 'agreed' ||
        r.revision !== job.decoded.revision)
    )
      return null;
    if (
      job.decoded.event === 'client-declined' &&
      (r.status !== 'rejected' ||
        r.proposal?.state !== 'declined' ||
        r.revision !== job.decoded.revision)
    )
      return null;
    if (!['new-request', 'client-agreed', 'client-declined'].includes(job.decoded.event))
      return null;
    return r;
  }
  function organizationPage(cursor = '', limit = 5) {
    if (typeof cursor !== 'string' || !Number.isSafeInteger(limit) || limit < 1 || limit > 25)
      throw Error('Invalid staff notification organization page.');
    if (!channelEnabled(c, channel)) return { organizations: [], cursor: '' };
    if (typeof links.interest.organizationPage === 'function')
      return links.interest.organizationPage(cursor, limit);
    const organizations = links.interest.organizations(cursor, limit);
    return { organizations, cursor: organizations.length === limit ? organizations.at(-1) : '' };
  }
  return {
    enqueue,
    enqueueAppointment,
    appointmentRecipients,
    test,
    claim,
    claimManaged: (now) => claim(now, true),
    finish,
    valid,
    organizationPage,
    hasPendingWork: work.hasPendingWork,
    nextPendingAt: work.nextPendingAt,
    subscribePending: work.subscribePending,
    hasAppointmentRecipients: (org) =>
      channelEnabled(c, channel) && links.allowed(org) && links.interest.hasAppointments(org),
    inTransaction: () => db.isTransaction,
    ...(typeof c.organizationQueueTransaction === 'function'
      ? require('./staff-org-queue134.cjs').createStaffOrganizationQueue(c, work, channel)
      : {}),
  };
}
module.exports = { createStaffQueue };
