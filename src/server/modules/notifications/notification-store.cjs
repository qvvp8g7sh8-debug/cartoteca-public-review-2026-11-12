const crypto = require('node:crypto');
const { createQueueCompatibilityMaintenance } = require('./queue-compatibility-maintenance.cjs');
const { createBatchQuery, pairKey } = require('./appointment-state-batch.cjs');

function cancelNotificationKinds(
  { db, seal, open },
  org,
  kinds,
  patient = '',
  appointment = '',
  now = Date.now(),
) {
  if (!kinds.length || db.prepare('PRAGMA user_version').get().user_version < 14) return 0;
  const rows = db
    .prepare(
      "SELECT id,value FROM notification_channel_jobs WHERE organization_id=? AND (?='' OR patient_id=?) AND (?='' OR appointment_id=?) AND status IN ('pending','reserved')",
    )
    .all(org, patient, patient, appointment, appointment);
  const cancel = db.prepare(
    "UPDATE notification_channel_jobs SET status='cancelled',lease_until=0,value=? WHERE id=? AND organization_id=? AND status IN ('pending','reserved')",
  );
  let count = 0;
  for (const row of rows) {
    const value = open(row.value);
    if (kinds.includes(value.kind || 'reminder'))
      count += cancel.run(seal({ ...value, updatedAt: now }), row.id, org).changes;
  }
  return count;
}
function createNotificationStore(context) {
  const { db, seal, open, transaction, tokenHash, audit } = context;
  const activity = require('./queue-activity.cjs').createQueueActivity(db, 'client');
  const nextPendingAt = require('./queue-idle-probe.cjs').createQueueNextDue(
    db,
    'notification_channel_jobs',
  );
  const queueTransaction = context.queueTransaction
    ? (work) => context.queueTransaction(work, 'client')
    : (work) => (db.isTransaction ? work() : transaction(work));
  const compatibility = new Map();
  function managedCleanup(channels) {
    const key = [...channels].sort().join(',');
    if (!compatibility.has(key))
      compatibility.set(
        key,
        createQueueCompatibilityMaintenance(context, 'notification_channel_jobs', channels),
      );
    return compatibility.get(key);
  }
  const interest = require('./client-notification-interest.cjs').createClientNotificationInterest(
    context,
  );
  // Schema 16 only adds staff MAX tables; the prepared client queue is unchanged.
  // Startup still requires an explicit, exact notificationSchema in platform-database.
  if (![14, 15, 16, 17, 18, 19, 20].includes(db.prepare('PRAGMA user_version').get().user_version))
    throw Error('Notification storage requires a separately prepared supported schema (14–19).');
  const decode = (row) => (row ? { ...row, decoded: open(row.value) } : null);
  const receiptsQuery = createBatchQuery(
    db,
    `SELECT c.patient_id,c.appointment_id,c.value
    FROM json_each((SELECT entries FROM request_scope)) r CROSS JOIN notification_confirmations c
    ON c.patient_id=json_extract(r.value,'$.patient') AND c.appointment_id=json_extract(r.value,'$.appointment')
      AND c.stamp=json_extract(r.value,'$.stamp') WHERE c.organization_id=(SELECT org FROM request_scope)`,
  );
  const jobsQuery = createBatchQuery(
    db,
    `SELECT j.* FROM json_each((SELECT entries FROM request_scope)) r
    CROSS JOIN notification_channel_jobs j ON j.patient_id=json_extract(r.value,'$.patient')
      AND j.appointment_id=json_extract(r.value,'$.appointment') AND j.stamp=json_extract(r.value,'$.stamp')
    WHERE j.organization_id=(SELECT org FROM request_scope) ORDER BY j.channel`,
  );
  const receiptQuery = db.prepare(
    'SELECT value FROM notification_confirmations WHERE organization_id=? AND patient_id=? AND appointment_id=? AND stamp=?',
  );
  const listQuery = db.prepare(
    'SELECT * FROM notification_channel_jobs WHERE organization_id=? AND patient_id=? AND appointment_id=? AND stamp=? ORDER BY channel',
  );
  const linkedPatientsQuery = createBatchQuery(
    db,
    `SELECT l.patient_id FROM json_each((SELECT entries FROM request_scope)) r
    CROSS JOIN telegram_links l ON l.patient_id=r.value
    WHERE l.organization_id=(SELECT org FROM request_scope)
    UNION SELECT l.patient_id FROM json_each((SELECT entries FROM request_scope)) r
    CROSS JOIN max_client_links l ON l.patient_id=r.value
    WHERE l.organization_id=(SELECT org FROM request_scope)`,
  );
  // Negative scheduling filter only. Do not decode bindings or treat this snapshot
  // as permission to enqueue/send: policy.current checks those afresh under locks.
  const singleChannelLinks = new Map();
  function linkedPatients(org, patients, channels = ['telegram', 'max']) {
    if (
      !Array.isArray(channels) ||
      channels.some((channel) => !['telegram', 'max'].includes(channel))
    )
      throw Error('Invalid notification link channels.');
    const selected = [...new Set(channels)];
    if (!selected.length) return new Set();
    let query = linkedPatientsQuery;
    if (selected.length === 1) {
      const channel = selected[0];
      if (!singleChannelLinks.has(channel)) {
        const table = channel === 'telegram' ? 'telegram_links' : 'max_client_links';
        singleChannelLinks.set(
          channel,
          createBatchQuery(
            db,
            `SELECT l.patient_id FROM json_each((SELECT entries FROM request_scope)) r
          CROSS JOIN ${table} l ON l.patient_id=r.value
          WHERE l.organization_id=(SELECT org FROM request_scope)`,
          ),
        );
      }
      query = singleChannelLinks.get(channel);
    }
    return new Set(query(org, [...new Set(patients)]).map((row) => row.patient_id));
  }
  function readMany(org, entries, { includeJobs = true } = {}) {
    const receipts = new Map(),
      jobs = new Map();
    for (const row of receiptsQuery(org, entries))
      receipts.set(pairKey(row.patient_id, row.appointment_id), open(row.value));
    for (const row of includeJobs ? jobsQuery(org, entries) : []) {
      const key = pairKey(row.patient_id, row.appointment_id);
      if (!jobs.has(key)) jobs.set(key, []);
      jobs.get(key).push(decode(row));
    }
    return { receipts, jobs };
  }
  readMany.readRequests = (org, entries, { includeJobs = true } = {}) => [
    ...receiptsQuery.readRequests(org, entries),
    ...(includeJobs ? jobsQuery.readRequests(org, entries) : []),
  ];
  const organizations = (channels = ['telegram', 'max'], kind = 'all') =>
    interest.organizations(channels, kind);
  const organizationBatch = (
    cursor = '',
    limit = 25,
    channels = ['telegram', 'max'],
    kind = 'all',
  ) => interest.batch(cursor, limit, channels, kind);
  function list(org, patient, appointment, stamp) {
    return listQuery.all(org, patient, appointment, stamp).map(decode);
  }
  function read(org, patient, appointment, stamp, channel) {
    return decode(
      db
        .prepare(
          'SELECT * FROM notification_channel_jobs WHERE organization_id=? AND patient_id=? AND appointment_id=? AND stamp=? AND channel=?',
        )
        .get(org, patient, appointment, stamp, channel),
    );
  }
  // Called under the shared platform lock. Cancelled, never-started work may be replaced.
  function enqueue(
    {
      org,
      patient,
      appointment,
      stamp,
      recipient,
      channel,
      channelVersion = '',
      expiresAt,
      kind = 'reminder',
      sourceStamp,
      eventId,
      eventAt,
      sourceRevision,
      preferenceVersion,
      removed,
      snapshot,
      previous,
    },
    now,
  ) {
    const prior = read(org, patient, appointment, stamp, channel);
    if (prior && prior.status !== 'cancelled') return prior;
    const callback = crypto.randomBytes(20).toString('base64url');
    const value = {
      recipient,
      channel,
      channelVersion,
      callback,
      kind,
      createdAt: now,
      updatedAt: now,
      ...(sourceStamp
        ? {
            sourceStamp,
            eventId,
            eventAt,
            sourceRevision,
            preferenceVersion,
            removed,
            previous,
            ...(snapshot ? { snapshot } : {}),
          }
        : {}),
    };
    if (prior)
      db.prepare(
        "UPDATE notification_channel_jobs SET callback_hash=?,value=?,status='pending',next_at=?,expires_at=?,attempt=0,lease_until=0 WHERE id=? AND organization_id=? AND status='cancelled'",
      ).run(tokenHash(callback), seal(value), now, expiresAt, prior.id, org);
    else
      db.prepare(
        "INSERT INTO notification_channel_jobs(id,organization_id,patient_id,appointment_id,stamp,channel,callback_hash,value,status,next_at,expires_at) VALUES(?,?,?,?,?,?,?,?,'pending',?,?)",
      ).run(
        crypto.randomUUID(),
        org,
        patient,
        appointment,
        stamp,
        channel,
        tokenHash(callback),
        seal(value),
        now,
        expiresAt,
      );
    activity.notify();
    return read(org, patient, appointment, stamp, channel);
  }
  function cancel(org, patient, appointment = '') {
    // An in-flight or uncertain channel must never be implicitly resent.
    db.prepare(
      "UPDATE notification_channel_jobs SET status='cancelled',lease_until=0 WHERE organization_id=? AND patient_id=? AND (?='' OR appointment_id=?) AND status IN ('pending','reserved')",
    ).run(org, patient, appointment, appointment);
  }
  const pendingHints = new Map();
  // Only a fresh negative scheduling hint, never permission to claim or send.
  // Check the due/lease indexes before decoding recipients or channel epochs.
  function hasPendingWork(now, channels = ['telegram', 'max']) {
    if (!Array.isArray(channels) || channels.some((c) => !['telegram', 'max'].includes(c)))
      throw Error('Invalid notification hint channels.');
    const selected = [...new Set(channels)].sort();
    if (!selected.length) return false;
    const key = selected.join(',');
    if (!pendingHints.has(key)) {
      const scope = selected.map(() => '?').join(',');
      pendingHints.set(
        key,
        db.prepare(`SELECT 1 FROM notification_channel_jobs
        WHERE status='pending' AND next_at<=? AND channel IN (${scope})
        UNION ALL SELECT 1 FROM notification_channel_jobs
        WHERE status IN ('reserved','sending') AND lease_until<=? AND channel IN (${scope}) LIMIT 1`),
      );
    }
    return Boolean(pendingHints.get(key).get(now, ...selected, now, ...selected));
  }
  function claim(now, channels = ['telegram', 'max'], managed = false) {
    if (
      !Array.isArray(channels) ||
      channels.some((channel) => !['telegram', 'max'].includes(channel))
    )
      throw Error('Invalid notification claim channels.');
    const selected = [...new Set(channels)];
    if (!selected.length) return null;
    const scope = selected.map(() => '?').join(',');
    if (context.notificationMaintenance?.enabled) {
      const ready = db.prepare(
        `SELECT * FROM notification_channel_jobs WHERE status='pending' AND next_at<=? AND expires_at>? AND channel IN (${scope}) ORDER BY next_at,id LIMIT 1`,
      );
      if (
        !db
          .prepare(
            `SELECT id FROM notification_channel_jobs WHERE status='pending' AND next_at<=? AND expires_at>? AND channel IN (${scope}) ORDER BY next_at,id LIMIT 1`,
          )
          .get(now, now, ...selected) &&
        !db
          .prepare(
            `SELECT 1 FROM notification_channel_jobs WHERE status='reserved' AND lease_until<=? AND channel IN (${scope}) UNION ALL SELECT 1 FROM notification_channel_jobs WHERE status='sending' AND lease_until<=? AND channel IN (${scope}) LIMIT 1`,
          )
          .get(now, ...selected, now, ...selected)
      )
        return null;
      return queueTransaction(() => {
        context.notificationMaintenance.recoverClient(now, selected);
        const row = ready.get(now, now, ...selected);
        if (!row) return null;
        const until = now + 120000;
        const saved = db
          .prepare(
            "UPDATE notification_channel_jobs SET status='reserved',attempt=attempt+1,lease_until=? WHERE id=? AND status='pending' AND attempt=? AND lease_until=? AND next_at<=? AND expires_at>?",
          )
          .run(until, row.id, row.attempt, row.lease_until, now, now);
        return saved.changes
          ? decode({ ...row, status: 'reserved', attempt: row.attempt + 1, lease_until: until })
          : null;
      });
    }
    const available = db
      .prepare(
        `SELECT 1 FROM notification_channel_jobs
      WHERE status='pending' AND next_at<=? AND channel IN (${scope})
      UNION ALL SELECT 1 FROM notification_channel_jobs
      WHERE status='reserved' AND lease_until<=? AND channel IN (${scope})
      UNION ALL SELECT 1 FROM notification_channel_jobs
      WHERE status='sending' AND lease_until<=? AND channel IN (${scope}) LIMIT 1`,
      )
      .get(now, ...selected, now, ...selected, now, ...selected);
    if (!available) return null;
    if (managed) {
      const cleanup = managedCleanup(selected);
      return queueTransaction(() => {
        cleanup.sweep(now);
        cleanup.recover(now);
        const row = db
          .prepare(
            `SELECT * FROM notification_channel_jobs WHERE status='pending' AND next_at<=? AND expires_at>? AND channel IN (${scope}) ORDER BY next_at,id LIMIT 1`,
          )
          .get(now, now, ...selected);
        if (!row || cleanup.blocks(now, row.next_at)) return null;
        const until = now + 120000;
        const changed = db
          .prepare(
            "UPDATE notification_channel_jobs SET status='reserved',attempt=attempt+1,lease_until=? WHERE id=? AND status='pending' AND attempt=? AND lease_until=? AND next_at<=? AND expires_at>?",
          )
          .run(until, row.id, row.attempt, row.lease_until, now, now).changes;
        return changed
          ? decode({ ...row, status: 'reserved', attempt: row.attempt + 1, lease_until: until })
          : null;
      });
    }
    return queueTransaction(() => {
      // Disabled/unready channels are left untouched. The existing status/next_at
      // index narrows due work before SQLite applies the closed channel filter.
      db.prepare(
        `UPDATE notification_channel_jobs SET status='uncertain',lease_until=0 WHERE status='sending' AND lease_until<=? AND channel IN (${scope})`,
      ).run(now, ...selected);
      db.prepare(
        `UPDATE notification_channel_jobs SET status='pending',lease_until=0 WHERE status='reserved' AND lease_until<=? AND channel IN (${scope})`,
      ).run(now, ...selected);
      db.prepare(
        `UPDATE notification_channel_jobs SET status='cancelled' WHERE status='pending' AND expires_at<=? AND channel IN (${scope})`,
      ).run(now, ...selected);
      const row = db
        .prepare(
          `SELECT * FROM notification_channel_jobs WHERE status='pending' AND next_at<=? AND channel IN (${scope}) ORDER BY next_at,id LIMIT 1`,
        )
        .get(now, ...selected);
      if (!row) return null;
      db.prepare(
        "UPDATE notification_channel_jobs SET status='reserved',attempt=attempt+1,lease_until=? WHERE id=?",
      ).run(now + 120000, row.id);
      return decode({
        ...row,
        status: 'reserved',
        attempt: row.attempt + 1,
        lease_until: now + 120000,
      });
    });
  }
  function transition(job, from, status, nextAt = 0, now = Date.now(), acknowledgement = {}) {
    return queueTransaction(() => {
      return Boolean(
        db
          .prepare(
            'UPDATE notification_channel_jobs SET status=?,next_at=?,lease_until=?,value=? WHERE id=? AND status=? AND attempt=? AND callback_hash=? AND lease_until=?',
          )
          .run(
            status,
            nextAt,
            status === 'sending' ? job.lease_until : 0,
            seal({
              ...job.decoded,
              updatedAt: now,
              ...(status === 'sent' ? { acceptedAt: now, ...acknowledgement } : {}),
            }),
            job.id,
            from,
            job.attempt,
            tokenHash(job.decoded.callback),
            job.lease_until,
          ).changes,
      );
    });
  }
  function callback(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{27}$/.test(token)) return null;
    return decode(
      db
        .prepare(
          "SELECT * FROM notification_channel_jobs WHERE callback_hash=? AND status IN ('sending','sent','uncertain')",
        )
        .get(tokenHash(token)),
    );
  }
  function confirmed(org, patient, appointment, stamp) {
    const row = receiptQuery.get(org, patient, appointment, stamp);
    return row ? open(row.value) : null;
  }
  function confirm(job, now) {
    const existing = confirmed(job.organization_id, job.patient_id, job.appointment_id, job.stamp);
    if (existing) {
      cancelNotificationKinds(
        { db, seal, open },
        job.organization_id,
        ['reminder'],
        job.patient_id,
        job.appointment_id,
        now,
      );
      return { ...existing, first: false };
    }
    const receipt = {
      notificationConfirmedAt: now,
      notificationConfirmedChannel: job.decoded.channel,
    };
    db.prepare('INSERT INTO notification_confirmations VALUES(?,?,?,?,?)').run(
      job.organization_id,
      job.patient_id,
      job.appointment_id,
      job.stamp,
      seal(receipt),
    );
    cancelNotificationKinds(
      { db, seal, open },
      job.organization_id,
      ['reminder'],
      job.patient_id,
      job.appointment_id,
      now,
    );
    audit('notification_appointment_confirmed', null, job.organization_id, {
      patientId: job.patient_id,
      appointmentId: job.appointment_id,
      channel: job.decoded.channel,
    });
    return { ...receipt, first: true };
  }
  function cancelLegacyPending(org, patient, fingerprint) {
    db.prepare(
      "UPDATE telegram_jobs SET status='cancelled' WHERE organization_id=? AND patient_id=? AND fingerprint=? AND status='pending'",
    ).run(org, patient, fingerprint);
  }
  return {
    prefetchReads: (requests) =>
      db.canPrefetchReads && requests.length > 0 && requests.length <= 32
        ? db.prefetchReads(requests)
        : false,
    transaction,
    // Delivery only writes this queue. Confirmation/cross-channel fanout keeps
    // the original policy writer exposed by transaction above.
    deliveryTransaction: queueTransaction,
    deliveryReadMode: db.dialect === 'postgres' ? 'DEFERRED' : 'IMMEDIATE',
    inTransaction: () => db.isTransaction,
    cancelKinds: (org, kinds, patient = '', appointment = '') =>
      cancelNotificationKinds({ db, seal, open }, org, kinds, patient, appointment),
    organizations,
    organizationBatch,
    hasReminderRecipients: (org = '', channels = ['telegram', 'max']) =>
      interest.has(org, channels, 'reminder'),
    hasNotificationRecipients: (channels = ['telegram', 'max']) =>
      interest.has('', channels, 'all'),
    linkedPatients,
    read,
    list,
    readMany,
    enqueue,
    cancel,
    cancelLegacyPending,
    claim,
    claimManaged: (now, channels) => claim(now, channels, true),
    hasPendingWork,
    nextPendingAt,
    subscribePending: activity.subscribe,
    transition,
    callback,
    confirmed,
    confirm,
    ...(typeof context.organizationQueueTransaction === 'function'
      ? require('./client-org-queue134.cjs').createClientOrganizationQueue(context)
      : {}),
  };
}
module.exports = { createNotificationStore, cancelNotificationKinds };
