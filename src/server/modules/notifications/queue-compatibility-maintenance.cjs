const {
  compatibilityStatements,
} = require('../../infrastructure/postgres/queue-org-statements134.cjs');
// Existing schema indexes stay untouched. Compatibility mode walks a bounded
// primary-key metadata page, never decrypting a payload or sweeping all rows.
const policies = {
  telegram_jobs: { legacy: true },
  staff_push_jobs: { retention: ['sent', 'failed', 'cancelled'] },
  staff_notification_jobs: { retention: ['sent', 'failed', 'cancelled'] },
  staff_max_jobs: { retention: ['sent', 'failed', 'cancelled', 'uncertain'], uncertain: true },
  notification_channel_jobs: { client: true, uncertain: true },
};
function createQueueCompatibilityMaintenance({ db }, table, channels = [], limit = 64) {
  const policy = Object.hasOwn(policies, table) ? policies[table] : null;
  if (
    !policy ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 64 ||
    !Array.isArray(channels) ||
    channels.some((channel) => !['telegram', 'max'].includes(channel))
  )
    throw Error('Invalid queue compatibility maintenance.');
  const withoutLeaseId = policy.client || policy.legacy;
  const page = db.prepare(
    `SELECT id,status,expires_at,lease_until,${withoutLeaseId ? 'NULL lease_id' : 'lease_id'}${policy.client ? ',channel' : ''} FROM ${table} WHERE id>? ORDER BY id LIMIT ?`,
  );
  let orgPage;
  const prepareOrgPage = () =>
    (orgPage ||= db.prepare(
      `SELECT id,status,expires_at,lease_until,${withoutLeaseId ? 'NULL lease_id' : 'lease_id'}${policy.client ? ',channel' : ''} FROM ${table} WHERE organization_id=? AND id>? ORDER BY id LIMIT ?`,
    ));
  const orgCursors = new Map();
  function cursorFor(org) {
    if (!org) return { cursor, recoveryCursor };
    const state = orgCursors.get(org) || { cursor: '', recoveryCursor: 0 };
    orgCursors.delete(org);
    if (orgCursors.size >= 64) orgCursors.delete(orgCursors.keys().next().value);
    orgCursors.set(org, state);
    return state;
  }
  const update = db.prepare(
    `UPDATE ${table} SET status=?,lease_until=0${withoutLeaseId ? '' : ',lease_id=NULL'} WHERE id=? AND status=? AND expires_at=? AND lease_until=?${withoutLeaseId ? '' : ' AND lease_id IS ?'}`,
  );
  const remove =
    policy.retention && db.prepare(`DELETE FROM ${table} WHERE id=? AND status=? AND expires_at=?`);
  const scope = policy.client ? ` AND channel IN (${channels.map(() => '?').join(',')})` : '';
  if (policy.client && !channels.length) throw Error('Client recovery needs channels.');
  const stale = policy.uncertain
    ? ['sending', ...(policy.client ? ['reserved'] : [])].map((status) => ({
        status,
        // Existing (status,next_at) bounds candidate order. A native SELECT cannot
        // be preempted; this is a finite row/write budget, not a hard SQL-time cap.
        select: db.prepare(
          `SELECT id,status,expires_at,lease_until,${withoutLeaseId ? 'NULL lease_id' : 'lease_id'},next_at FROM ${table} WHERE status='${status}' AND lease_until<=?${scope} ORDER BY next_at LIMIT ?`,
        ),
      }))
    : [];
  let scopedStale;
  function staleFor(org) {
    if (!org) return stale;
    return (scopedStale ||= stale.map((entry) => ({
      status: entry.status,
      select: db.prepare(
        `SELECT id,status,expires_at,lease_until,${withoutLeaseId ? 'NULL lease_id' : 'lease_id'},next_at FROM ${table} WHERE organization_id=? AND status='${entry.status}' AND lease_until<=?${scope} ORDER BY next_at LIMIT ?`,
      ),
    })));
  }
  let cursor = '',
    recoveryCursor = 0;
  const allowed = (row) => !policy.client || channels.includes(row.channel);
  function change(row, status) {
    return update.run(
      status,
      row.id,
      row.status,
      row.expires_at,
      row.lease_until,
      ...(withoutLeaseId ? [] : [row.lease_id]),
    ).changes;
  }
  function changeRows(rows, org = '') {
    if (db.dialect !== 'postgres')
      return rows.reduce((changed, { row, status }) => changed + change(row, status), 0);
    let changed = 0;
    for (let offset = 0; offset < rows.length; offset += 64) {
      const batch = rows.slice(offset, offset + 64);
      const guards = batch.map(
        () =>
          `(id=? AND status=? AND expires_at=? AND lease_until=?${withoutLeaseId ? '' : ' AND lease_id IS ?'})`,
      );
      changed += db
        .prepare(
          org
            ? compatibilityStatements(table, batch.length).update.sql
            : `UPDATE ${table} SET status=CASE id ${batch.map(() => 'WHEN ? THEN ?').join(' ')} ELSE status END,lease_until=0${withoutLeaseId ? '' : ',lease_id=NULL'} WHERE ${guards.join(' OR ')}`,
        )
        .run(
          ...batch.flatMap(({ row, status }) => [row.id, status]),
          ...(org ? [org] : []),
          ...batch.flatMap(({ row }) => [
            row.id,
            row.status,
            row.expires_at,
            row.lease_until,
            ...(withoutLeaseId ? [] : [row.lease_id]),
          ]),
        ).changes;
    }
    return changed;
  }
  function removeRows(rows, org = '') {
    if (!rows.length) return 0;
    if (org && ['staff_notification_jobs', 'staff_max_jobs'].includes(table)) {
      const prefix = 'staff-selftest-v1:' + (table === 'staff_max_jobs' ? 'max' : 'telegram') + ':';
      db.prepare(compatibilityStatements(table, rows.length).markers.sql).run(
        ...rows.map((row) => prefix + row.id),
        org,
      );
    }
    return db
      .prepare(
        org
          ? compatibilityStatements(table, rows.length).remove.sql
          : `DELETE FROM ${table} WHERE ${rows.map(() => '(id=? AND status=? AND expires_at=?)').join(' OR ')}`,
      )
      .run(...(org ? [org] : []), ...rows.flatMap((row) => [row.id, row.status, row.expires_at]))
      .changes;
  }
  function nextStatus(row, now) {
    if (policy.uncertain && row.status === 'sending' && row.lease_until <= now) return 'uncertain';
    if (policy.client && row.status === 'reserved' && row.lease_until <= now)
      return row.expires_at <= now ? 'cancelled' : 'pending';
    if (row.expires_at <= now && ['pending', 'sending'].includes(row.status)) return 'cancelled';
    return row.status;
  }
  function sweep(now, org = '') {
    if (!db.isTransaction || !Number.isSafeInteger(now))
      throw Error('Queue maintenance needs a transaction and time.');
    const state = cursorFor(org);
    const rows = org ? prepareOrgPage().all(org, state.cursor, limit) : page.all(cursor, limit);
    let changed = 0;
    const updates = [],
      removals = [];
    for (const row of rows) {
      if (!allowed(row)) continue;
      const status = nextStatus(row, now);
      if (status !== row.status) {
        if (db.dialect === 'postgres') updates.push({ row, status });
        else changed += change(row, status);
      } else if (
        remove &&
        row.expires_at < now - 7 * 86400000 &&
        policy.retention.includes(row.status)
      )
        if (db.dialect === 'postgres') removals.push(row);
        else changed += remove.run(row.id, row.status, row.expires_at).changes;
    }
    // The selected metadata page is the write set. Each original CAS remains in
    // the SQL predicate; a replacement lease or status is never overwritten.
    changed += changeRows(updates, org) + removeRows(removals, org);
    state.cursor = rows.length === limit ? rows.at(-1).id : '';
    if (!org) cursor = state.cursor;
    return { examined: rows.length, changed };
  }
  function recover(now, limit = 8, org = '') {
    if (!db.isTransaction) throw Error('Queue recovery requires platform transaction.');
    let examined = 0,
      changed = 0;
    const updates = [];
    const state = cursorFor(org),
      selectedStale = staleFor(org);
    for (let visit = 0; visit < selectedStale.length && examined < limit; visit++) {
      const entry = selectedStale[state.recoveryCursor];
      state.recoveryCursor = (state.recoveryCursor + 1) % selectedStale.length;
      for (const row of entry.select.all(
        ...(org ? [org] : []),
        now,
        ...channels,
        limit - examined,
      )) {
        examined++;
        if (db.dialect === 'postgres') updates.push({ row, status: nextStatus(row, now) });
        else changed += change(row, nextStatus(row, now));
      }
    }
    changed += changeRows(updates, org);
    if (!org) recoveryCursor = state.recoveryCursor;
    return { examined, changed };
  }
  function blocks(now, nextAt, org = '') {
    // An earlier unstarted reservation may not be overtaken while its bounded
    // recovery continues on the next turn. Unknown sends never become retries.
    return staleFor(org).some(
      (entry) =>
        entry.status === 'reserved' &&
        entry.select.get(...(org ? [org] : []), now, ...channels, 1)?.next_at <= nextAt,
    );
  }
  function hasRows() {
    if (page.get(cursor, 1)) return true;
    cursor = '';
    return Boolean(page.get(cursor, 1));
  }
  return { sweep, recover, blocks, hasRows };
}
module.exports = { createQueueCompatibilityMaintenance };
