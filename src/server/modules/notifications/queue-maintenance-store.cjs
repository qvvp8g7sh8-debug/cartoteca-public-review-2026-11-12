const DAY = 86400000;
const { queueDomainForTable } = require('../../infrastructure/postgres/queue-domains.cjs');
// Closed identifiers and predicates only. Payloads are neither read nor decrypted.
function createQueueMaintenanceStore(c) {
  const { db } = c;
  const phases = [];
  const recovery = new Map();
  let maxRecovery;
  function batches(rows, work) {
    let changed = 0;
    for (let offset = 0; offset < rows.length; offset += 64)
      changed += work(rows.slice(offset, offset + 64));
    return changed;
  }
  function selected(table, rows, predicate, values, assignment) {
    return batches(
      rows,
      (batch) =>
        db
          .prepare(
            `${assignment ? `UPDATE ${table} SET ${assignment}` : `DELETE FROM ${table}`} WHERE id IN (${batch.map(() => '?').join(',')}) AND ${predicate}`,
          )
          .run(...batch.map((row) => row.id), ...values).changes,
    );
  }
  function statuses(table, rows, assignment, status, guard, argumentsFor) {
    return batches(
      rows,
      (batch) =>
        db
          .prepare(
            `UPDATE ${table} SET status=CASE id ${batch.map(() => 'WHEN ? THEN ?').join(' ')} ELSE status END,${assignment} WHERE ${batch.map(() => `(${guard})`).join(' OR ')}`,
          )
          .run(...batch.flatMap((row) => [row.id, status(row)]), ...batch.flatMap(argumentsFor))
          .changes,
    );
  }
  function phase(table, channel, predicate, parameters, assignment, lagColumn, lagOffset = 0) {
    const select = db.prepare(
      `SELECT id,${lagColumn} due FROM ${table} WHERE ${predicate} ORDER BY ${lagColumn},id LIMIT ?`,
    );
    const mutate = db.prepare(
      `${assignment ? `UPDATE ${table} SET ${assignment}` : `DELETE FROM ${table}`} WHERE id=? AND ${predicate}`,
    );
    phases.push({
      channel,
      queueDomain: queueDomainForTable(table),
      hasWork: (now) => Boolean(select.get(...parameters(now), 1)),
      run(now, limit) {
        const values = parameters(now),
          rows = select.all(...values, limit);
        let changed = 0;
        if (db.dialect === 'postgres')
          changed = selected(table, rows, predicate, values, assignment);
        else for (const row of rows) changed += mutate.run(row.id, ...values).changes;
        return {
          examined: rows.length,
          changed,
          lagMs: rows.length ? Math.max(0, now - lagOffset - rows[0].due) : 0,
        };
      },
    });
  }
  for (const channel of ['telegram', 'max']) {
    const table = 'notification_channel_jobs';
    phase(
      table,
      channel,
      "status='sending' AND channel=? AND lease_until<=?",
      (now) => [channel, now],
      "status='uncertain',lease_until=0",
      'lease_until',
    );
    const sending = phases.at(-1);
    const select = db.prepare(
      "SELECT id,lease_until due,expires_at FROM notification_channel_jobs WHERE status='reserved' AND channel=? AND lease_until<=? ORDER BY lease_until,id LIMIT ?",
    );
    const update = db.prepare(
      "UPDATE notification_channel_jobs SET status=?,lease_until=0 WHERE id=? AND status='reserved' AND channel=? AND lease_until<=?",
    );
    phases.push({
      channel,
      queueDomain: queueDomainForTable(table),
      hasWork: (now) => Boolean(select.get(channel, now, 1)),
      run(now, limit) {
        const rows = select.all(channel, now, limit);
        let changed = 0;
        if (db.dialect === 'postgres')
          changed = statuses(
            table,
            rows,
            'lease_until=0',
            (row) => (row.expires_at <= now ? 'cancelled' : 'pending'),
            "id=? AND status='reserved' AND channel=? AND lease_until<=?",
            (row) => [row.id, channel, now],
          );
        else
          for (const row of rows)
            changed += update.run(
              row.expires_at <= now ? 'cancelled' : 'pending',
              row.id,
              channel,
              now,
            ).changes;
        return {
          examined: rows.length,
          changed,
          lagMs: rows.length ? Math.max(0, now - rows[0].due) : 0,
        };
      },
    });
    recovery.set(channel, [sending, phases.at(-1)]);
    phase(
      table,
      channel,
      "status='pending' AND channel=? AND expires_at<=?",
      (now) => [channel, now],
      "status='cancelled'",
      'expires_at',
    );
  }
  for (const [channel, table] of [
    ['telegram', 'staff_notification_jobs'],
    ['max', 'staff_max_jobs'],
    ['push', 'staff_push_jobs'],
  ]) {
    if (channel === 'max') {
      phase(
        table,
        channel,
        "status='sending' AND lease_until<=?",
        (now) => [now],
        "status='uncertain',lease_id=NULL,lease_until=0",
        'lease_until',
      );
      maxRecovery = phases.at(-1);
    }
    if (channel === 'max') {
      // Do not filter lease_until in this range scan: an unreclaimed prefix of
      // unknown sends could otherwise make LIMIT scan the whole expired queue.
      const expiry = db.prepare(
        "SELECT id,expires_at due,status,lease_until FROM staff_max_jobs WHERE status IN ('pending','sending') AND expires_at<=? ORDER BY expires_at,id LIMIT ?",
      );
      const expire = db.prepare(
        'UPDATE staff_max_jobs SET status=?,lease_id=NULL,lease_until=0 WHERE id=? AND status=? AND lease_until=? AND expires_at<=?',
      );
      phases.push({
        channel,
        queueDomain: queueDomainForTable(table),
        hasWork: (now) => Boolean(expiry.get(now, 1)),
        run(now, limit) {
          const rows = expiry.all(now, limit);
          let changed = 0;
          if (db.dialect === 'postgres')
            changed = statuses(
              table,
              rows,
              'lease_id=NULL,lease_until=0',
              (row) =>
                row.status === 'sending' && row.lease_until <= now ? 'uncertain' : 'cancelled',
              'id=? AND status=? AND lease_until=? AND expires_at<=?',
              (row) => [row.id, row.status, row.lease_until, now],
            );
          else
            for (const row of rows)
              changed += expire.run(
                row.status === 'sending' && row.lease_until <= now ? 'uncertain' : 'cancelled',
                row.id,
                row.status,
                row.lease_until,
                now,
              ).changes;
          return {
            examined: rows.length,
            changed,
            lagMs: rows.length ? Math.max(0, now - rows[0].due) : 0,
          };
        },
      });
    } else
      phase(
        table,
        channel,
        "status IN ('pending','sending') AND expires_at<=?",
        (now) => [now],
        "status='cancelled',lease_id=NULL,lease_until=0",
        'expires_at',
      );
    phase(
      table,
      channel,
      "status IN ('sent','failed','cancelled'" +
        (channel === 'max' ? ",'uncertain'" : '') +
        ') AND expires_at<?',
      (now) => [now - 7 * DAY],
      null,
      'expires_at',
      7 * DAY,
    );
    if (channel !== 'push') {
      const prefix = `staff-selftest-v1:${channel}:`;
      const page = db.prepare(
        'SELECT key FROM telegram_runtime WHERE key>=? AND key<? AND key>? ORDER BY key LIMIT ?',
      );
      const live = db.prepare(
        `SELECT 1 FROM ${table} WHERE id=? AND status IN ('pending','sending') AND expires_at>?`,
      );
      const remove = db.prepare('DELETE FROM telegram_runtime WHERE key=?');
      let cursor = '';
      phases.push({
        channel,
        queueDomain: 'staff-' + channel,
        hasWork: () => Boolean(page.get(prefix, prefix + '\uffff', cursor, 1)) || Boolean(cursor),
        run(now, limit) {
          const rows = page.all(prefix, prefix + '\uffff', cursor, limit);
          let changed = 0;
          for (const row of rows)
            if (!live.get(row.key.slice(prefix.length), now))
              changed += remove.run(row.key).changes;
          cursor = rows.length === limit ? rows.at(-1).key : '';
          return { examined: rows.length, changed, lagMs: 0 };
        },
      });
    }
  }
  // On-demand recovery is bounded and never turns an unknown send into a resend.
  function recoverClient(now, channels, limit = 8) {
    let remaining = limit;
    let changed = 0;
    for (const channel of channels)
      for (const entry of recovery.get(channel)) {
        if (!remaining) break;
        const result = entry.run(now, remaining);
        remaining -= result.examined;
        changed += result.changed;
      }
    return { examined: limit - remaining, changed };
  }
  function recoverStaffMax(now, limit = 8) {
    return maxRecovery.run(now, limit);
  }
  return { phases, recoverClient, recoverStaffMax };
}
module.exports = { createQueueMaintenanceStore };
