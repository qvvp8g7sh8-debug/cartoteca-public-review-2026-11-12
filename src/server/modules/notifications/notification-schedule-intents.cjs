const { cleanBusy } = require('./queue-org134.cjs');
// Separate durable intent precedes platform -> cabinet mutation. The final fresh
// assert runs while platform lock is held, directly before cabinet COMMIT.
function createNotificationIntents(
  {
    db,
    transaction,
    asyncTransaction,
    compoundTransaction,
    asyncCompoundTransaction,
    organizationQueueTransaction,
    id,
    seal,
    open,
    fail,
  },
  markDirty,
) {
  const read = db.prepare('SELECT * FROM notification_schedule_intents WHERE id=?');
  const assertLock = () => {
    if (!db.isTransaction) throw Error('Notification intent requires platform transaction.');
  };
  function beginIntent(org, operation = '', now = Date.now(), run = transaction) {
    if (db.isTransaction)
      throw Error('Create durable notification intent before mutation transaction.');
    const intent = { id: id(), organizationId: org, leaseUntil: now + 120000 };
    const admission =
      run === transaction && compoundTransaction
        ? (callback) =>
            compoundTransaction(callback, {
              operation: 'intent',
              organizationId: org,
              cabinetStoreId: null,
            })
        : run;
    const result = admission(() =>
      db
        .prepare('INSERT INTO notification_schedule_intents VALUES(?,?,?,?)')
        .run(
          intent.id,
          org,
          intent.leaseUntil,
          seal({ operation: String(operation).slice(0, 200) }),
        ),
    );
    return result && typeof result.then === 'function' ? result.then(() => intent) : intent;
  }
  function matches(row, intent) {
    return (
      row && row.organization_id === intent.organizationId && row.lease_until === intent.leaseUntil
    );
  }
  function assertIntent(intent, now = Date.now()) {
    assertLock();
    if (!matches(read.get(intent.id), intent) || intent.leaseUntil <= now)
      throw fail(409, 'Время сохранения истекло. Повторите сохранение.');
  }
  function ackIntent(intent) {
    assertLock();
    if (!matches(read.get(intent.id), intent)) throw Error('Notification mutation intent lost.');
    db.prepare('DELETE FROM notification_schedule_intents WHERE id=? AND organization_id=?').run(
      intent.id,
      intent.organizationId,
    );
  }
  let recoveryCursor = { lease: Number.MIN_SAFE_INTEGER, id: '' };
  function recoverExpired(visit, now = Date.now(), limit = 10) {
    const scoped = Boolean(organizationQueueTransaction);
    const query = db.prepare(
      scoped
        ? 'SELECT * FROM notification_schedule_intents WHERE lease_until<=? AND (lease_until>? OR (lease_until=? AND id>?)) ORDER BY lease_until,id LIMIT ?'
        : 'SELECT * FROM notification_schedule_intents WHERE lease_until<=? ORDER BY lease_until,id LIMIT ?',
    );
    const page = () =>
      scoped
        ? query.all(now, recoveryCursor.lease, recoveryCursor.lease, recoveryCursor.id, limit)
        : query.all(now, limit);
    let rows = page();
    if (scoped && !rows.length && recoveryCursor.id) {
      recoveryCursor = { lease: Number.MIN_SAFE_INTEGER, id: '' };
      rows = page();
    }
    for (const row of rows) {
      if (scoped) recoveryCursor = { lease: row.lease_until, id: row.id };
      let entered = false;
      try {
        (organizationQueueTransaction
          ? (callback) =>
              organizationQueueTransaction(callback, {
                queueDomain: 'schedule',
                organizationId: row.organization_id,
              })
          : transaction)(() => {
          entered = true;
          const current = read.get(row.id);
          if (
            !current ||
            current.organization_id !== row.organization_id ||
            current.lease_until !== row.lease_until ||
            current.lease_until > now
          )
            return;
          const result = visit(row.organization_id, open(current.value));
          if (result && typeof result.then === 'function')
            throw Error('Asynchronous intent recovery is forbidden.');
          markDirty(row.organization_id);
          db.prepare(
            'DELETE FROM notification_schedule_intents WHERE id=? AND organization_id=? AND lease_until=?',
          ).run(row.id, row.organization_id, row.lease_until);
        });
      } catch (error) {
        if (!scoped || entered || !cleanBusy(error)) throw error;
      }
    }
    return rows.length;
  }

  return {
    beginIntent,
    beginIntentAsync: (org, operation, options) =>
      beginIntent(org, operation, Date.now(), (callback) =>
        asyncCompoundTransaction
          ? asyncCompoundTransaction(
              callback,
              { operation: 'intent', organizationId: org, cabinetStoreId: null },
              options,
            )
          : asyncTransaction
            ? asyncTransaction(callback, options)
            : transaction(callback),
      ),
    assertIntent,
    ackIntent,
    recoverExpired,
  };
}
module.exports = { createNotificationIntents };
