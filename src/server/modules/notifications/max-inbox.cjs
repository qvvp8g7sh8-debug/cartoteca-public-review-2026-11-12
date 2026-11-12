const crypto = require('node:crypto');
const { fail } = require('../../../shared/errors.cjs');
const { maxId } = require('./max-adapter.cjs');
const { LEASE_MS } = require('./max-runtime-lease.cjs');

// Minimal normalized events only, never provider secrets, names or message text.
function createMaxInbox(context) {
  const { db, seal, open, transaction, queueTransaction, limitKey } = context;
  if (![15, 16, 17, 18, 19, 20].includes(db.prepare('PRAGMA user_version').get().user_version))
    throw Error('MAX inbox requires separately prepared schema 15.');
  const botHash = (bot) => limitKey('max-inbox-bot', maxId(bot));
  const decode = (row) => (row ? { ...row, decoded: open(row.value) } : null);
  const inboxTransaction = (work) =>
    queueTransaction ? queueTransaction(work, 'max-inbox') : transaction(work);
  function acquire(bot, owner, now) {
    return inboxTransaction(() =>
      Boolean(
        db
          .prepare(
            `INSERT INTO max_runtime_leases VALUES(?,?,?)
      ON CONFLICT(bot_hash) DO UPDATE SET owner=excluded.owner,lease_until=excluded.lease_until
      WHERE max_runtime_leases.owner=excluded.owner OR max_runtime_leases.lease_until<=?`,
          )
          .run(botHash(bot), owner, now + LEASE_MS, now).changes,
      ),
    );
  }
  function renew(bot, owner, expectedUntil, now) {
    return inboxTransaction(() =>
      Boolean(
        db
          .prepare(
            `UPDATE max_runtime_leases SET lease_until=?
       WHERE bot_hash=? AND owner=? AND lease_until=? AND lease_until>?`,
          )
          .run(now + LEASE_MS, botHash(bot), owner, expectedUntil, now).changes,
      ),
    );
  }
  function isCurrent(bot, owner, expectedUntil, now) {
    const row = db
      .prepare('SELECT owner,lease_until FROM max_runtime_leases WHERE bot_hash=?')
      .get(botHash(bot));
    return Boolean(
      row && row.owner === owner && row.lease_until === expectedUntil && row.lease_until > now,
    );
  }
  function release(bot, owner) {
    return inboxTransaction(() =>
      db
        .prepare('DELETE FROM max_runtime_leases WHERE bot_hash=? AND owner=?')
        .run(botHash(bot), owner),
    );
  }
  function hasPendingWork(bot, now) {
    // A negative hint only. Positive work is reread under the original claim TX.
    return Boolean(
      db
        .prepare(
          `SELECT 1 FROM max_event_inbox WHERE bot_hash=? AND
       ((status='pending' AND next_at<=?) OR (status='processing' AND lease_until<=?)) LIMIT 1`,
        )
        .get(botHash(bot), now, now),
    );
  }
  function accept(bot, event, now) {
    const serialized = JSON.stringify(event);
    const key =
      event.update_type === 'message_callback'
        ? [maxId(bot), event.update_type, event.callback.callback_id]
        : [maxId(bot), event.update_type, event.timestamp, event.user.user_id, event.payload || ''];
    const eventHash = limitKey('max-inbox-event', JSON.stringify(key));
    const contentHash = limitKey('max-inbox-content', serialized);
    return transaction(() => {
      db.prepare(
        "DELETE FROM max_event_inbox WHERE expires_at<=? AND status IN ('done','failed')",
      ).run(now);
      const prior = decode(
        db.prepare('SELECT * FROM max_event_inbox WHERE event_hash=?').get(eventHash),
      );
      if (prior) {
        if (prior.decoded.contentHash !== contentHash)
          throw fail(409, 'Содержимое события MAX изменилось.');
        return { repeated: true };
      }
      const botKey = botHash(bot);
      if (
        db.prepare('SELECT count(*) n FROM max_event_inbox').get().n >= 20000 ||
        db
          .prepare(
            "SELECT count(*) n FROM max_event_inbox WHERE status IN ('pending','processing')",
          )
          .get().n >= 5000 ||
        db
          .prepare('SELECT count(*) n FROM max_event_inbox WHERE bot_hash=? AND created_at>?')
          .get(botKey, now - 60000).n >= 600
      )
        throw fail(429, 'Очередь MAX заполнена. Повторите доставку позже.');
      db.prepare(
        "INSERT INTO max_event_inbox(id,bot_hash,event_hash,value,status,created_at,next_at,expires_at) VALUES(?,?,?,?,'pending',?,?,?)",
      ).run(
        crypto.randomUUID(),
        botKey,
        eventHash,
        seal({ event, contentHash }),
        now,
        now,
        now + 7 * 86400000,
      );
      return { repeated: false };
    });
  }
  function claim(bot, now, authority = null) {
    return inboxTransaction(() => {
      if (authority && !isCurrent(bot, authority.owner, authority.until, now)) return null;
      db.prepare(
        "UPDATE max_event_inbox SET status='pending',lease_id=NULL,lease_until=0 WHERE status='processing' AND lease_until<=?",
      ).run(now);
      db.prepare(
        "UPDATE max_event_inbox SET status='failed' WHERE status='pending' AND (expires_at<=? OR attempt>=10)",
      ).run(now);
      const row = db
        .prepare(
          "SELECT * FROM max_event_inbox WHERE bot_hash=? AND status='pending' AND next_at<=? ORDER BY created_at,id LIMIT 1",
        )
        .get(botHash(bot), now);
      if (!row) return null;
      const lease = crypto.randomUUID();
      db.prepare(
        "UPDATE max_event_inbox SET status='processing',attempt=attempt+1,lease_until=?,lease_id=? WHERE id=?",
      ).run(now + 120000, lease, row.id);
      return decode({
        ...row,
        status: 'processing',
        attempt: row.attempt + 1,
        lease_until: now + 120000,
        lease_id: lease,
      });
    });
  }
  function saveResult(row, result) {
    const value = {
      ...row.decoded,
      result: {
        ...(result.callbackId
          ? { callbackId: result.callbackId, notification: result.notification }
          : {}),
      },
    };
    const changed = inboxTransaction(
      () =>
        db
          .prepare(
            "UPDATE max_event_inbox SET value=? WHERE id=? AND status='processing' AND lease_id=?",
          )
          .run(seal(value), row.id, row.lease_id).changes,
    );
    if (changed) row.decoded = value;
    return Boolean(changed);
  }
  function finish(row, status, nextAt = 0) {
    return inboxTransaction(() =>
      Boolean(
        db
          .prepare(
            "UPDATE max_event_inbox SET status=?,next_at=?,lease_until=0,lease_id=NULL WHERE id=? AND status='processing' AND lease_id=?",
          )
          .run(status, nextAt, row.id, row.lease_id).changes,
      ),
    );
  }
  function defer(row, nextAt) {
    return inboxTransaction(() =>
      Boolean(
        db
          .prepare(
            "UPDATE max_event_inbox SET status='pending',attempt=max(0,attempt-1),next_at=?,lease_until=0,lease_id=NULL WHERE id=? AND status='processing' AND lease_id=?",
          )
          .run(nextAt, row.id, row.lease_id).changes,
      ),
    );
  }
  return {
    accept,
    acquire,
    renew,
    isCurrent,
    release,
    hasPendingWork,
    claim,
    saveResult,
    finish,
    defer,
    isOpen: () => db.isOpen !== false,
    ...(db.revisionProfile === 3 && typeof context.entityQueueTransaction === 'function'
      ? require('./max-inbox-entity134.cjs').createMaxInboxEntities(context, botHash)
      : {}),
  };
}
module.exports = { createMaxInbox };
