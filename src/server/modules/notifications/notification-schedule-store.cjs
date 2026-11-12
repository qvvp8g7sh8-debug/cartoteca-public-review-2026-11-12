const { createNotificationIntents } = require('./notification-schedule-intents.cjs');
function createNotificationScheduleStore(c, { enabled = false, startupReconcile = true } = {}) {
  if (typeof startupReconcile !== 'boolean') throw Error('Invalid schedule startup reconciliation');
  const { db, seal, open, id, transaction } = c;
  if (![18, 19, 20].includes(db.prepare('PRAGMA user_version').get().user_version))
    throw Error('Notification schedule requires separately prepared schema 18.');
  function scopedTransaction(callback, organizationId) {
    if (db.isTransaction) {
      const value = callback();
      if (value && typeof value.then === 'function')
        throw Error('Asynchronous schedule transaction is forbidden.');
      return value;
    }
    return c.organizationQueueTransaction && organizationId
      ? c.organizationQueueTransaction(callback, { queueDomain: 'schedule', organizationId })
      : transaction(callback);
  }
  const write = () => {
    if (!db.isTransaction) throw Error('Notification schedule requires platform transaction.');
  };
  const mark = db.prepare(`INSERT INTO notification_schedule_dirty(kind,organization_id,subject)
    VALUES(?,?,?) ON CONFLICT(kind,organization_id,subject) DO UPDATE SET version=version+1,cursor=''`);
  function markDirty(org, kind = 'client', subject = '') {
    write();
    if (
      !['client', 'workday'].includes(kind) ||
      typeof org !== 'string' ||
      typeof subject !== 'string'
    )
      throw Error('Invalid notification schedule scope.');
    mark.run(kind, org, subject);
  }
  const nextDirty = db.prepare(`SELECT * FROM notification_schedule_dirty WHERE kind=?
    ORDER BY organization_id,subject LIMIT 1`);
  const dirtyAfter = db.prepare(`SELECT * FROM notification_schedule_dirty WHERE kind=?
    AND (organization_id>? OR (organization_id=? AND subject>?)) ORDER BY organization_id,subject LIMIT 1`);
  const dirtyCurrent = db.prepare(
    'SELECT version,cursor FROM notification_schedule_dirty WHERE kind=? AND organization_id=? AND subject=?',
  );
  const subjectDirty = db.prepare(
    'SELECT * FROM notification_schedule_dirty WHERE kind=? AND organization_id=? AND subject=?',
  );
  function dirtyMatches(row) {
    const current = dirtyCurrent.get(row.kind, row.organization_id, row.subject);
    return current?.version === row.version && current.cursor === row.cursor;
  }
  const removeTasks = db.prepare(
    'DELETE FROM notification_schedule WHERE kind=? AND organization_id=? AND subject=?',
  );
  const insertTask = db.prepare('INSERT INTO notification_schedule VALUES(?,?,?,?,?,?,?,?)');
  function replaceTasks(kind, org, subject, tasks) {
    write();
    removeTasks.run(kind, org, subject);
    for (const task of tasks) {
      if (
        !Number.isSafeInteger(task.dueAt) ||
        !Number.isSafeInteger(task.expiresAt) ||
        task.dueAt >= task.expiresAt
      )
        throw Error('Invalid notification schedule time.');
      insertTask.run(
        kind,
        org,
        subject,
        task.entity,
        seal(task.value),
        task.dueAt,
        task.expiresAt,
        id(),
      );
    }
  }
  function finishDirty(row, cursor = null) {
    write();
    if (!dirtyMatches(row)) return false;
    if (cursor !== null)
      db.prepare(
        'UPDATE notification_schedule_dirty SET cursor=? WHERE kind=? AND organization_id=? AND subject=?',
      ).run(cursor, row.kind, row.organization_id, row.subject);
    else
      db.prepare(
        'DELETE FROM notification_schedule_dirty WHERE kind=? AND organization_id=? AND subject=?',
      ).run(row.kind, row.organization_id, row.subject);
    return true;
  }
  const subjectPage = db.prepare(`SELECT subject FROM (
    SELECT patient_id subject FROM telegram_links WHERE organization_id=?
    UNION SELECT patient_id subject FROM max_client_links WHERE organization_id=?
    UNION SELECT subject FROM notification_schedule WHERE kind='client' AND organization_id=?)
    WHERE subject>? ORDER BY subject LIMIT ?`);
  function clientSubjects(org, cursor = '', limit = 25) {
    return subjectPage.all(org, org, org, cursor, limit).map((row) => row.subject);
  }
  const workdayPage = db.prepare(`SELECT subject FROM (
    SELECT id subject FROM staff_push_devices WHERE organization_id=?
    UNION SELECT subject FROM notification_schedule WHERE kind='workday' AND organization_id=?)
    WHERE subject>? ORDER BY subject LIMIT ?`);
  const linked = db.prepare(`SELECT 1 FROM telegram_links WHERE organization_id=? AND patient_id=?
    UNION SELECT 1 FROM max_client_links WHERE organization_id=? AND patient_id=? LIMIT 1`);
  const due = db.prepare(
    'SELECT * FROM notification_schedule WHERE kind=? AND due_at<=? ORDER BY due_at,organization_id,subject,entity LIMIT ?',
  );
  const update = db.prepare(
    `UPDATE notification_schedule SET due_at=? WHERE kind=? AND organization_id=? AND subject=? AND entity=? AND version=?`,
  );
  const remove = db.prepare(
    'DELETE FROM notification_schedule WHERE kind=? AND organization_id=? AND subject=? AND entity=? AND version=?',
  );
  const taskVersion = db.prepare(
    'SELECT version FROM notification_schedule WHERE kind=? AND organization_id=? AND subject=? AND entity=?',
  );
  function finishTask(row, nextAt = null, onEntered = () => {}) {
    return scopedTransaction(() => {
      onEntered();
      const key = [row.kind, row.organization_id, row.subject, row.entity, row.version];
      return Boolean(
        nextAt === null ? remove.run(...key).changes : update.run(nextAt, ...key).changes,
      );
    }, row.organization_id);
  }
  if (enabled && startupReconcile) {
    // Activation/restart reconciles authoritative bindings once, including old
    // plans whose bindings disappeared while the legacy mode was active. This
    // closes a disabled-mode cabinet/platform commit gap without recurring scans
    // or resetting delivery receipts, queue jobs, leases or retry deadlines.
    // Passive command owners retain dirty writes/intents but do not repeat the
    // active scheduler owner's complete startup reconciliation.
    transaction(() =>
      db.exec(`INSERT INTO notification_schedule_dirty(kind,organization_id,subject)
        SELECT 'client',organization_id,'' FROM telegram_links
        UNION SELECT 'client',organization_id,'' FROM max_client_links
        UNION SELECT 'workday',organization_id,'' FROM staff_push_devices
        UNION SELECT kind,organization_id,'' FROM notification_schedule WHERE 1
        ON CONFLICT(kind,organization_id,subject) DO UPDATE SET version=version+1,cursor=''`),
    );
  }
  const excludedOrganizations = Array(8).fill('?').join(',');
  const scopedDirty =
    c.organizationQueueTransaction &&
    db.prepare(
      `SELECT * FROM notification_schedule_dirty WHERE kind=? AND organization_id NOT IN (${excludedOrganizations}) AND organization_id>? ORDER BY organization_id,subject LIMIT 1`,
    );
  const scopedDue =
    c.organizationQueueTransaction &&
    db.prepare(
      `SELECT * FROM notification_schedule WHERE kind=? AND due_at<=? AND organization_id NOT IN (${excludedOrganizations}) AND organization_id>? ORDER BY organization_id,due_at,subject,entity LIMIT 1`,
    );
  const excluded = (values) => [...values, ...Array(8 - values.length).fill('')];
  // The cursor contains one organization only: a hot cabinet's backlog cannot
  // retain the iterator until every subject/task has been consumed. Within the
  // selected cabinet the query always reselects its fresh oldest ready row.
  function nextScopedDirty(kind, cursor, skipped) {
    const omitted = excluded(skipped);
    return (
      scopedDirty.get(kind, ...omitted, cursor?.organization_id || '') ||
      scopedDirty.get(kind, ...omitted, '')
    );
  }
  function nextScopedDue(kind, now, cursor, skipped) {
    const omitted = excluded(skipped);
    const row =
      scopedDue.get(kind, now, ...omitted, cursor?.organization_id || '') ||
      scopedDue.get(kind, now, ...omitted, '');
    return row ? { ...row, decoded: open(row.value) } : null;
  }
  return {
    enabled,
    transaction: scopedTransaction,
    nextScopedDirty: scopedDirty ? nextScopedDirty : null,
    nextScopedDue: scopedDue ? nextScopedDue : null,
    markDirty,
    replaceTasks,
    dirtyMatches,
    finishDirty,
    finishTask,
    nextDirty: (kind, cursor = null) =>
      (cursor
        ? dirtyAfter.get(kind, cursor.organization_id, cursor.organization_id, cursor.subject)
        : null) || nextDirty.get(kind),
    clientSubjects,
    subjectDirty: (kind, org, subject) => subjectDirty.get(kind, org, subject),
    workdaySubjects: (org, cursor = '', limit = 25) =>
      workdayPage.all(org, org, cursor, limit).map((row) => row.subject),
    taskMatches: (row) =>
      taskVersion.get(row.kind, row.organization_id, row.subject, row.entity)?.version ===
      row.version,
    linked: (org, patient) => Boolean(linked.get(org, patient, org, patient)),
    due: (kind, now, limit = 50) =>
      due.all(kind, now, limit).map((row) => ({ ...row, decoded: open(row.value) })),
    ...createNotificationIntents(c, markDirty),
  };
}
module.exports = { createNotificationScheduleStore };
