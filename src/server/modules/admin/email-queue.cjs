function createAdminEmailQueue({ db, id, open, seal, transaction }) {
  function enqueue(operationId, kind, payload, expiresAt = Date.now() + 2 * 86400000) {
    db.prepare(
      'INSERT INTO admin_email_jobs(id,operation_id,kind,value,status,next_at,expires_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(operation_id,kind) DO NOTHING',
    ).run(id(), operationId, kind, seal(payload), 'pending', Date.now(), expiresAt);
  }
  // Walk a bounded primary-key metadata page. Expired jobs are excluded from
  // delivery immediately; maintenance never scans or updates the whole table.
  let cleanupCursor = '';
  function cleanup(now) {
    const rows = db
      .prepare(
        'SELECT id,status,expires_at,lease_id,lease_until FROM admin_email_jobs WHERE id>? ORDER BY id LIMIT 64',
      )
      .all(cleanupCursor);
    const cancel = db.prepare(
      "UPDATE admin_email_jobs SET status='cancelled',lease_id=NULL,lease_until=0 WHERE id=? AND status=? AND expires_at=? AND lease_id IS ? AND lease_until=?",
    );
    for (const row of rows) {
      if (row.expires_at <= now && ['pending', 'sending'].includes(row.status))
        cancel.run(row.id, row.status, row.expires_at, row.lease_id, row.lease_until);
    }
    cleanupCursor = rows.length === 64 ? rows.at(-1).id : '';
  }
  function claim(now = Date.now()) {
    return transaction(() => {
      cleanup(now);
      const row = db
        .prepare(
          "SELECT * FROM admin_email_jobs WHERE expires_at>? AND ((status='pending' AND next_at<=?) OR (status='sending' AND lease_until<=?)) ORDER BY next_at,id LIMIT 1",
        )
        .get(now, now, now);
      if (!row) return null;
      if (row.attempts >= 5) {
        db.prepare(
          "UPDATE admin_email_jobs SET status='failed',lease_id=NULL,lease_until=0 WHERE id=?",
        ).run(row.id);
        return null;
      }
      const leaseId = id();
      db.prepare(
        "UPDATE admin_email_jobs SET status='sending',attempts=attempts+1,lease_id=?,lease_until=? WHERE id=?",
      ).run(leaseId, now + 120000, row.id);
      return {
        id: row.id,
        kind: row.kind,
        leaseId,
        attempts: row.attempts + 1,
        expiresAt: row.expires_at,
        payload: open(row.value),
      };
    });
  }
  function allowed(job, now = Date.now()) {
    if (job.kind === 'notification-test') {
      const { actorId, accountId, email } = job.payload || {};
      if (
        job.expiresAt <= now ||
        typeof accountId !== 'string' ||
        !accountId ||
        actorId !== accountId ||
        typeof email !== 'string'
      )
        return false;
      const row = db
        .prepare("SELECT value FROM accounts WHERE id=? AND status='active'")
        .get(accountId);
      return Boolean(row && open(row.value).email === email);
    }
    const actor = db
      .prepare("SELECT global_admin FROM accounts WHERE id=? AND status='active'")
      .get(job.payload.actorId);
    if (!actor?.global_admin || job.expiresAt <= now) return false;
    if (!['email-recovery', 'support-reply'].includes(job.kind)) return true;
    const account = db
      .prepare("SELECT value FROM accounts WHERE id=? AND status='active'")
      .get(job.payload.accountId);
    if (!account) return false;
    const value = open(account.value);
    if (job.kind === 'support-reply') return value.email === job.payload.email;
    const recovery = db
      .prepare('SELECT * FROM admin_email_recoveries WHERE id=?')
      .get(job.payload.recoveryId);
    if (!recovery || recovery.used_at || recovery.expires_at <= now) return false;
    const details = open(recovery.value);
    const revision =
      db
        .prepare(
          "SELECT revision FROM admin_resource_versions WHERE kind='account' AND resource_id=?",
        )
        .get(recovery.account_id)?.revision || 0;
    return details.previousEmail === value.email && details.revision === revision;
  }
  function finish(job, status, nextAt = Date.now()) {
    return (
      db
        .prepare(
          "UPDATE admin_email_jobs SET status=?,next_at=?,lease_id=NULL,lease_until=0 WHERE id=? AND lease_id=? AND status='sending'",
        )
        .run(status, nextAt, job.id, job.leaseId).changes === 1
    );
  }
  function statuses(operationId) {
    return db
      .prepare('SELECT kind,status,attempts FROM admin_email_jobs WHERE operation_id=?')
      .all(operationId);
  }
  return { enqueue, claim, allowed, finish, statuses };
}
function createAdminEmailRuntime({
  queue,
  sendMail = null,
  clock = Date.now,
  canRun = () => true,
  runBackgroundWork = (callback) => callback(),
}) {
  let busy = false,
    timer = null,
    epoch = 0;
  async function tick() {
    if (busy || !sendMail || !canRun()) return;
    busy = true;
    const generation = epoch;
    try {
      for (let i = 0; i < 5 && generation === epoch && canRun(); i++) {
        const active = () => generation === epoch && canRun();
        const job = await runBackgroundWork(
          () => {
            if (active()) return queue.claim(clock());
          },
          '',
          active,
        );
        if (!job) break;
        if (!queue.allowed(job, clock())) {
          queue.finish(job, 'cancelled', clock());
          continue;
        }
        if (!active()) break;
        try {
          await sendMail(job.payload.email, job.payload.link || '', {
            kind: job.kind,
            message: job.payload.message || '',
            requestId: job.payload.requestId || '',
          });
        } catch {
          if (generation === epoch)
            queue.finish(
              job,
              job.attempts >= 5 ? 'failed' : 'pending',
              clock() + Math.min(3600000, 30000 * 2 ** job.attempts),
            );
          if (generation !== epoch) break;
          continue;
        }
        // A confirmed ACK is not a transport failure if its durable settlement
        // throws. The outer catch retains uncertainty without requeueing it.
        queue.finish(job, 'sent', clock());
        if (generation !== epoch) break;
      }
    } catch {
      // A transient database failure leaves leases durable for a later worker.
    } finally {
      busy = false;
    }
  }
  function start() {
    if (timer || !sendMail) return;
    void tick();
    timer = setInterval(() => {
      void tick();
    }, 20000);
    timer.unref?.();
  }
  function stop() {
    epoch++;
    clearInterval(timer);
    timer = null;
  }
  return {
    start,
    stop,
    tick,
    status: () => ({ configured: Boolean(sendMail), running: Boolean(timer), busy }),
  };
}
module.exports = { createAdminEmailQueue, createAdminEmailRuntime };
